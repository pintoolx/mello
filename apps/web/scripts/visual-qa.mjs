import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const baseUrl = process.env.MELLO_QA_URL ?? "http://localhost:4173";
const docsUrl = process.env.MELLO_QA_DOCS_URL ?? "http://localhost:4174";
const chromeBin = process.env.CHROME_BIN ?? "google-chrome";
const outputDir = path.join(tmpdir(), "mello-visual-qa");
const debugPort = 9333;
let sessionCookie = "";

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
      const node = [...document.querySelectorAll("button, a, summary")].find((item) => item.textContent.includes(${JSON.stringify(text)}));
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
  await cdp.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
  const result = { viewport: { width, height }, checks: {}, screenshots: {} };
  const record = async (key) => {
    const state = await inspect(cdp);
    result.checks[`${key}NoHorizontalOverflow`] = state.document.width <= width;
    result.screenshots[key] = await snapshot(cdp, `${name}-${key}`);
    return state;
  };
  await navigate(cdp, `${baseUrl}/`);
  await waitFor(cdp, "location.pathname === '/app'");
  await record("entry");
  result.checks.directWorkspaceEntry = await evaluate(cdp, "location.pathname === '/app' && document.querySelector('h1')?.textContent === '採購申請'");
  result.checks.workspaceHasNoMarketingOrDocsLinks = await evaluate(cdp, "![...document.querySelectorAll('a')].some(a => /官網|文件|了解 Mello/.test(a.textContent) || (a.origin !== location.origin))");
  result.checks.noEmbeddedVideo = await evaluate(cdp, "document.querySelectorAll('video').length === 0");
  await navigate(cdp, `${baseUrl}/app`);
  await waitFor(cdp, "!document.body.innerText.includes('正在讀取採購申請')");
  const initial = await record("requests");
  result.checks.noDemoControls = !initial.buttons.some((text) => /Demo|模擬財務|測試 0.03|凍結/.test(text));
  result.checks.noNumberedNavigation = await evaluate(cdp, "![...document.querySelectorAll('nav a')].some(a => /0[1-6]/.test(a.textContent))");

  await clickByText(cdp, "新增採購申請");
  await waitFor(cdp, "document.getElementById('target') && !document.querySelector('button[type=submit]')?.disabled");
  await record("new-request");
  const target = `晨光貿易 ${name}`;
  await fill(cdp, "target", target);
  await fill(cdp, "budget", "0.10");
  await clickByText(cdp, "建立申請");
  await waitFor(cdp, "location.pathname.startsWith('/app/tasks/') && !location.pathname.endsWith('/new') && document.body.innerText.includes('送出採購')");
  const taskPath = await evaluate(cdp, "location.pathname");
  const taskId = taskPath.split("/").at(-1);
  result.taskId = taskId;
  result.checks.savedBeforePayment = (await request(`/tasks/${taskId}`)).status === "CREATED";
  await clickByText(cdp, "送出採購");
  await waitFor(cdp, "document.querySelector('.page-actions')?.textContent.includes('已完成')", 45000);
  const task = await request(`/tasks/${taskId}`);
  result.checks.persistedSettlement = task.status === "COMPLETED" && task.purchase?.payment?.status === "SETTLED" && task.purchase?.invoice?.status === "ISSUED_DEMO" && task.purchase?.reconciliation?.status === "MATCHED";
  result.checks.invoiceRequirementApplied = task.candidates.some((item) => item.sellerId === "seller-a" && !item.eligible) && task.purchase?.selectedService?.sellerId === "seller-b";
  await navigate(cdp, `${baseUrl}${taskPath}`);
  await waitFor(cdp, "document.querySelector('.page-actions')?.textContent.includes('已完成')");
  result.checks.reloadRetainsTask = (await inspect(cdp)).text.includes(target);
  await record("case");
  await clickByText(cdp, "供應商與政策");
  await record("decision");
  await clickByText(cdp, "付款與對帳");
  const records = await record("records");
  result.checks.truthfulModes = records.text.includes("模擬結算") && records.text.includes("TEST INVOICE");
  await clickByText(cdp, "查看交付報告");
  result.checks.reportVisible = await evaluate(cdp, "document.querySelector('.report-content')?.open === true");
  await clickByText(cdp, "活動紀錄");
  await record("activity");
  for (const section of ["payments", "invoices", "policy", "audit"]) {
    await navigate(cdp, `${baseUrl}/app/${section}`);
    await waitFor(cdp, "!document.querySelector('.workspace-notice')?.textContent.includes('正在讀取')");
    await record(section);
  }
  await navigate(cdp, `${baseUrl}/app/tasks/new`);
  await fill(cdp, "target", target);
  await fill(cdp, "budget", "0.03");
  await clickByText(cdp, "建立申請");
  await waitFor(cdp, "location.pathname.startsWith('/app/tasks/') && !location.pathname.endsWith('/new') && document.body.innerText.includes('送出採購')");
  const deniedId = await evaluate(cdp, "location.pathname.split('/').at(-1)");
  await clickByText(cdp, "送出採購");
  await waitFor(cdp, "document.querySelector('.page-actions')?.textContent.includes('未核准')", 45000);
  const denied = await request(`/tasks/${deniedId}`);
  result.checks.lowBudgetNoPayment = denied.status === "REJECTED" && denied.purchase === null;
  await record("denied");
  // Only re-run the same logical task; this is not cross-task business deduplication.
  await request(`/tasks/${taskId}/run`, { method: "POST" });
  const retried = await request(`/tasks/${taskId}`);
  result.checks.sameTaskIdempotent = retried.purchaseId === task.purchaseId && retried.purchase.paymentAuthorization.paymentId === task.purchase.paymentAuthorization.paymentId;
  for (const slug of ["", "purchase-guide", "policy", "records", "architecture", "implementation"]) {
    await navigate(cdp, `${docsUrl}/${slug}`);
    const doc = await record(`docs-${slug || "overview"}`);
    result.checks[`docs-${slug || "overview"}-isIndependent`] = await evaluate(cdp, "Boolean(document.querySelector('.document h1')) && ![...document.querySelectorAll('a')].some(a => a.origin !== location.origin || a.pathname.startsWith('/app')) && document.querySelectorAll('video').length === 0");
    result.checks[`docs-${slug || "overview"}-contentPresent`] = doc.text.length > 300;
  }
  if (width < 600) {
    await evaluate(cdp, "document.querySelector('.mobile-doc-nav summary').click()");
    result.checks.mobileDocumentMenuWorks = await evaluate(cdp, "document.querySelector('.mobile-doc-nav details').open && document.querySelectorAll('.mobile-doc-nav nav a').length === 6");
    await record("docs-mobile-menu");
  }
  return result;
}

async function request(route, init) {
  const response = await fetch(`${baseUrl}/api/v1${route}`, { ...init, headers: { "content-type": "application/json", origin: new URL(baseUrl).origin, cookie: sessionCookie, ...init?.headers } });
  if (!response.ok) throw new Error(`API ${route}: ${response.status}`);
  return response.json();
}

async function waitFor(cdp, expression, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await evaluate(cdp, expression)) return;
    await sleep(150);
  }
  throw new Error(`Timed out: ${expression}\n${(await inspect(cdp)).text}`);
}

async function fill(cdp, id, value) {
  await waitFor(cdp, `document.getElementById(${JSON.stringify(id)}) !== null`);
  await evaluate(cdp, `(() => { const input = document.getElementById(${JSON.stringify(id)}); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)}); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await sleep(100);
}

let cdp;
try {
  if (!process.env.MELLO_ACCESS_CODE) throw new Error("Set the private MELLO_ACCESS_CODE in the QA process environment.");
  const login = await fetch(`${baseUrl}/api/session`, { method: "POST", headers: { "content-type": "application/json", origin: new URL(baseUrl).origin }, body: JSON.stringify({ code: process.env.MELLO_ACCESS_CODE }) });
  if (!login.ok) throw new Error(`QA login failed: ${login.status}`);
  sessionCookie = login.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
  const health = await request("/demo/health");
  if (health.modes.payment !== "mock" || health.modes.anchor !== "mock" || health.modes.agent !== "demo" || health.modes.invoice !== "mock") throw new Error("Visual QA creates persisted tasks and is restricted to an isolated mock/demo API. Refusing to spend funds or call a paid model.");
  const page = await getJson(`http://127.0.0.1:${debugPort}/json/new?about:blank`, { method: "PUT" });
  cdp = new Cdp(page.webSocketDebuggerUrl);
  await cdp.ready();
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  for (const cookie of sessionCookie.split("; ")) {
    const separator = cookie.indexOf("=");
    await cdp.send("Network.setCookie", { name: cookie.slice(0, separator), value: cookie.slice(separator + 1), url: baseUrl, path: "/", httpOnly: true, sameSite: "Strict", secure: baseUrl.startsWith("https:") });
  }

  const report = {
    generatedAt: new Date().toISOString(),
    baseUrl,
    docsUrl,
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
