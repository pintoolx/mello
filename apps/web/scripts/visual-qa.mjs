import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const { WebSocket } = require("undici");

const baseUrl = process.env.MELLO_QA_URL ?? "http://localhost:4173";
const chromeBin = process.env.CHROME_BIN ?? "google-chrome";
const outputDir = path.join(tmpdir(), "mello-visual-qa");
const debugPort = 9333;

await mkdir(outputDir, { recursive: true });

const chrome = spawn(
  chromeBin,
  [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    "--hide-scrollbars",
    "--disable-background-networking",
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${path.join(outputDir, "chrome-profile")}`,
    "about:blank",
  ],
  { stdio: "ignore" },
);

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

  close() {
    this.socket.close();
  }
}

async function evaluate(cdp, expression) {
  const result = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
  return result.result.value;
}

async function navigate(cdp, url) {
  const loaded = cdp.once("Page.loadEventFired");
  await cdp.send("Page.navigate", { url });
  await loaded;
  await sleep(250);
}

async function clickByText(cdp, text) {
  const clicked = await evaluate(
    cdp,
    `(() => {
      const node = [...document.querySelectorAll("button, a")].find((item) => item.textContent.includes(${JSON.stringify(text)}));
      if (!node) return false;
      node.click();
      return true;
    })()`,
  );
  if (!clicked) throw new Error(`Control not found: ${text}`);
}

async function snapshot(cdp, name) {
  const metrics = await cdp.send("Page.getLayoutMetrics");
  const { width, height } = metrics.cssContentSize;
  const shot = await cdp.send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: true,
    clip: { x: 0, y: 0, width, height, scale: 1 },
  });
  const file = path.join(outputDir, `${name}.png`);
  await writeFile(file, Buffer.from(shot.data, "base64"));
  return { file, width, height };
}

async function inspect(cdp) {
  return evaluate(
    cdp,
    `(() => ({
      title: document.title,
      viewport: { width: innerWidth, height: innerHeight },
      document: { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight },
      horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
      buttons: [...document.querySelectorAll("button")].map((node) => node.textContent.trim()),
      text: document.body.innerText,
    }))()`,
  );
}

async function runViewport(cdp, name, width, height) {
  await cdp.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width < 600 });
  const result = { viewport: { width, height }, checks: {}, screenshots: {} };

  await navigate(cdp, `${baseUrl}/`);
  const home = await inspect(cdp);
  const compactHomeText = home.text.replace(/\s/g, "");
  result.checks.homeNoHorizontalOverflow = !home.horizontalOverflow;
  result.checks.homeCopy = compactHomeText.includes("讓Agent付錢之後，帳還在。") && compactHomeText.includes("x402解決付款。Mello把帳做完。");
  result.checks.homeRecording = await evaluate(cdp, `(() => { const video = document.querySelector("video"); return Boolean(video && video.currentSrc.includes("/demo/mello-workflow.mp4") && video.readyState >= 1); })()`);
  result.screenshots.home = await snapshot(cdp, `${name}-home`);

  await navigate(cdp, `${baseUrl}/app`);
  const initial = await inspect(cdp);
  result.checks.appNoHorizontalOverflow = !initial.horizontalOverflow;
  result.checks.controlsPresent = ["執行採購任務 →", "測試 0.03 預算", "測試 payTo 不符", "凍結所有新付款"].every((label) => initial.buttons.includes(label));
  result.screenshots.initial = await snapshot(cdp, `${name}-app-initial`);

  await clickByText(cdp, "執行採購任務");
  await sleep(1750);
  const matched = await inspect(cdp);
  result.checks.normalMatched = matched.text.includes("MATCHED") && matched.text.includes("SETTLED") && matched.text.includes("ISSUED_TEST");
  result.checks.matchedNoHorizontalOverflow = !matched.horizontalOverflow;
  result.screenshots.matched = await snapshot(cdp, `${name}-app-matched`);

  await clickByText(cdp, "模擬財務 Agent 重複下單");
  const duplicate = await inspect(cdp);
  result.checks.duplicateBlocked = duplicate.text.includes("DUPLICATE_PURCHASE · 未付款");

  await clickByText(cdp, "重置 Demo");
  await clickByText(cdp, "測試 0.03 預算");
  await sleep(750);
  const denied = await inspect(cdp);
  result.checks.lowBudgetDenied = denied.text.includes("POLICY_DENIED · 無付款") && denied.text.includes("DENY");

  await clickByText(cdp, "重置 Demo");
  await clickByText(cdp, "測試 payTo 不符");
  await sleep(750);
  const mismatch = await inspect(cdp);
  result.checks.addressMismatchDenied = mismatch.text.includes("ADDRESS_MISMATCH · 無付款") && mismatch.text.includes("DENY");

  await clickByText(cdp, "凍結所有新付款");
  const frozen = await inspect(cdp);
  result.checks.freezeState = frozen.text.includes("付款已凍結 · 點擊解除") && frozen.text.includes("新付款已凍結");

  return result;
}

let cdp;
try {
  const page = await getJson(`http://127.0.0.1:${debugPort}/json/new?about:blank`, { method: "PUT" });
  cdp = new Cdp(page.webSocketDebuggerUrl);
  await cdp.ready();
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");

  const report = {
    generatedAt: new Date().toISOString(),
    baseUrl,
    desktop: await runViewport(cdp, "desktop", 1440, 1000),
    mobile: await runViewport(cdp, "mobile", 390, 844),
  };
  const allChecks = Object.values(report.desktop.checks).concat(Object.values(report.mobile.checks));
  report.passed = allChecks.every(Boolean);
  const reportFile = path.join(outputDir, "report.json");
  await writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ passed: report.passed, outputDir, desktop: report.desktop.checks, mobile: report.mobile.checks }, null, 2));
  if (!report.passed) process.exitCode = 1;
} finally {
  cdp?.close();
  chrome.kill("SIGTERM");
}
