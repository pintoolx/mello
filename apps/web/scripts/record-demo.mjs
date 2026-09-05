import { spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const { WebSocket } = require("undici");

const baseUrl = process.env.MELLO_QA_URL ?? "http://localhost:4173";
const chromeBin = process.env.CHROME_BIN ?? "google-chrome";
const frameDir = path.join(tmpdir(), "mello-demo-frames");
const publicDir = path.resolve("public/demo");
const debugPort = 9444;
const fps = 15;

await rm(frameDir, { recursive: true, force: true });
await mkdir(frameDir, { recursive: true });
await mkdir(publicDir, { recursive: true });

const chrome = spawn(chromeBin, [
  "--headless=new",
  "--disable-gpu",
  "--no-sandbox",
  "--hide-scrollbars",
  "--disable-background-networking",
  `--remote-debugging-port=${debugPort}`,
  `--user-data-dir=${path.join(frameDir, "chrome-profile")}`,
  "about:blank",
], { stdio: "ignore" });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function getJson(url, init) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(url, init);
      if (response.ok) return response.json();
    } catch {}
    await sleep(100);
  }
  throw new Error(`Unable to connect to Chrome: ${url}`);
}

class Cdp {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.counter = 0;
    this.pending = new Map();
    this.events = new Map();
  }
  async ready() {
    await new Promise((resolve, reject) => {
      this.socket.addEventListener("open", resolve, { once: true });
      this.socket.addEventListener("error", reject, { once: true });
    });
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
        return;
      }
      const listeners = this.events.get(message.method) ?? [];
      this.events.delete(message.method);
      listeners.forEach((resolve) => resolve(message.params));
    });
  }
  send(method, params = {}) {
    const id = ++this.counter;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  once(method) {
    return new Promise((resolve) => {
      const listeners = this.events.get(method) ?? [];
      listeners.push(resolve);
      this.events.set(method, listeners);
    });
  }
  close() { this.socket.close(); }
}

async function evaluate(cdp, expression) {
  const result = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
  return result.result.value;
}

async function clickByText(cdp, text) {
  const clicked = await evaluate(cdp, `(() => { const node = [...document.querySelectorAll("button")].find((item) => item.textContent.includes(${JSON.stringify(text)})); if (!node) return false; node.click(); return true; })()`);
  if (!clicked) throw new Error(`Control not found: ${text}`);
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}`)));
  });
}

let cdp;
let frame = 0;
try {
  const page = await getJson(`http://127.0.0.1:${debugPort}/json/new?about:blank`, { method: "PUT" });
  cdp = new Cdp(page.webSocketDebuggerUrl);
  await cdp.ready();
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
  const loaded = cdp.once("Page.loadEventFired");
  await cdp.send("Page.navigate", { url: `${baseUrl}/app` });
  await loaded;
  await sleep(300);

  async function capture(count, delay = 35) {
    for (let i = 0; i < count; i += 1) {
      const shot = await cdp.send("Page.captureScreenshot", { format: "jpeg", quality: 82, captureBeyondViewport: false, fromSurface: true });
      frame += 1;
      await writeFile(path.join(frameDir, `frame-${String(frame).padStart(4, "0")}.jpg`), Buffer.from(shot.data, "base64"));
      await sleep(delay);
    }
  }

  await clickByText(cdp, "重置 Demo");
  await capture(18);
  await clickByText(cdp, "執行採購任務");
  await capture(34, 55);
  const poster = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false, fromSurface: true });
  await writeFile(path.join(publicDir, "mello-workflow-poster.png"), Buffer.from(poster.data, "base64"));
  await capture(15);

  const maxScroll = await evaluate(cdp, "document.documentElement.scrollHeight - innerHeight");
  for (let i = 1; i <= 38; i += 1) {
    const progress = i / 38;
    const eased = progress < 0.5 ? 2 * progress * progress : 1 - Math.pow(-2 * progress + 2, 2) / 2;
    await evaluate(cdp, `window.scrollTo(0, ${Math.round(maxScroll * eased)})`);
    await capture(1, 28);
  }
  await capture(15);
  await clickByText(cdp, "模擬財務 Agent 重複下單");
  await capture(22);
  for (let i = 1; i <= 30; i += 1) {
    const progress = i / 30;
    const eased = 1 - Math.pow(1 - progress, 3);
    await evaluate(cdp, `window.scrollTo(0, ${Math.round(maxScroll * (1 - eased))})`);
    await capture(1, 24);
  }
  await capture(12);

  await run("ffmpeg", [
    "-y", "-loglevel", "error", "-framerate", String(fps),
    "-i", path.join(frameDir, "frame-%04d.jpg"),
    "-c:v", "libx264", "-preset", "slow", "-crf", "25",
    "-pix_fmt", "yuv420p", "-movflags", "+faststart",
    path.join(publicDir, "mello-workflow.mp4"),
  ]);
  console.log(`Recorded ${frame} frames to ${path.join(publicDir, "mello-workflow.mp4")}`);
} finally {
  cdp?.close();
  chrome.kill("SIGTERM");
}
