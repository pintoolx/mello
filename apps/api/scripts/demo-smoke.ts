import {
  apiBaseUrl,
  asArray,
  asRecord,
  createAndRunTask,
  pollTask,
  requestJson,
  requiredString,
  safeErrorMessage,
  writeJson,
} from "./lib.js";
import { MELLO_NETWORK } from "@mello/shared";
import {
  createPublicClient,
  erc20Abi,
  getAddress,
  http,
  type Address,
} from "viem";
import { baseSepolia } from "viem/chains";
import {
  assertRegistryDoesNotHoldFunds,
  assertSmokeRuntimeModes,
  assertTestnetFunding,
  assertTestnetTokenBalancesUnchanged,
  type TestnetTokenBalanceSnapshot,
} from "./smoke-safety.js";

const HAPPY_PROMPT =
  "幫我買一份 Example Co. 的信用報告，預算 0.1 USDC，要開統編發票。";
const REJECTED_PROMPT =
  "幫我買一份 Example Co. 的信用報告，預算 0.03 USDC，要開統編發票。";
const HAPPY_RUN_COUNT = 3;
const TESTNET_RERUN_OBSERVATION_BLOCKS = 2n;
const TESTNET_RERUN_OBSERVATION_TIMEOUT_MS = 30_000;

function createTestnetPublicClient() {
  return createPublicClient({
    chain: baseSepolia,
    transport: http(
      process.env["BASE_SEPOLIA_RPC_URL"] ?? "https://sepolia.base.org",
      { timeout: 15_000 },
    ),
  });
}

type TestnetPublicClient = ReturnType<typeof createTestnetPublicClient>;
type CapturedTokenBalances = TestnetTokenBalanceSnapshot & {
  tokenAddress: Address;
  buyerAddress: Address;
  sellerAddress: Address;
};

interface TaskRerunProof {
  settlementEventCount: number;
  tokenBalanceProof: {
    tokenAddress: Address;
    buyerAddress: Address;
    sellerAddress: Address;
    beforeBlock: string;
    immediateAfterBlock: string;
    observedAfterBlock: string;
    buyerBeforeAtomic: string;
    buyerImmediateAfterAtomic: string;
    buyerObservedAfterAtomic: string;
    sellerBeforeAtomic: string;
    sellerImmediateAfterAtomic: string;
    sellerObservedAfterAtomic: string;
    observationBlocks: string;
  } | null;
}

function optionalRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function expectEqual(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${String(expected)}, received ${String(actual)}`);
  }
}

function expectHash(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^0x[0-9a-f]{64}$/iu.test(value)) {
    throw new Error(`${label}: expected a 32-byte hex value`);
  }
  return value;
}

function hasSellerAInvoiceRejection(candidates: unknown): boolean {
  return asArray(candidates, "task candidates").some((candidate) => {
    const record = optionalRecord(candidate);
    return (
      record?.["sellerId"] === "seller-a" &&
      Array.isArray(record["reasonCodes"]) &&
      record["reasonCodes"].includes("INVOICE_UNSUPPORTED")
    );
  });
}

async function fetchTask(taskId: string): Promise<Record<string, unknown>> {
  return asRecord(
    (await requestJson(`/api/v1/tasks/${taskId}`)).body,
    "task detail",
  );
}

async function recoverInvoiceIfNeeded(
  task: Record<string, unknown>,
): Promise<{ task: Record<string, unknown>; invoiceRetried: boolean }> {
  if (task["status"] !== "ACTION_REQUIRED") {
    return { task, invoiceRetried: false };
  }
  const purchase = optionalRecord(task["purchase"]);
  const actions = optionalRecord(purchase?.["availableActions"]);
  if (actions?.["retryInvoice"] !== true) {
    return { task, invoiceRetried: false };
  }
  const taskId = requiredString(task, "taskId");
  const purchaseId = requiredString(purchase ?? {}, "purchaseId");
  const paymentBefore = asRecord(purchase?.["payment"], "payment before invoice retry");
  await requestJson(`/api/v1/purchases/${purchaseId}/retry-invoice`, {
    method: "POST",
  });

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const current = await fetchTask(taskId);
    if (current["status"] !== "ACTION_REQUIRED") {
      const completed = await pollTask(taskId);
      const completedPurchase = asRecord(completed["purchase"], "purchase after invoice retry");
      const paymentAfter = asRecord(
        completedPurchase["payment"],
        "payment after invoice retry",
      );
      expectEqual(
        paymentAfter["paymentId"],
        paymentBefore["paymentId"],
        "invoice retry payment ID",
      );
      expectEqual(
        paymentAfter["transactionHash"],
        paymentBefore["transactionHash"],
        "invoice retry settlement tx",
      );
      const events = asArray(
        (
          await requestJson(
            `/api/v1/purchases/${purchaseId}/events?limit=100&offset=0`,
          )
        ).body,
        "purchase events after invoice retry",
      );
      expectEqual(
        events.filter(
          (event) =>
            optionalRecord(event)?.["eventType"] ===
            "PAYMENT_SETTLEMENT_AND_DELIVERY_CONFIRMED",
        ).length,
        1,
        "settlement event count after invoice retry",
      );
      return { task: completed, invoiceRetried: true };
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("Invoice retry did not leave ACTION_REQUIRED state");
}

function assertHappyPath(task: Record<string, unknown>): Record<string, unknown> {
  expectEqual(task["status"], "COMPLETED", "happy task status");
  if (!hasSellerAInvoiceRejection(task["candidates"])) {
    throw new Error("Seller A was not rejected with INVOICE_UNSUPPORTED");
  }
  const purchase = asRecord(task["purchase"], "happy purchase");
  const selected = asRecord(purchase["selectedService"], "selected service");
  const payment = asRecord(purchase["payment"], "payment");
  const delivery = asRecord(purchase["delivery"], "delivery");
  const authorization = asRecord(
    purchase["paymentAuthorization"],
    "payment authorization",
  );
  const invoice = asRecord(purchase["invoice"], "invoice");
  const reconciliation = asRecord(purchase["reconciliation"], "reconciliation");
  const anchors = asArray(purchase["anchors"], "anchors").map((anchor) =>
    asRecord(anchor, "anchor"),
  );

  expectEqual(selected["sellerId"], "seller-b", "selected seller");
  expectEqual(payment["status"], "SETTLED", "payment status");
  expectEqual(payment["amountAtomic"], purchase["expectedAmountAtomic"], "settled amount");
  const settlementTxHash = expectHash(payment["transactionHash"], "settlement tx hash");
  expectEqual(authorization["status"], "SETTLED", "authorization status");
  expectHash(authorization["typedDataHash"], "authorization typed-data hash");
  expectHash(authorization["nonce"], "authorization nonce");
  expectEqual(
    authorization["settlementTxHash"],
    settlementTxHash,
    "authorization settlement mapping",
  );
  if (!authorization["validAfter"] || !authorization["validBefore"]) {
    throw new Error("ERC-3009 authorization validity evidence is missing");
  }
  expectEqual(delivery["status"], "DELIVERED", "delivery status");
  expectHash(delivery["responseHash"], "delivery response hash");
  const report = asRecord(delivery["responseBody"], "delivered report");
  requiredString(report, "reportId", "delivered report ID");
  expectEqual(invoice["status"], "ISSUED_DEMO", "invoice status");
  expectEqual(reconciliation["status"], "MATCHED", "reconciliation status");
  if (!String(invoice["disclaimer"] ?? "").includes("非正式")) {
    throw new Error("Demo invoice disclaimer is missing");
  }
  for (const kind of ["AUTHORIZE", "FINALIZE"] as const) {
    const anchor = anchors.find((entry) => entry["kind"] === kind);
    expectEqual(anchor?.["status"], "CONFIRMED", `${kind} anchor`);
    expectHash(anchor?.["transactionHash"], `${kind} anchor tx hash`);
  }
  if (!purchase["paymentAuthorizationHash"] || !authorization["typedDataHash"]) {
    throw new Error("ERC-3009 evidence hashes are missing");
  }
  return purchase;
}

async function captureTestnetTokenBalances(
  client: TestnetPublicClient,
  purchase: Record<string, unknown>,
): Promise<CapturedTokenBalances> {
  const token = asRecord(purchase["token"], "purchase token");
  const tokenAddress = getAddress(requiredString(token, "address", "token address"));
  const buyerAddress = getAddress(
    requiredString(purchase, "buyerAddress", "buyer address"),
  );
  const sellerAddress = getAddress(
    requiredString(purchase, "payToAddress", "Seller B payTo address"),
  );
  const blockNumber = await client.getBlockNumber({ cacheTime: 0 });
  const [buyerBalance, sellerBalance] = await Promise.all([
    client.readContract({
      address: tokenAddress,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [buyerAddress],
      blockNumber,
    }),
    client.readContract({
      address: tokenAddress,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [sellerAddress],
      blockNumber,
    }),
  ]);
  return {
    blockNumber,
    buyerBalance,
    sellerBalance,
    tokenAddress,
    buyerAddress,
    sellerAddress,
  };
}

async function waitForTestnetObservationWindow(
  client: TestnetPublicClient,
  startingBlock: bigint,
): Promise<void> {
  const targetBlock = startingBlock + TESTNET_RERUN_OBSERVATION_BLOCKS;
  const deadline = Date.now() + TESTNET_RERUN_OBSERVATION_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if ((await client.getBlockNumber({ cacheTime: 0 })) >= targetBlock) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(
    `Base Sepolia did not advance to block ${targetBlock.toString()} within the token-transfer observation window`,
  );
}

async function assertTaskRerunIsIdempotent(
  task: Record<string, unknown>,
  originalPurchase: Record<string, unknown>,
  testnetClient: TestnetPublicClient | null,
): Promise<TaskRerunProof> {
  const taskId = requiredString(task, "taskId");
  const purchaseId = requiredString(originalPurchase, "purchaseId");
  const originalPayment = asRecord(originalPurchase["payment"], "original payment");
  const balancesBefore = testnetClient
    ? await captureTestnetTokenBalances(testnetClient, originalPurchase)
    : null;
  const rerunResponse = await requestJson(`/api/v1/tasks/${taskId}/run`, {
    method: "POST",
  });
  const balancesImmediatelyAfter = testnetClient
    ? await captureTestnetTokenBalances(testnetClient, originalPurchase)
    : null;
  if (balancesBefore && balancesImmediatelyAfter) {
    assertTestnetTokenBalancesUnchanged(
      balancesBefore,
      balancesImmediatelyAfter,
    );
  }
  expectEqual(rerunResponse.status, 200, "completed task rerun HTTP status");
  const rerunTask = asRecord(rerunResponse.body, "completed task rerun");
  const rerunPurchase = asRecord(rerunTask["purchase"], "rerun purchase");
  const rerunPayment = asRecord(rerunPurchase["payment"], "rerun payment");
  expectEqual(rerunPurchase["purchaseId"], purchaseId, "rerun purchase ID");
  expectEqual(rerunPayment["paymentId"], originalPayment["paymentId"], "rerun payment ID");
  expectEqual(
    rerunPayment["transactionHash"],
    originalPayment["transactionHash"],
    "rerun settlement tx",
  );

  const events = asArray(
    (await requestJson(`/api/v1/purchases/${purchaseId}/events?limit=100&offset=0`)).body,
    "purchase events after rerun",
  );
  const settlementEvents = events.filter(
    (event) =>
      optionalRecord(event)?.["eventType"] ===
        "PAYMENT_SETTLEMENT_AND_DELIVERY_CONFIRMED",
  );
  expectEqual(settlementEvents.length, 1, "settlement event count after rerun");

  let balancesAfterObservation: CapturedTokenBalances | null = null;
  if (testnetClient && balancesBefore && balancesImmediatelyAfter) {
    await waitForTestnetObservationWindow(testnetClient, balancesBefore.blockNumber);
    balancesAfterObservation = await captureTestnetTokenBalances(
      testnetClient,
      originalPurchase,
    );
    assertTestnetTokenBalancesUnchanged(
      balancesBefore,
      balancesAfterObservation,
      TESTNET_RERUN_OBSERVATION_BLOCKS,
    );
  }

  return {
    settlementEventCount: settlementEvents.length,
    tokenBalanceProof:
      balancesBefore && balancesImmediatelyAfter && balancesAfterObservation
        ? {
            tokenAddress: balancesBefore.tokenAddress,
            buyerAddress: balancesBefore.buyerAddress,
            sellerAddress: balancesBefore.sellerAddress,
            beforeBlock: balancesBefore.blockNumber.toString(),
            immediateAfterBlock: balancesImmediatelyAfter.blockNumber.toString(),
            observedAfterBlock: balancesAfterObservation.blockNumber.toString(),
            buyerBeforeAtomic: balancesBefore.buyerBalance.toString(),
            buyerImmediateAfterAtomic:
              balancesImmediatelyAfter.buyerBalance.toString(),
            buyerObservedAfterAtomic:
              balancesAfterObservation.buyerBalance.toString(),
            sellerBeforeAtomic: balancesBefore.sellerBalance.toString(),
            sellerImmediateAfterAtomic:
              balancesImmediatelyAfter.sellerBalance.toString(),
            sellerObservedAfterAtomic:
              balancesAfterObservation.sellerBalance.toString(),
            observationBlocks: TESTNET_RERUN_OBSERVATION_BLOCKS.toString(),
          }
        : null,
  };
}

function walletDetails(
  health: Record<string, unknown>,
  walletName: "buyerWallet" | "operatorWallet",
): Record<string, unknown> | null {
  const checks = optionalRecord(health["checks"]);
  const wallet = optionalRecord(checks?.[walletName]);
  return optionalRecord(wallet?.["details"]);
}

function modesFromHealth(health: Record<string, unknown>): Record<string, unknown> {
  return asRecord(health["modes"], "health modes");
}

function healthCheckDetails(
  health: Record<string, unknown>,
  checkName: string,
): Record<string, unknown> | null {
  const checks = optionalRecord(health["checks"]);
  return optionalRecord(optionalRecord(checks?.[checkName])?.["details"]);
}

async function assertExecutionMode(testnet: boolean): Promise<Record<string, unknown>> {
  const health = asRecord(
    (await requestJson("/api/v1/demo/health")).body,
    "health response",
  );
  const modes = modesFromHealth(health);
  const checks = optionalRecord(health["checks"]);
  const baseRpc = optionalRecord(optionalRecord(checks?.["baseRpc"])?.["details"]);
  assertSmokeRuntimeModes(
    {
      payment: modes["payment"],
      anchor: modes["anchor"],
      healthStatus: health["status"],
      offchainAuthorizationFallbackEnabled:
        modes["offchainAuthorizationFallbackEnabled"],
      baseRpc: baseRpc
        ? {
            chainId: baseRpc["chainId"],
            loopback: baseRpc["loopback"],
          }
        : null,
    },
    testnet,
  );
  if (!testnet) {
    const invoice = optionalRecord(checks?.["invoice"]);
    const invoiceDetails = optionalRecord(invoice?.["details"]);
    if (invoiceDetails?.["failOnceEnabled"] !== true) {
      throw new Error(
        "Local demo:smoke requires Core to start with MOCK_INVOICE_FAIL_ONCE=true so the canonical smoke proves invoice-only recovery",
      );
    }
  }
  if (testnet) {
    assertTestnetFunding(
      walletDetails(health, "buyerWallet"),
      walletDetails(health, "operatorWallet"),
    );
    assertRegistryDoesNotHoldFunds(
      healthCheckDetails(health, "registryTokenBalance"),
    );
  }
  return health;
}

async function printAndVerifyTestnetApproval(
  health: Record<string, unknown>,
): Promise<void> {
  const servicesResponse = asRecord(
    (await requestJson("/api/v1/services?category=credit_report")).body,
    "services response",
  );
  const services = asArray(servicesResponse["services"], "services");
  const sellerB = services
    .map((item) => asRecord(item, "service"))
    .find((service) => service["sellerId"] === "seller-b");
  const checks = optionalRecord(health["checks"]);
  const wallet = optionalRecord(optionalRecord(checks?.["buyerWallet"])?.["details"]);
  writeJson({
    action: "TESTNET_PAYMENT_APPROVAL_REQUIRED",
    network: sellerB?.["network"] ?? MELLO_NETWORK,
    tokenAddress: sellerB?.["tokenAddress"],
    amountAtomic: sellerB?.["priceAtomic"] ?? "50000",
    amountDisplay: "0.05 USDC",
    repetitions: HAPPY_RUN_COUNT,
    maximumTotalAmountAtomic: "150000",
    maximumTotalAmountDisplay: "0.15 USDC",
    sellerId: "seller-b",
    payToAddress: sellerB?.["payToAddress"],
    buyerAddress: wallet?.["address"],
    additionalTransactions: "audit authorize + finalize gas transactions",
    approvalFlag: "MELLO_TESTNET_PAYMENT_APPROVED=true",
  });
  if (process.env["MELLO_TESTNET_PAYMENT_APPROVED"] !== "true") {
    throw new Error(
      "No transaction was sent. Review the summary, then explicitly set MELLO_TESTNET_PAYMENT_APPROVED=true",
    );
  }
}

async function main(): Promise<void> {
  const testnet = process.argv.includes("--testnet");
  const health = await assertExecutionMode(testnet);
  if (testnet) await printAndVerifyTestnetApproval(health);
  const testnetClient = testnet ? createTestnetPublicClient() : null;

  const happyRuns: Array<{
    task: Record<string, unknown>;
    purchase: Record<string, unknown>;
    invoiceRetried: boolean;
    rerunProof: TaskRerunProof;
  }> = [];
  for (let run = 1; run <= HAPPY_RUN_COUNT; run += 1) {
    let task = await createAndRunTask(HAPPY_PROMPT);
    const recovery = await recoverInvoiceIfNeeded(task);
    task = recovery.task;
    const purchase = assertHappyPath(task);
    const rerunProof = await assertTaskRerunIsIdempotent(
      task,
      purchase,
      testnetClient,
    );
    happyRuns.push({
      task,
      purchase,
      invoiceRetried: recovery.invoiceRetried,
      rerunProof,
    });
  }

  const before = asRecord(
    (await requestJson("/api/v1/purchases?limit=1&offset=0")).body,
    "purchase list",
  );
  const beforeRejectionHealth = testnet
    ? asRecord((await requestJson("/api/v1/demo/health")).body, "pre-rejection health")
    : null;
  if (beforeRejectionHealth) {
    assertRegistryDoesNotHoldFunds(
      healthCheckDetails(beforeRejectionHealth, "registryTokenBalance"),
    );
  }
  const rejected = await createAndRunTask(REJECTED_PROMPT);
  expectEqual(rejected["status"], "REJECTED", "low-budget task status");
  expectEqual(rejected["purchaseId"], null, "low-budget purchase");
  const after = asRecord(
    (await requestJson("/api/v1/purchases?limit=1&offset=0")).body,
    "purchase list",
  );
  expectEqual(after["total"], before["total"], "purchase count after rejection");
  const rejectionEvents = asArray(
    (
      await requestJson(
        `/api/v1/tasks/${requiredString(rejected, "taskId")}/events?limit=100&offset=0`,
      )
    ).body,
    "rejection events",
  );
  if (
    rejectionEvents.some((event) => {
      const eventType = optionalRecord(event)?.["eventType"];
      return (
        typeof eventType === "string" &&
        /^(?:PAYMENT|PAID_REQUEST|SIGNED_PAID_REQUEST)|ANCHOR/u.test(eventType)
      );
    })
  ) {
    throw new Error("Low-budget rejection emitted a payment or anchor execution event");
  }
  if (beforeRejectionHealth) {
    const afterRejectionHealth = asRecord(
      (await requestJson("/api/v1/demo/health")).body,
      "post-rejection health",
    );
    assertRegistryDoesNotHoldFunds(
      healthCheckDetails(afterRejectionHealth, "registryTokenBalance"),
    );
    const beforeWallet = walletDetails(beforeRejectionHealth, "buyerWallet");
    const afterWallet = walletDetails(afterRejectionHealth, "buyerWallet");
    expectEqual(
      afterWallet?.["usdcBalanceAtomic"],
      beforeWallet?.["usdcBalanceAtomic"],
      "buyer USDC balance after rejection",
    );
    expectEqual(
      afterWallet?.["nativeBalanceAtomic"],
      beforeWallet?.["nativeBalanceAtomic"],
      "buyer native balance after rejection",
    );
    expectEqual(
      requiredString(afterWallet ?? {}, "transactionCount"),
      requiredString(beforeWallet ?? {}, "transactionCount"),
      "buyer chain transaction count after rejection",
    );
  }

  const firstHappy = happyRuns[0];
  if (!firstHappy) throw new Error("No happy-path run completed");
  if (!testnet && !happyRuns.every(({ invoiceRetried }) => invoiceRetried)) {
    throw new Error(
      "Canonical local smoke did not observe the required fail-once invoice retry on every happy-path run",
    );
  }

  writeJson({
    ok: true,
    mode: testnet ? "x402-testnet" : "mock-local",
    coreApi: apiBaseUrl(),
    happyPathRuns: happyRuns.map(({ task, purchase, invoiceRetried }, index) => ({
      run: index + 1,
      invoiceRetried,
      taskId: task["taskId"],
      purchaseId: purchase["purchaseId"],
      sellerId: asRecord(purchase["selectedService"])["sellerId"],
      paymentStatus: asRecord(purchase["payment"])["status"],
      deliveryStatus: asRecord(purchase["delivery"])["status"],
      invoiceStatus: asRecord(purchase["invoice"])["status"],
      reconciliationStatus: asRecord(purchase["reconciliation"])["status"],
      anchors: asArray(purchase["anchors"], "anchors").map((anchor) => {
        const value = asRecord(anchor);
        return {
          kind: value["kind"],
          status: value["status"],
          transactionHash: value["transactionHash"],
        };
      }),
    })),
    idempotencyProbes: happyRuns.map(({ task, purchase, rerunProof }, index) => ({
      run: index + 1,
      taskId: task["taskId"],
      purchaseId: purchase["purchaseId"],
      rerunSettlementCount: rerunProof.settlementEventCount,
      tokenBalanceProof: rerunProof.tokenBalanceProof,
    })),
    rejectionPath: {
      taskId: rejected["taskId"],
      status: rejected["status"],
      purchaseCreated: false,
      noPaymentOrAnchorExecutionEvents: true,
      ...(testnet ? { walletAndChainActivityUnchanged: true } : {}),
    },
  });
}

void main().catch((error: unknown) => {
  process.stderr.write(`Demo smoke failed: ${safeErrorMessage(error)}\n`);
  process.exitCode = 1;
});
