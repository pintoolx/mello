import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { assertSafeLocalIntegrationStack } from "../scripts/local-integration-safety.js";

const RUN_INTEGRATION_TESTS = process.env["RUN_INTEGRATION_TESTS"] === "true";
const CORE_API_URL = (process.env["CORE_API_URL"] ?? "http://localhost:4000").replace(
  /\/$/,
  "",
);
const SELLER_A_URL = (process.env["SELLER_A_URL"] ?? "http://localhost:4011").replace(
  /\/$/,
  "",
);
const SELLER_B_URL = (process.env["SELLER_B_URL"] ?? "http://localhost:4012").replace(
  /\/$/,
  "",
);
const BASE_RPC_URL = process.env["BASE_SEPOLIA_RPC_URL"] ?? "https://sepolia.base.org";
const DEMO_ADMIN_TOKEN =
  process.env["INTEGRATION_DEMO_ADMIN_TOKEN"] ?? process.env["DEMO_ADMIN_TOKEN"];
const SELLER_CONTEXT_HMAC_SECRET =
  process.env["SELLER_CONTEXT_HMAC_SECRET"] ??
  "change-me-with-at-least-32-random-characters";

const HAPPY_PROMPT =
  "幫我買一份 Example Co. 的信用報告，預算 0.1 USDC，要開統編發票。";
const REJECTED_PROMPT =
  "幫我買一份 Example Co. 的信用報告，預算 0.03 USDC，要開統編發票。";
const TERMINAL_STATUSES = new Set([
  "COMPLETED",
  "REJECTED",
  "ACTION_REQUIRED",
  "FAILED",
]);

interface HttpResult {
  status: number;
  headers: Headers;
  body: unknown;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  return value;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

async function request(url: string, init: RequestInit = {}): Promise<HttpResult> {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(15_000),
  });
  const contentType = response.headers.get("content-type") ?? "";
  const body: unknown = contentType.includes("application/json")
    ? await response.json()
    : await response.text();
  return { status: response.status, headers: response.headers, body };
}

async function coreRequest(path: string, init: RequestInit = {}): Promise<HttpResult> {
  return request(`${CORE_API_URL}/api/v1${path}`, init);
}

function expectSuccess(result: HttpResult, label: string): void {
  expect(result.status, `${label}: ${JSON.stringify(result.body)}`).toBeGreaterThanOrEqual(200);
  expect(result.status, `${label}: ${JSON.stringify(result.body)}`).toBeLessThan(300);
}

async function createAndRunTask(prompt: string): Promise<Record<string, unknown>> {
  const created = await coreRequest("/tasks", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt }),
  });
  expect(created.status).toBe(201);
  const taskId = requiredString(asRecord(created.body, "create task response")["taskId"], "taskId");

  const started = await coreRequest(`/tasks/${taskId}/run`, { method: "POST" });
  expect(started.status).toBe(202);
  return pollTask(taskId);
}

async function pollTask(taskId: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const result = await coreRequest(`/tasks/${taskId}`);
    expectSuccess(result, "get task");
    const task = asRecord(result.body, "task detail");
    const status = requiredString(task["status"], "task status");
    if (TERMINAL_STATUSES.has(status)) return task;
    await new Promise<void>((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`Task ${taskId} did not reach a terminal state within 90 seconds`);
}

function decodeBase64Json(value: string): Record<string, unknown> {
  return asRecord(
    JSON.parse(Buffer.from(value, "base64").toString("utf8")) as unknown,
    "payment-required header",
  );
}

function purchaseContextToken(sellerId: "seller-a" | "seller-b"): string {
  const payload = Buffer.from(
    JSON.stringify({
      purchaseId: randomUUID(),
      buyerProfileId: "00000000-0000-4000-8000-000000000001",
      sellerId,
      nonce: randomBytes(16).toString("hex"),
      exp: Math.floor(Date.now() / 1_000) + 600,
    }),
    "utf8",
  ).toString("base64url");
  const signature = createHmac("sha256", SELLER_CONTEXT_HMAC_SECRET)
    .update(payload)
    .digest("base64url");
  return `${payload}.${signature}`;
}

function paymentEventCount(events: unknown[]): number {
  return events.filter(
    (event) =>
      asRecord(event, "audit event")["eventType"] ===
      "PAYMENT_SETTLEMENT_AND_DELIVERY_CONFIRMED",
  ).length;
}

let happyTask: Record<string, unknown> | undefined;
let happyPurchase: Record<string, unknown> | undefined;

describe.skipIf(!RUN_INTEGRATION_TESTS).sequential(
  "local HTTP stack (Postgres + Sellers + Core + Anvil)",
  () => {
    beforeAll(async () => {
      await assertSafeLocalIntegrationStack({
        coreApiUrl: CORE_API_URL,
        sellerAUrl: SELLER_A_URL,
        sellerBUrl: SELLER_B_URL,
        baseRpcUrl: BASE_RPC_URL,
      });
    });

    it("reports the expected safe local runtime and healthy dependencies", async () => {
      const result = await coreRequest("/demo/health");
      expectSuccess(result, "demo health");
      const health = asRecord(result.body, "health");
      const modes = asRecord(health["modes"], "runtime modes");
      const checks = asRecord(health["checks"], "health checks");
      const sellers = asRecord(checks["sellers"], "seller health checks");

      expect(modes).toMatchObject({
        agent: "demo",
        payment: "mock",
        invoice: "mock",
        anchor: "onchain",
      });
      expect(asRecord(checks["database"], "database check")["status"]).toBe("ok");
      expect(asRecord(checks["baseRpc"], "RPC check")["status"]).toBe("ok");
      expect(asRecord(checks["contract"], "contract check")).toMatchObject({
        status: "ok",
        details: { mode: "onchain", codePresent: true },
      });
      expect(asRecord(sellers["sellerA"], "Seller A check")["status"]).toBe("ok");
      expect(asRecord(sellers["sellerB"], "Seller B check")["status"]).toBe("ok");
    });

    it.skipIf(!DEMO_ADMIN_TOKEN)("resets demo state through the guarded public endpoint", async () => {
      const result = await coreRequest("/demo/reset", {
        method: "POST",
        headers: { "x-demo-admin-token": DEMO_ADMIN_TOKEN ?? "" },
      });
      expectSuccess(result, "demo reset");
      expect(asRecord(result.body, "reset response")["status"]).toBe("RESET");
    });

    it("authenticates purchase context before returning x402 v2 requirements", async () => {
      for (const seller of [
        {
          id: "seller-a" as const,
          name: "seller-a",
          url: SELLER_A_URL,
          amount: "40000",
          invoice: false,
        },
        {
          id: "seller-b" as const,
          name: "seller-b",
          url: SELLER_B_URL,
          amount: "50000",
          invoice: true,
        },
      ]) {
        const forged = await request(`${seller.url}/v1/credit-report`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            targetCompanyName: "Example Co.",
            purchaseContextToken: "integration-test-context-token",
          }),
        });
        expect(forged.status, `${seller.name} forged context`).toBe(401);

        const result = await request(`${seller.url}/v1/credit-report`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            targetCompanyName: "Example Co.",
            purchaseContextToken: purchaseContextToken(seller.id),
          }),
        });
        expect(result.status, seller.name).toBe(402);
        expect(result.headers.get("x-mello-payment-mode"), seller.name).toBe("mock");
        const encoded = requiredString(
          result.headers.get("payment-required"),
          `${seller.name} payment-required header`,
        );
        const requirements = decodeBase64Json(encoded);
        const accepts = asArray(requirements["accepts"], `${seller.name} accepts`);
        expect(requirements["x402Version"], seller.name).toBe(2);
        expect(asRecord(accepts[0], `${seller.name} payment option`)).toMatchObject({
          scheme: "exact",
          network: "eip155:84532",
          amount: seller.amount,
        });
        const extensions = asRecord(requirements["extensions"], `${seller.name} extensions`);
        expect(extensions).toHaveProperty("payment-identifier");
        if (seller.invoice) {
          expect(extensions).toHaveProperty("tw-einvoice");
        } else {
          expect(extensions).not.toHaveProperty("tw-einvoice");
        }
      }
    });

    it("completes the invoiced happy path with a real local authorization and final anchor", async () => {
      happyTask = await createAndRunTask(HAPPY_PROMPT);
      expect(happyTask["status"]).toBe("COMPLETED");
      happyPurchase = asRecord(happyTask["purchase"], "happy purchase");

      expect(asRecord(happyPurchase["selectedService"], "selected service")["sellerId"]).toBe(
        "seller-b",
      );
      expect(asRecord(happyPurchase["payment"], "payment")["status"]).toBe("SETTLED");
      expect(asRecord(happyPurchase["invoice"], "invoice")["status"]).toBe("ISSUED_DEMO");
      expect(asRecord(happyPurchase["reconciliation"], "reconciliation")["status"]).toBe(
        "MATCHED",
      );

      const anchors = asArray(happyPurchase["anchors"], "anchors").map((anchor) =>
        asRecord(anchor, "anchor"),
      );
      for (const kind of ["AUTHORIZE", "FINALIZE"]) {
        const anchor = anchors.find((candidate) => candidate["kind"] === kind);
        expect(anchor, `${kind} anchor missing`).toMatchObject({
          kind,
          status: "CONFIRMED",
        });
        expect(requiredString(anchor?.["transactionHash"], `${kind} transaction hash`)).toMatch(
          /^0x[0-9a-f]{64}$/i,
        );
      }
    });

    it("rejects a low budget without creating a purchase", async () => {
      const beforeResult = await coreRequest("/purchases?limit=1&offset=0");
      expectSuccess(beforeResult, "purchase list before rejection");
      const before = asRecord(beforeResult.body, "purchase list before rejection");

      const rejected = await createAndRunTask(REJECTED_PROMPT);
      expect(rejected).toMatchObject({ status: "REJECTED", purchaseId: null });

      const afterResult = await coreRequest("/purchases?limit=1&offset=0");
      expectSuccess(afterResult, "purchase list after rejection");
      const after = asRecord(afterResult.body, "purchase list after rejection");
      expect(after["total"]).toBe(before["total"]);
    });

    it("rerunning a completed task does not create a second settlement", async () => {
      if (!happyTask || !happyPurchase) throw new Error("Happy-path fixture was not created");
      const taskId = requiredString(happyTask["taskId"], "happy taskId");
      const purchaseId = requiredString(happyPurchase["purchaseId"], "happy purchaseId");
      const paymentBefore = asRecord(happyPurchase["payment"], "payment before rerun");
      const eventsBeforeResult = await coreRequest(`/purchases/${purchaseId}/events?limit=100`);
      expectSuccess(eventsBeforeResult, "events before rerun");
      const eventsBefore = asArray(eventsBeforeResult.body, "events before rerun");

      const rerun = await coreRequest(`/tasks/${taskId}/run`, { method: "POST" });
      expect(rerun.status).toBe(200);
      const taskAfter = asRecord(rerun.body, "rerun response");
      const purchaseAfter = asRecord(taskAfter["purchase"], "purchase after rerun");
      const paymentAfter = asRecord(purchaseAfter["payment"], "payment after rerun");
      const eventsAfterResult = await coreRequest(`/purchases/${purchaseId}/events?limit=100`);
      expectSuccess(eventsAfterResult, "events after rerun");
      const eventsAfter = asArray(eventsAfterResult.body, "events after rerun");

      expect(taskAfter["status"]).toBe("COMPLETED");
      expect(paymentAfter["id"]).toBe(paymentBefore["id"]);
      expect(paymentAfter["transactionHash"]).toBe(paymentBefore["transactionHash"]);
      expect(paymentEventCount(eventsBefore)).toBe(1);
      expect(paymentEventCount(eventsAfter)).toBe(1);

      const purchases = await coreRequest("/purchases?limit=100&offset=0");
      expectSuccess(purchases, "purchase list after rerun");
      const matchingPurchases = asArray(
        asRecord(purchases.body, "purchase list")["items"],
        "purchase items",
      ).filter(
        (purchase) => asRecord(purchase, "purchase item")["taskId"] === taskId,
      );
      expect(matchingPurchases).toHaveLength(1);
    });
  },
);
