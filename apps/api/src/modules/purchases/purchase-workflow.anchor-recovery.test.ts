import {
  MockAuditAnchorClient,
  type AnchorSubmissionOptions,
  type AuditAnchorClient,
  type AuthorizePurchaseInput,
} from "@mello/contracts-client";
import type { PrismaClient } from "@mello/db";
import {
  BASE_SEPOLIA_USDC,
  MELLO_NETWORK,
  MelloError,
  hashCanonicalJson,
} from "@mello/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../config.js";
import { notRequiredInvoiceEvidenceHash } from "../invoices/index.js";
import {
  PendingSettlementVerificationError,
  SettledPaymentDeliveryError,
  authorizationEvidenceHash,
  buildAuthorizationRecord,
  recordSignedAuthorization,
  type PaymentProvider,
  type PaymentSubmissionHooks,
  type PreparePaymentInput,
  type PreparedPayment,
} from "../x402-buyer/index.js";
import { PurchaseWorkflow } from "./purchase-workflow.js";

const PURCHASE_ID = "00000000-0000-4000-8000-000000000010";
const TASK_ID = "00000000-0000-4000-8000-000000000011";
const COMPANY_ID = "00000000-0000-4000-8000-000000000001";
const PAYMENT_ID = "payment_retry_000001";
const BUYER = "0x9999999999999999999999999999999999999999" as const;
const SELLER = "0x2222222222222222222222222222222222222222" as const;
const NOW = new Date("2030-01-01T00:00:00.000Z");
const REPORT = {
  reportId: "report-recovery",
  provider: "seller-b",
  targetCompanyName: "Example Co.",
  riskScore: 20,
  riskLevel: "LOW" as const,
  summary: "Low risk",
  generatedAt: NOW.toISOString(),
};
const bytes32 = (character: string): `0x${string}` =>
  `0x${character.repeat(64)}` as `0x${string}`;

interface HarnessState {
  task: TaskRecord;
  purchase: PurchaseRecord;
  payment: PaymentRecord;
  authorization: AuthorizationRecord;
  authorizationNonces: MutableRecord[];
  delivery: DeliveryRecord;
  invoice: MutableRecord;
  reconciliation: ReconciliationRecord;
  anchors: AnchorRecord[];
  events: MutableRecord[];
}

interface MutableRecord {
  [key: string]: unknown;
}

interface TaskRecord extends MutableRecord {
  status: string;
  errorCode: string | null;
  errorMessage: string | null;
}

interface PurchaseRecord extends MutableRecord {
  status: string;
  actualAmountAtomic: string | null;
  paymentAuthorizationHash: string | null;
  authorization: AuthorizationRecord;
  expiresAt: Date;
}

interface PaymentRecord extends MutableRecord {
  status: string;
  transactionHash: string | null;
}

interface AuthorizationRecord extends MutableRecord {
  nonce: string;
}

interface DeliveryRecord extends MutableRecord {
  status: string;
  responseHash: string | null;
}

interface ReconciliationRecord extends MutableRecord {
  status: string;
  canonicalHash: string | null;
}

interface AnchorRecord extends MutableRecord {
  id: string;
  kind: "AUTHORIZE" | "FINALIZE" | "FAIL";
  status: string;
  transactionHash: string | null;
  attemptCount: number;
  retryClaimId: string | null;
  retryClaimedAt: Date | null;
}

function isIncrement(value: unknown): value is { increment: number } {
  return (
    typeof value === "object" &&
    value !== null &&
    "increment" in value &&
    typeof value.increment === "number"
  );
}

function applyData(target: MutableRecord, data: MutableRecord): void {
  for (const [key, value] of Object.entries(data)) {
    if (isIncrement(value)) {
      target[key] = Number(target[key] ?? 0) + Number(value.increment);
    } else {
      target[key] = value;
    }
  }
}

function statusMatches(current: string, condition: unknown): boolean {
  if (typeof condition === "string") return current === condition;
  if (
    condition &&
    typeof condition === "object" &&
    "in" in condition &&
    Array.isArray((condition as { in: unknown }).in)
  ) {
    return (condition as { in: unknown[] }).in.includes(current);
  }
  return true;
}

function createHarness(options: {
  authorizeStatus?: string;
  authorizeHash?: string | null;
  finalizeStatus?: string;
  finalizeHash?: string | null;
  failStatus?: string;
  failHash?: string | null;
  paymentStatus?: string;
  failSettlementPersistence?: boolean;
} = {}): { prisma: PrismaClient; state: HarnessState } {
  const task: TaskRecord = {
    id: TASK_ID,
    status: "ACTION_REQUIRED",
    errorCode: "CONTRACT_ANCHOR_FAILED",
    errorMessage: "initial failure",
    intent: {
      targetCompanyName: "Example Co.",
      requiresTwInvoice: false,
      buyerBusinessId: "12345675",
      maxAmount: { atomic: "100000" },
    },
  };
  const payment: PaymentRecord = {
    purchaseId: PURCHASE_ID,
    paymentId: PAYMENT_ID,
    status: options.paymentStatus ?? "AUTHORIZED",
    payerAddress: BUYER,
    payeeAddress: SELLER,
    amountAtomic: "100000",
    network: MELLO_NETWORK,
    tokenAddress: BASE_SEPOLIA_USDC,
    transactionHash: null,
  };
  const authorization: AuthorizationRecord = {
    purchaseId: PURCHASE_ID,
    paymentId: PAYMENT_ID,
    nonce: bytes32("a"),
    status: "CREATED",
  };
  const delivery: DeliveryRecord = {
    purchaseId: PURCHASE_ID,
    status: "PENDING",
    responseHash: null,
  };
  const invoice: MutableRecord = {
    purchaseId: PURCHASE_ID,
    status: "NOT_REQUIRED",
    canonicalHash: notRequiredInvoiceEvidenceHash(PURCHASE_ID),
  };
  const reconciliation: ReconciliationRecord = {
    purchaseId: PURCHASE_ID,
    status: "PENDING",
    canonicalHash: null,
  };
  const anchors: AnchorRecord[] = [
    {
      id: "00000000-0000-4000-8000-000000000021",
      purchaseId: PURCHASE_ID,
      kind: "AUTHORIZE",
      status: options.authorizeStatus ?? "FAILED_RETRYABLE",
      transactionHash: options.authorizeHash ?? null,
      attemptCount: 1,
      retryClaimId: null,
      retryClaimedAt: null,
      createdAt: new Date("2029-12-31T23:00:00.000Z"),
    },
    {
      id: "00000000-0000-4000-8000-000000000022",
      purchaseId: PURCHASE_ID,
      kind: "FINALIZE",
      status: options.finalizeStatus ?? "NOT_STARTED",
      transactionHash: options.finalizeHash ?? null,
      attemptCount: 0,
      retryClaimId: null,
      retryClaimedAt: null,
      createdAt: new Date("2029-12-31T23:00:01.000Z"),
    },
    {
      id: "00000000-0000-4000-8000-000000000023",
      purchaseId: PURCHASE_ID,
      kind: "FAIL",
      status: options.failStatus ?? "NOT_STARTED",
      transactionHash: options.failHash ?? null,
      attemptCount: 0,
      retryClaimId: null,
      retryClaimedAt: null,
      createdAt: new Date("2029-12-31T23:00:02.000Z"),
    },
  ];
  const seller = {
    id: "seller-b",
    businessId: "12345675",
    payToAddress: SELLER,
  };
  const service = {
    id: "credit-report-b",
    sellerId: "seller-b",
    endpoint: "http://seller.test/api/v1/credit-report",
    priceAtomic: "100000",
    network: MELLO_NETWORK,
    tokenSymbol: "USDC",
    tokenAddress: BASE_SEPOLIA_USDC,
    tokenDecimals: 6,
    seller,
  };
  const purchase: PurchaseRecord = {
    id: PURCHASE_ID,
    taskId: TASK_ID,
    paymentId: PAYMENT_ID,
    serviceId: service.id,
    expectedAmountAtomic: "100000",
    actualAmountAtomic: null,
    network: MELLO_NETWORK,
    tokenSymbol: "USDC",
    tokenAddress: BASE_SEPOLIA_USDC,
    tokenDecimals: 6,
    buyerAddress: BUYER,
    payToAddress: SELLER,
    policySnapshot: {
      perTxLimitAtomic: "1000000",
      dailyLimitAtomic: "2000000",
      requireTwInvoice: false,
      allowedNetworks: [MELLO_NETWORK],
      allowedTokens: [{ symbol: "USDC", address: BASE_SEPOLIA_USDC, decimals: 6 }],
      allowedSellerIds: ["seller-a", "seller-b"],
    },
    mandateHash: bytes32("1"),
    policyHash: bytes32("2"),
    paymentAuthorizationHash: bytes32("3"),
    expiresAt: new Date("2030-01-01T00:10:00.000Z"),
    status: "ACTION_REQUIRED",
    task,
    buyerProfile: { id: COMPANY_ID, businessId: "12345675" },
    service,
    payment,
    authorization,
    delivery,
    invoice,
    reconciliation,
    anchors,
  };
  const state: HarnessState = {
    task,
    purchase,
    payment,
    authorization,
    authorizationNonces: [
      {
        purchaseId: PURCHASE_ID,
        paymentId: PAYMENT_ID,
        nonce: bytes32("a"),
        typedDataHash: bytes32("0"),
        createdAt: new Date("2029-12-31T23:59:00.000Z"),
      },
    ],
    delivery,
    invoice,
    reconciliation,
    anchors,
    events: [],
  };

  const anchorFor = (where: MutableRecord): AnchorRecord => {
    const composite = where["purchaseId_kind"] as MutableRecord | undefined;
    const kind = composite?.["kind"];
    const anchor = anchors.find((candidate) => candidate.kind === kind);
    if (!anchor) throw new Error(`missing ${String(kind)} anchor`);
    return anchor;
  };
  const client: MutableRecord = {
    $transaction: async (callback: (transaction: unknown) => unknown) => callback(client),
    companyProfile: {
      findFirstOrThrow: async () => ({ id: COMPANY_ID }),
    },
    purchase: {
      findUnique: async () => purchase,
      findUniqueOrThrow: async () => purchase,
      update: async ({ data }: { data: MutableRecord }) => {
        applyData(purchase, data);
        return purchase;
      },
      updateMany: async ({ where, data }: { where: MutableRecord; data: MutableRecord }) => {
        if (!statusMatches(purchase.status, where["status"])) return { count: 0 };
        applyData(purchase, data);
        return { count: 1 };
      },
    },
    task: {
      findUnique: async () => ({ ...task, purchase }),
      update: async ({ data }: { data: MutableRecord }) => {
        applyData(task, data);
        return task;
      },
      updateMany: async ({ where, data }: { where: MutableRecord; data: MutableRecord }) => {
        if (!statusMatches(task.status, where["status"])) return { count: 0 };
        applyData(task, data);
        return { count: 1 };
      },
    },
    payment: {
      findUnique: async () => payment,
      update: async ({ data }: { data: MutableRecord }) => {
        applyData(payment, data);
        return payment;
      },
      updateMany: async ({ where, data }: { where: MutableRecord; data: MutableRecord }) => {
        if (!statusMatches(payment.status, where["status"])) return { count: 0 };
        if (options.failSettlementPersistence && data["status"] === "SETTLED") {
          throw new Error("settlement persistence unavailable");
        }
        if (
          typeof where["transactionHash"] === "string" &&
          payment.transactionHash !== where["transactionHash"]
        ) {
          return { count: 0 };
        }
        applyData(payment, data);
        return { count: 1 };
      },
    },
    paymentAuthorization: {
      upsert: async ({ update }: { update: MutableRecord }) => {
        applyData(authorization, update);
        purchase.authorization = authorization;
        return authorization;
      },
      update: async ({ data }: { data: MutableRecord }) => {
        applyData(authorization, data);
        return authorization;
      },
      updateMany: async ({ where, data }: { where: MutableRecord; data: MutableRecord }) => {
        if (
          !statusMatches(String(authorization["status"]), where["status"]) ||
          (typeof where["paymentId"] === "string" && authorization["paymentId"] !== where["paymentId"])
        ) {
          return { count: 0 };
        }
        applyData(authorization, data);
        return { count: 1 };
      },
    },
    paymentAuthorizationNonce: {
      create: async ({ data }: { data: MutableRecord }) => {
        if (
          state.authorizationNonces.some(
            (record) => record["nonce"] === data["nonce"],
          )
        ) {
          throw Object.assign(new Error("unique nonce"), {
            code: "P2002",
            meta: {
              modelName: "PaymentAuthorizationNonce",
              target: ["nonce"],
            },
          });
        }
        state.authorizationNonces.push(data);
        return data;
      },
    },
    delivery: {
      update: async ({ data }: { data: MutableRecord }) => {
        applyData(delivery, data);
        return delivery;
      },
      updateMany: async ({ where, data }: { where: MutableRecord; data: MutableRecord }) => {
        if (!statusMatches(delivery.status, where["status"])) return { count: 0 };
        applyData(delivery, data);
        return { count: 1 };
      },
    },
    invoice: {
      findUniqueOrThrow: async () => invoice,
      update: async ({ data }: { data: MutableRecord }) => {
        applyData(invoice, data);
        return invoice;
      },
    },
    reconciliation: {
      findUnique: async () => reconciliation,
      update: async ({ data }: { data: MutableRecord }) => {
        applyData(reconciliation, data);
        return reconciliation;
      },
      updateMany: async ({ where, data }: { where: MutableRecord; data: MutableRecord }) => {
        if (!statusMatches(reconciliation.status, where["status"])) return { count: 0 };
        applyData(reconciliation, data);
        return { count: 1 };
      },
    },
    onchainAnchor: {
      findUnique: async ({ where }: { where: MutableRecord }) => anchorFor(where),
      findMany: async () => anchors,
      update: async ({ where, data }: { where: MutableRecord; data: MutableRecord }) => {
        const anchor = anchorFor(where);
        applyData(anchor, data);
        return anchor;
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: MutableRecord;
        data: MutableRecord;
      }) => {
        const anchor = anchors.find((candidate) =>
          typeof where["id"] === "string"
            ? candidate.id === where["id"]
            : candidate["purchaseId"] === where["purchaseId"] && candidate.kind === where["kind"],
        );
        if (!anchor) return { count: 0 };
        if (!statusMatches(anchor.status, where["status"])) return { count: 0 };
        if (
          typeof where["retryClaimId"] === "string" &&
          anchor.retryClaimId !== where["retryClaimId"]
        ) {
          return { count: 0 };
        }
        if (Array.isArray(where["OR"]) && anchor.retryClaimId !== null) {
          return { count: 0 };
        }
        applyData(anchor, data);
        return { count: 1 };
      },
    },
    auditEvent: {
      create: async ({ data }: { data: MutableRecord }) => {
        state.events.push(data);
        return data;
      },
    },
  };
  return { prisma: client as unknown as PrismaClient, state };
}

function createWorkflow(
  prisma: PrismaClient,
  anchorClient: AuditAnchorClient,
  paymentProvider: PaymentProvider,
  invoiceAdapter: { issue?: ReturnType<typeof vi.fn> } = {},
): PurchaseWorkflow {
  return new PurchaseWorkflow({
    prisma,
    config: loadConfig({
      DATABASE_URL: "postgresql://localhost/mello_test",
      ERC3009_AUTH_TTL_SECONDS: "3600",
    }),
    agent: {} as never,
    paymentProvider,
    invoiceAdapter: invoiceAdapter as never,
    anchorClient,
    logger: { error: vi.fn() } as never,
    now: () => NOW,
  });
}

function inertPaymentProvider(): PaymentProvider {
  return {
    mode: "mock",
    getAddress: async () => BUYER,
    prepare: vi.fn(async () => {
      throw new Error("prepare should not be called");
    }),
  };
}

function authorizationInput() {
  return {
    id: PURCHASE_ID,
    buyerAddress: BUYER,
    payToAddress: SELLER,
    tokenAddress: BASE_SEPOLIA_USDC,
    maxAmountAtomic: "100000",
    expiresAt: new Date("2030-01-01T00:10:00.000Z"),
    mandateHash: bytes32("1"),
    policyHash: bytes32("2"),
    paymentAuthorizationHash: bytes32("3"),
  };
}

const VALIDATED_TERMS = {
  scheme: "exact" as const,
  network: MELLO_NETWORK,
  tokenAddress: BASE_SEPOLIA_USDC,
  tokenSymbol: "USDC" as const,
  tokenDecimals: 6 as const,
  payToAddress: SELLER,
  amountAtomic: "100000",
  transferMethod: "eip3009" as const,
  facilitatorUrl: "https://x402.org/facilitator",
};

describe("purchase workflow anchor recovery", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("persists SUBMITTED before receipt polling and reconciles a timeout without resending", async () => {
    const { prisma, state } = createHarness();
    const transactionHash = bytes32("4");
    const authorizePurchase = vi.fn(
      async (_input: AuthorizePurchaseInput, options?: AnchorSubmissionOptions) => {
        await options?.onSubmitted?.(transactionHash);
        throw new Error("receipt timeout");
      },
    );
    const reconcileTransaction = vi.fn(async () => ({
      transactionHash,
      blockNumber: 88n,
      chainId: 84_532,
    }));
    const anchorClient: AuditAnchorClient = {
      mode: "onchain",
      authorizePurchase,
      finalizePurchase: vi.fn(),
      markFailed: vi.fn(),
      reconcileTransaction,
      getPurchaseState: vi.fn(async () => ({
        status: "NONE" as const,
        paymentAuthorizationHash: bytes32("0"),
      })),
      hasContractCode: vi.fn(async () => true),
    };
    const workflow = createWorkflow(prisma, anchorClient, inertPaymentProvider());
    const authorizeAnchor = (
      workflow as unknown as {
        authorizeAnchor(input: ReturnType<typeof authorizationInput>): Promise<boolean>;
      }
    ).authorizeAnchor.bind(workflow);

    await expect(authorizeAnchor(authorizationInput())).resolves.toBe(false);
    expect(state.anchors[0]).toMatchObject({
      status: "FAILED_RETRYABLE",
      transactionHash,
    });
    await expect(authorizeAnchor(authorizationInput())).resolves.toBe(true);
    expect(authorizePurchase).toHaveBeenCalledOnce();
    expect(reconcileTransaction).toHaveBeenCalledOnce();
    expect(reconcileTransaction).toHaveBeenCalledWith(transactionHash);
    expect(state.anchors[0]).toMatchObject({
      status: "CONFIRMED",
      transactionHash,
      blockNumber: 88n,
    });
  });

  it("refuses to confirm an on-chain anchor receipt from the wrong chain", async () => {
    const { prisma, state } = createHarness();
    const transactionHash = bytes32("7");
    const anchorClient: AuditAnchorClient = {
      mode: "onchain",
      authorizePurchase: vi.fn(async (_input, options) => {
        await options?.onSubmitted?.(transactionHash);
        return { transactionHash, blockNumber: 42n, chainId: 1 };
      }),
      finalizePurchase: vi.fn(),
      markFailed: vi.fn(),
      reconcileTransaction: vi.fn(),
      getPurchaseState: vi.fn(async () => ({
        status: "NONE" as const,
        paymentAuthorizationHash: bytes32("0"),
      })),
      hasContractCode: vi.fn(async () => true),
    };
    const workflow = createWorkflow(prisma, anchorClient, inertPaymentProvider());
    const authorizeAnchor = (
      workflow as unknown as {
        authorizeAnchor(input: ReturnType<typeof authorizationInput>): Promise<boolean>;
      }
    ).authorizeAnchor.bind(workflow);

    await expect(authorizeAnchor(authorizationInput())).resolves.toBe(false);
    expect(state.anchors[0]).toMatchObject({
      status: "FAILED_RETRYABLE",
      transactionHash,
    });
    expect(state.anchors[0]?.["blockNumber"]).toBeUndefined();
    expect(
      state.events.some((event) => event["eventType"] === "AUTHORIZATION_ANCHOR_CONFIRMED"),
    ).toBe(false);
  });

  it("renegotiates a fresh authorization after a pre-submission failure and completes", async () => {
    const { prisma, state } = createHarness();
    const authorization = recordSignedAuthorization({
      purchaseId: PURCHASE_ID,
      paymentId: PAYMENT_ID,
      network: MELLO_NETWORK,
      tokenAddress: BASE_SEPOLIA_USDC,
      from: BUYER,
      to: SELLER,
      value: "100000",
      validAfter: String(Math.floor(NOW.getTime() / 1_000) - 1),
      validBefore: String(Math.floor(NOW.getTime() / 1_000) + 300),
      nonce: bytes32("b"),
      signature: `0x${"1".repeat(130)}`,
      eip712Name: "USDC",
      eip712Version: "2",
    });
    const prepared: PreparedPayment = {
      authorization,
      authorizationHash: authorizationEvidenceHash(authorization),
      paymentRequired: { x402Version: 2 },
      validatedTerms: VALIDATED_TERMS,
      cancel: vi.fn(),
      submit: vi.fn(async (hooks?: PaymentSubmissionHooks) => {
        await hooks?.onBeforePaidRequest?.();
        await hooks?.onPaidRequestReleased?.();
        return {
          paymentId: PAYMENT_ID,
          transactionHash: bytes32("5"),
          payerAddress: BUYER,
          payeeAddress: SELLER,
          amountAtomic: "100000",
          network: MELLO_NETWORK,
          tokenAddress: BASE_SEPOLIA_USDC,
          paymentResponse: { success: true },
          report: {
            reportId: "report-1",
            provider: "seller-b",
            targetCompanyName: "Example Co.",
            riskScore: 20,
            riskLevel: "LOW" as const,
            summary: "Low risk",
            generatedAt: NOW.toISOString(),
          },
        };
      }),
    };
    const prepare = vi.fn(async () => prepared);
    const paymentProvider: PaymentProvider = {
      mode: "x402",
      getAddress: async () => BUYER,
      prepare,
    };
    const workflow = createWorkflow(prisma, new MockAuditAnchorClient(), paymentProvider);

    await workflow.retryAnchor(PURCHASE_ID, "retry-auth");

    expect(prepare).toHaveBeenCalledOnce();
    expect(prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        purchaseId: PURCHASE_ID,
        paymentId: PAYMENT_ID,
        authorizationTtlSeconds: 3_600,
        maximumValidBefore:
          BigInt(Math.floor(state.purchase.expiresAt.getTime() / 1_000)) - 30n,
      }),
    );
    expect(state.authorization.nonce).toBe(bytes32("b"));
    expect(state.authorization.nonce).not.toBe(bytes32("a"));
    expect(state.authorizationNonces.map((record) => record["nonce"])).toEqual([
      bytes32("a"),
      bytes32("b"),
    ]);
    expect(state.purchase.paymentAuthorizationHash).toBe(prepared.authorizationHash);
    expect(prepared.submit).toHaveBeenCalledOnce();
    expect(state.payment.status).toBe("SETTLED");
    expect(state.anchors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "AUTHORIZE", status: "CONFIRMED" }),
        expect.objectContaining({ kind: "FINALIZE", status: "CONFIRMED" }),
      ]),
    );
    expect(state.purchase.status).toBe("COMPLETED");
    expect(state.task.status).toBe("COMPLETED");
    expect(state.events.some((event) => event["eventType"] === "AUTHORIZATION_RENEGOTIATED")).toBe(
      true,
    );
    const lifecycle = [
      "AUTHORIZATION_CREATED",
      "AUTHORIZATION_SIGNED",
      "PAYMENT_SUBMISSION_INTENT_RECORDED",
      "PAID_REQUEST_RELEASE_AUTHORIZED",
      "SUBMITTED_TO_SELLER",
      "SIGNED_PAID_REQUEST_RELEASED",
      "FACILITATOR_VERIFYING",
      "FACILITATOR_SETTLING",
      "PAYMENT_SETTLEMENT_AND_DELIVERY_CONFIRMED",
      "INVOICING_STARTED",
      "RECONCILIATION_STARTED",
    ];
    expect(
      state.events
        .map((event) => String(event["eventType"]))
        .filter((eventType) => lifecycle.includes(eventType)),
    ).toEqual(lifecycle);
    expect(
      state.events.find((event) => event["eventType"] === "PAID_REQUEST_RELEASE_AUTHORIZED")?.[
        "payload"
      ],
    ).toMatchObject({
      mode: "x402",
      boundary: "BEFORE_SIGNED_PAID_REQUEST_RELEASE",
      paidRequestReleased: false,
    });
    expect(
      state.events.find((event) => event["eventType"] === "SIGNED_PAID_REQUEST_RELEASED")?.[
        "payload"
      ],
    ).toMatchObject({
      mode: "x402",
      boundary: "SIGNED_PAID_REQUEST_RELEASED",
      paidRequestReleased: true,
    });
    expect(
      state.events.find((event) => event["eventType"] === "FACILITATOR_SETTLING")?.[
        "payload"
      ],
    ).toMatchObject({
      receiptIndependentlyVerified: true,
      recovered: false,
      observation: "RETROSPECTIVE_FROM_X402_SUCCESS_AND_VERIFIED_RECEIPT",
    });
  });

  it("rejects changed retry payee terms before creating a fresh signature", async () => {
    const { prisma, state } = createHarness();
    const maliciousPayee =
      "0x3333333333333333333333333333333333333333" as const;
    let signatureAttempted = false;
    const prepare = vi.fn(async (input: PreparePaymentInput) => {
      await input.onLivePaymentTerms?.({
        ...VALIDATED_TERMS,
        payToAddress: maliciousPayee,
      });
      signatureAttempted = true;
      throw new Error("Retry policy unexpectedly allowed signing");
    });
    const workflow = createWorkflow(prisma, new MockAuditAnchorClient(), {
      mode: "x402",
      getAddress: async () => BUYER,
      prepare,
    });

    await workflow.retryAnchor(PURCHASE_ID, "retry-malicious-payee");

    expect(prepare).toHaveBeenCalledOnce();
    expect(signatureAttempted).toBe(false);
    expect(state.task).toMatchObject({
      status: "REJECTED",
      errorCode: "POLICY_REJECTED",
    });
    expect(state.purchase.status).toBe("FAILED");
    expect(state.payment.status).toBe("FAILED");
    expect(state.authorization["status"]).toBe("REJECTED");
    expect(
      state.events.find((event) => event["eventType"] === "POLICY_REJECTED")?.[
        "payload"
      ],
    ).toMatchObject({
      approved: false,
      reasonCodes: ["PAY_TO_ADDRESS_MISMATCH"],
      retry: true,
      paymentCreated: false,
      rejectedBeforeSigning: true,
      livePaymentTerms: { payToAddress: maliciousPayee },
    });
  });

  it("reconciles a submitted finalization and completes without writing another transaction", async () => {
    const transactionHash = bytes32("6");
    const { prisma, state } = createHarness({
      authorizeStatus: "CONFIRMED",
      finalizeStatus: "FAILED_RETRYABLE",
      finalizeHash: transactionHash,
      paymentStatus: "SETTLED",
    });
    state.payment.transactionHash = bytes32("5");
    state.purchase.actualAmountAtomic = "100000";
    state.delivery.status = "DELIVERED";
    state.delivery.responseHash = bytes32("7");
    state.reconciliation.status = "MATCHED";
    state.reconciliation.canonicalHash = bytes32("8");
    const finalizePurchase = vi.fn();
    const reconcileTransaction = vi.fn(async () => ({
      transactionHash,
      blockNumber: 99n,
      chainId: 84_532,
    }));
    const anchorClient: AuditAnchorClient = {
      mode: "onchain",
      authorizePurchase: vi.fn(),
      finalizePurchase,
      markFailed: vi.fn(),
      reconcileTransaction,
      getPurchaseState: vi.fn(async () => ({
        status: "FINALIZED" as const,
        paymentAuthorizationHash: bytes32("3"),
      })),
      hasContractCode: vi.fn(async () => true),
    };
    const workflow = createWorkflow(prisma, anchorClient, inertPaymentProvider());

    await workflow.retryAnchor(PURCHASE_ID, "retry-final");

    expect(reconcileTransaction).toHaveBeenCalledWith(transactionHash);
    expect(finalizePurchase).not.toHaveBeenCalled();
    expect(state.anchors[1]).toMatchObject({
      status: "CONFIRMED",
      transactionHash,
      blockNumber: 99n,
    });
    expect(state.purchase.status).toBe("COMPLETED");
    expect(state.task.status).toBe("COMPLETED");
  });

  it("keeps an ambiguous submission pending for reconciliation and never resubmits", async () => {
    const { prisma, state } = createHarness();
    const authorization = recordSignedAuthorization({
      purchaseId: PURCHASE_ID,
      paymentId: PAYMENT_ID,
      network: MELLO_NETWORK,
      tokenAddress: BASE_SEPOLIA_USDC,
      from: BUYER,
      to: SELLER,
      value: "100000",
      validAfter: String(Math.floor(NOW.getTime() / 1_000) - 1),
      validBefore: String(Math.floor(NOW.getTime() / 1_000) + 300),
      nonce: bytes32("e"),
      signature: `0x${"2".repeat(130)}`,
      eip712Name: "USDC",
      eip712Version: "2",
    });
    const submit = vi.fn(async (hooks?: PaymentSubmissionHooks) => {
      await hooks?.onBeforePaidRequest?.();
      await hooks?.onPaidRequestReleased?.();
      throw new TypeError("settlement response was lost");
    });
    const paymentProvider: PaymentProvider = {
      mode: "x402",
      getAddress: async () => BUYER,
      prepare: vi.fn(async () => ({
        authorization,
        authorizationHash: authorizationEvidenceHash(authorization),
        paymentRequired: { x402Version: 2 },
        validatedTerms: VALIDATED_TERMS,
        cancel: vi.fn(),
        submit,
      })),
    };
    const workflow = createWorkflow(prisma, new MockAuditAnchorClient(), paymentProvider);

    await workflow.retryAnchor(PURCHASE_ID, "retry-ambiguous-settlement");

    expect(submit).toHaveBeenCalledOnce();
    expect(state.payment.status).toBe("SETTLEMENT_PENDING");
    expect(state.authorization["status"]).toBe("SUBMITTED");
    expect(state.reconciliation.status).toBe("PENDING");
    expect(state.purchase.status).toBe("ACTION_REQUIRED");
    expect(state.task).toMatchObject({
      status: "ACTION_REQUIRED",
      errorCode: "X402_PAYMENT_FAILED",
    });
    const pending = state.events.find(
      (event) =>
        event["eventType"] === "PENDING_RECONCILIATION" &&
        (event["payload"] as MutableRecord | undefined)?.["settlementOutcome"] === "UNKNOWN",
    );
    expect(pending?.["payload"]).toMatchObject({
      paymentStatus: "SETTLEMENT_PENDING",
      authorizationStatus: "SUBMITTED",
      automaticResubmissionAllowed: false,
    });
    expect(state.events.some((event) => event["eventType"] === "SIGNED_PAID_REQUEST_RELEASED")).toBe(
      true,
    );
    expect(
      state.events.some(
        (event) => event["eventType"] === "PAYMENT_SETTLEMENT_AND_DELIVERY_CONFIRMED",
      ),
    ).toBe(
      false,
    );
  });

  it("retains a seller-reported transaction while receipt verification remains pending", async () => {
    const { prisma, state } = createHarness();
    const candidateTransactionHash = bytes32("d");
    const authorization = recordSignedAuthorization({
      purchaseId: PURCHASE_ID,
      paymentId: PAYMENT_ID,
      network: MELLO_NETWORK,
      tokenAddress: BASE_SEPOLIA_USDC,
      from: BUYER,
      to: SELLER,
      value: "100000",
      validAfter: String(Math.floor(NOW.getTime() / 1_000) - 1),
      validBefore: String(Math.floor(NOW.getTime() / 1_000) + 300),
      nonce: bytes32("f"),
      signature: `0x${"3".repeat(130)}`,
      eip712Name: "USDC",
      eip712Version: "2",
    });
    const paymentResponse = {
      success: true,
      transaction: candidateTransactionHash,
      network: MELLO_NETWORK,
    };
    const submit = vi.fn(async (hooks?: PaymentSubmissionHooks) => {
      await hooks?.onBeforePaidRequest?.();
      await hooks?.onPaidRequestReleased?.();
      throw new PendingSettlementVerificationError(
        "receipt RPC timed out",
        {
          paymentId: PAYMENT_ID,
          transactionHash: candidateTransactionHash,
          payerAddress: BUYER,
          payeeAddress: SELLER,
          amountAtomic: "100000",
          network: MELLO_NETWORK,
          tokenAddress: BASE_SEPOLIA_USDC,
          paymentResponse,
          report: REPORT,
        },
        new Error("RPC timeout"),
      );
    });
    const paymentProvider: PaymentProvider = {
      mode: "x402",
      getAddress: async () => BUYER,
      prepare: vi.fn(async () => ({
        authorization,
        authorizationHash: authorizationEvidenceHash(authorization),
        paymentRequired: { x402Version: 2 },
        validatedTerms: VALIDATED_TERMS,
        cancel: vi.fn(),
        submit,
      })),
    };
    const workflow = createWorkflow(prisma, new MockAuditAnchorClient(), paymentProvider);

    await workflow.retryAnchor(PURCHASE_ID, "retry-unverified-receipt");

    expect(state.payment).toMatchObject({
      status: "SETTLEMENT_PENDING",
      transactionHash: candidateTransactionHash,
      paymentResponse,
      payerAddress: BUYER,
      payeeAddress: SELLER,
      amountAtomic: "100000",
    });
    expect(state.authorization["status"]).toBe("SUBMITTED");
    expect(state.purchase.status).toBe("ACTION_REQUIRED");
    expect(state.delivery).toMatchObject({ status: "PENDING", responseBody: REPORT });
    expect(
      state.events.find(
        (event) =>
          event["eventType"] === "PENDING_RECONCILIATION" &&
          (event["payload"] as MutableRecord | undefined)?.["candidateTransactionHash"] ===
            candidateTransactionHash,
      )?.["payload"],
    ).toMatchObject({
      receiptIndependentlyVerified: false,
      automaticResubmissionAllowed: false,
    });
  });

  it("independently reconciles a stored candidate exactly once without preparing or submitting", async () => {
    const candidateTransactionHash = bytes32("d");
    const { prisma, state } = createHarness({
      authorizeStatus: "CONFIRMED",
      paymentStatus: "SETTLEMENT_PENDING",
    });
    Object.assign(state.payment, {
      transactionHash: candidateTransactionHash,
      paymentResponse: { success: true, transaction: candidateTransactionHash },
      payerAddress: BUYER,
      payeeAddress: SELLER,
      amountAtomic: "100000",
      network: MELLO_NETWORK,
      tokenAddress: BASE_SEPOLIA_USDC,
    });
    Object.assign(state.authorization, {
      paymentId: PAYMENT_ID,
      amountAtomic: "100000",
      fromAddress: BUYER,
      toAddress: SELLER,
      network: MELLO_NETWORK,
      tokenAddress: BASE_SEPOLIA_USDC,
      status: "SUBMITTED",
      settlementTxHash: null,
    });
    Object.assign(state.delivery, { status: "PENDING", responseBody: REPORT });
    const prepare = vi.fn();
    const verifySettlement = vi.fn(async () => ({ verifiedChainId: 84_532 }));
    const finalizeTransactionHash = bytes32("7");
    const anchorClient: AuditAnchorClient = {
      mode: "onchain",
      authorizePurchase: vi.fn(),
      finalizePurchase: vi.fn(async (_input, options) => {
        await options?.onSubmitted?.(finalizeTransactionHash);
        return {
          transactionHash: finalizeTransactionHash,
          blockNumber: 101n,
          chainId: 84_532,
        };
      }),
      markFailed: vi.fn(),
      reconcileTransaction: vi.fn(),
      getPurchaseState: vi.fn(async () => ({
        status: "AUTHORIZED" as const,
        paymentAuthorizationHash: bytes32("3"),
      })),
      hasContractCode: vi.fn(async () => true),
    };
    const workflow = createWorkflow(prisma, anchorClient, {
      mode: "x402",
      getAddress: async () => BUYER,
      prepare,
      verifySettlement,
    });

    await workflow.reconcilePayment(PURCHASE_ID, "operator-reconcile");
    await workflow.reconcilePayment(PURCHASE_ID, "operator-reconcile-again");

    expect(verifySettlement).toHaveBeenCalledOnce();
    expect(verifySettlement).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentId: PAYMENT_ID,
        transactionHash: candidateTransactionHash,
        payerAddress: BUYER,
        payeeAddress: SELLER,
        amountAtomic: "100000",
      }),
    );
    expect(prepare).not.toHaveBeenCalled();
    expect(state.payment).toMatchObject({
      status: "SETTLED",
      transactionHash: candidateTransactionHash,
    });
    expect(state.authorization).toMatchObject({
      status: "SETTLED",
      settlementTxHash: candidateTransactionHash,
    });
    expect(state.delivery).toMatchObject({ status: "DELIVERED", responseBody: REPORT });
    expect(state.reconciliation.status).toBe("MATCHED");
    expect(state.purchase).toMatchObject({
      status: "COMPLETED",
      actualAmountAtomic: "100000",
    });
    expect(state.task).toMatchObject({
      status: "COMPLETED",
      errorCode: null,
    });
    expect(
      state.events.filter((event) => event["eventType"] === "PAYMENT_SETTLEMENT_RECONCILED"),
    ).toHaveLength(1);
  });

  it("records and preserves a pending-settlement evidence mismatch without verifying the chain", async () => {
    const candidateTransactionHash = bytes32("d");
    const { prisma, state } = createHarness({ paymentStatus: "SETTLEMENT_PENDING" });
    Object.assign(state.payment, {
      transactionHash: candidateTransactionHash,
      paymentResponse: { success: true, transaction: candidateTransactionHash },
      payerAddress: BUYER,
      payeeAddress: BUYER,
      amountAtomic: "100000",
      network: MELLO_NETWORK,
      tokenAddress: BASE_SEPOLIA_USDC,
    });
    Object.assign(state.authorization, {
      paymentId: PAYMENT_ID,
      amountAtomic: "100000",
      fromAddress: BUYER,
      toAddress: SELLER,
      network: MELLO_NETWORK,
      tokenAddress: BASE_SEPOLIA_USDC,
      status: "SUBMITTED",
      settlementTxHash: null,
    });
    const verifySettlement = vi.fn(async () => ({ verifiedChainId: 84_532 }));
    const workflow = createWorkflow(prisma, new MockAuditAnchorClient(), {
      mode: "x402",
      getAddress: async () => BUYER,
      prepare: vi.fn(),
      verifySettlement,
    });

    await workflow.reconcilePayment(PURCHASE_ID, "operator-mismatch");
    const preservedChecks = state.reconciliation["checks"];
    const preservedHash = state.reconciliation.canonicalHash;

    expect(verifySettlement).not.toHaveBeenCalled();
    expect(state.reconciliation.status).toBe("MISMATCH");
    expect(preservedChecks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "SETTLED_PAYEE_MATCH", passed: false }),
      ]),
    );
    await expect(
      workflow.reconcilePayment(PURCHASE_ID, "operator-mismatch-again"),
    ).rejects.toMatchObject({ code: "RECONCILIATION_MISMATCH", statusCode: 409 });
    expect(state.reconciliation["checks"]).toBe(preservedChecks);
    expect(state.reconciliation.canonicalHash).toBe(preservedHash);
  });

  it("does not downgrade an existing mismatch when submission outcome becomes ambiguous", async () => {
    const { prisma, state } = createHarness();
    state.reconciliation.status = "MISMATCH";
    state.reconciliation.canonicalHash = bytes32("8");
    state.reconciliation["checks"] = [{ id: "SETTLED_AMOUNT_MATCH", passed: false }];
    const workflow = createWorkflow(prisma, new MockAuditAnchorClient(), inertPaymentProvider());
    const recordPending = (
      workflow as unknown as {
        recordPendingSettlementReconciliation(input: {
          taskId: string;
          purchaseId: string;
          paymentId: string;
          sellerId: string;
          error: unknown;
          paidRequestReleased: boolean;
          authorizationStatus: string;
          requestId: string;
        }): Promise<void>;
      }
    ).recordPendingSettlementReconciliation.bind(workflow);

    await recordPending({
      taskId: TASK_ID,
      purchaseId: PURCHASE_ID,
      paymentId: PAYMENT_ID,
      sellerId: "seller-b",
      error: new TypeError("response lost"),
      paidRequestReleased: true,
      authorizationStatus: "SIGNED",
      requestId: "preserve-mismatch",
    });

    expect(state.reconciliation).toMatchObject({
      status: "MISMATCH",
      canonicalHash: bytes32("8"),
      checks: [{ id: "SETTLED_AMOUNT_MATCH", passed: false }],
    });
    expect(
      state.events.find((event) => event["eventType"] === "PENDING_RECONCILIATION")?.[
        "payload"
      ],
    ).toMatchObject({ mismatchReportPreserved: true, reconciliationStatus: "MISMATCH" });
  });

  it("records a pre-release abort without claiming that payment was submitted", async () => {
    const { prisma, state } = createHarness({ paymentStatus: "SETTLEMENT_PENDING" });
    const workflow = createWorkflow(prisma, new MockAuditAnchorClient(), inertPaymentProvider());
    const recordPending = (
      workflow as unknown as {
        recordPendingSettlementReconciliation(input: {
          taskId: string;
          purchaseId: string;
          paymentId: string;
          sellerId: string;
          error: unknown;
          paidRequestReleased: boolean;
          authorizationStatus: string;
          requestId: string;
        }): Promise<void>;
      }
    ).recordPendingSettlementReconciliation.bind(workflow);

    await recordPending({
      taskId: TASK_ID,
      purchaseId: PURCHASE_ID,
      paymentId: PAYMENT_ID,
      sellerId: "seller-b",
      error: new Error("release authorization audit failed"),
      paidRequestReleased: false,
      authorizationStatus: "CREATED",
      requestId: "pre-release-abort",
    });

    expect(state.authorization["status"]).toBe("REJECTED");
    expect(state.payment.status).toBe("FAILED");
    expect(state.task.status).toBe("FAILED");
    expect(state.purchase.status).toBe("FAILED");
    expect(
      state.events.find(
        (event) => event["eventType"] === "PAYMENT_SUBMISSION_ABORTED_BEFORE_RELEASE",
      )?.["payload"],
    ).toMatchObject({
      settlementOutcome: "NOT_SUBMITTED",
      authorizationStatus: "REJECTED",
    });
    expect(state.events.some((event) => event["eventType"] === "AUTHORIZATION_REJECTED")).toBe(
      true,
    );
    expect(state.events.some((event) => event["eventType"] === "SIGNED_PAID_REQUEST_RELEASED")).toBe(
      false,
    );
  });

  it("stops safely when a confirmed authorization has lost its ephemeral signature", async () => {
    const transactionHash = bytes32("9");
    const { prisma, state } = createHarness({ authorizeHash: transactionHash });
    const prepare = vi.fn();
    const anchorClient: AuditAnchorClient = {
      mode: "onchain",
      authorizePurchase: vi.fn(),
      finalizePurchase: vi.fn(),
      markFailed: vi.fn(),
      reconcileTransaction: vi.fn(async () => ({
        transactionHash,
        blockNumber: 100n,
        chainId: 84_532,
      })),
      getPurchaseState: vi.fn(async () => ({
        status: "AUTHORIZED" as const,
        paymentAuthorizationHash: bytes32("3"),
      })),
      hasContractCode: vi.fn(async () => true),
    };
    const workflow = createWorkflow(prisma, anchorClient, {
      mode: "mock",
      getAddress: async () => BUYER,
      prepare,
    });

    await workflow.retryAnchor(PURCHASE_ID, "retry-lost-signature");

    expect(prepare).not.toHaveBeenCalled();
    expect(anchorClient.authorizePurchase).not.toHaveBeenCalled();
    expect(state.anchors[0]?.status).toBe("CONFIRMED");
    expect(state.purchase.status).toBe("ACTION_REQUIRED");
    expect(state.task).toMatchObject({
      status: "ACTION_REQUIRED",
      errorCode: "CONTRACT_ANCHOR_FAILED",
    });
    expect(String(state.task.errorMessage)).toContain("signature is no longer available");
    expect(
      state.events.some((event) => event["eventType"] === "AUTHORIZATION_SIGNATURE_UNAVAILABLE"),
    ).toBe(true);
  });

  it("preserves settled payment evidence and skips invoicing when paid delivery is invalid", async () => {
    const { prisma, state } = createHarness();
    const authorization = buildAuthorizationRecord({
      purchaseId: PURCHASE_ID,
      paymentId: PAYMENT_ID,
      network: MELLO_NETWORK,
      tokenAddress: BASE_SEPOLIA_USDC,
      from: BUYER,
      to: SELLER,
      value: "100000",
      ttlSeconds: 300,
      nowSeconds: BigInt(Math.floor(NOW.getTime() / 1_000)),
      nonce: bytes32("c"),
    });
    const settlement = {
      paymentId: PAYMENT_ID,
      transactionHash: bytes32("d"),
      payerAddress: BUYER,
      payeeAddress: SELLER,
      amountAtomic: "100000",
      network: MELLO_NETWORK,
      tokenAddress: BASE_SEPOLIA_USDC,
      paymentResponse: { success: true },
    };
    const prepared: PreparedPayment = {
      authorization,
      authorizationHash: authorizationEvidenceHash(authorization),
      paymentRequired: { x402Version: 2 },
      validatedTerms: VALIDATED_TERMS,
      cancel: vi.fn(),
      submit: vi.fn(async () => {
        throw new SettledPaymentDeliveryError(
          "SERVICE_DELIVERY_FAILED",
          "Settled response report was invalid",
          settlement,
        );
      }),
    };
    const paymentProvider: PaymentProvider = {
      mode: "mock",
      getAddress: async () => BUYER,
      prepare: vi.fn(async () => prepared),
    };
    const issue = vi.fn();
    const workflow = createWorkflow(
      prisma,
      new MockAuditAnchorClient(),
      paymentProvider,
      { issue },
    );

    await workflow.retryAnchor(PURCHASE_ID, "retry-invalid-delivery");

    expect(state.payment).toMatchObject({
      status: "SETTLED",
      transactionHash: settlement.transactionHash,
      amountAtomic: settlement.amountAtomic,
    });
    expect(state.authorization).toMatchObject({
      status: "SETTLED",
      settlementTxHash: settlement.transactionHash,
    });
    expect(state.delivery.status).toBe("FAILED");
    expect(state.purchase).toMatchObject({
      status: "ACTION_REQUIRED",
      actualAmountAtomic: settlement.amountAtomic,
    });
    expect(state.task).toMatchObject({
      status: "ACTION_REQUIRED",
      errorCode: "SERVICE_DELIVERY_FAILED",
    });
    expect(issue).not.toHaveBeenCalled();
    expect(state.anchors[1]?.status).toBe("NOT_STARTED");
    expect(
      state.events.some((event) => event["eventType"] === "PAYMENT_SETTLED_DELIVERY_FAILED"),
    ).toBe(true);
    expect(state.events.some((event) => event["eventType"] === "SIGNED_PAID_REQUEST_RELEASED")).toBe(
      false,
    );
    expect(
      state.events.some(
        (event) => event["eventType"] === "PAYMENT_SETTLEMENT_AND_DELIVERY_CONFIRMED",
      ),
    ).toBe(
      false,
    );
  });

  it("marks an expired pre-release authorization terminal without submitting it", async () => {
    const { prisma, state } = createHarness({ paymentStatus: "SETTLEMENT_PENDING" });
    const workflow = createWorkflow(prisma, new MockAuditAnchorClient(), inertPaymentProvider());
    const recordPending = (
      workflow as unknown as {
        recordPendingSettlementReconciliation(input: {
          taskId: string;
          purchaseId: string;
          paymentId: string;
          sellerId: string;
          error: unknown;
          paidRequestReleased: boolean;
          authorizationStatus: string;
          requestId: string;
        }): Promise<void>;
      }
    ).recordPendingSettlementReconciliation.bind(workflow);

    await recordPending({
      taskId: TASK_ID,
      purchaseId: PURCHASE_ID,
      paymentId: PAYMENT_ID,
      sellerId: "seller-b",
      error: new MelloError("ERC3009_AUTH_EXPIRED", "authorization expired"),
      paidRequestReleased: false,
      authorizationStatus: "SIGNED",
      requestId: "expired-before-release",
    });

    expect(state.authorization["status"]).toBe("EXPIRED");
    expect(state.payment.status).toBe("FAILED");
    expect(state.task.status).toBe("FAILED");
    expect(state.purchase.status).toBe("FAILED");
    expect(
      state.events.find((event) => event["eventType"] === "AUTHORIZATION_EXPIRED")?.[
        "payload"
      ],
    ).toMatchObject({
      errorCode: "ERC3009_AUTH_EXPIRED",
      previousStatus: "SIGNED",
      status: "EXPIRED",
      paidRequestReleased: false,
    });
  });

  it("durably fails the workflow before anchoring the hashed terminal reason", async () => {
    const { prisma, state } = createHarness({ authorizeStatus: "CONFIRMED" });
    state.task.status = "DELIVERING";
    state.purchase.status = "DELIVERING";
    const transactionHash = bytes32("f");
    const markFailed = vi.fn(
      async (
        _purchaseId: string,
        _reasonHash: `0x${string}`,
        options?: AnchorSubmissionOptions,
      ) => {
        await options?.onSubmitted?.(transactionHash);
        return { transactionHash, blockNumber: 91n, chainId: 84_532 };
      },
    );
    const anchorClient: AuditAnchorClient = {
      mode: "onchain",
      authorizePurchase: vi.fn(),
      finalizePurchase: vi.fn(),
      markFailed,
      reconcileTransaction: vi.fn(),
      getPurchaseState: vi.fn(async () => ({
        status: "AUTHORIZED" as const,
        paymentAuthorizationHash: bytes32("3"),
      })),
      hasContractCode: vi.fn(async () => true),
    };
    const workflow = createWorkflow(prisma, anchorClient, inertPaymentProvider());
    const failTask = (
      workflow as unknown as {
        failTask(taskId: string, error: unknown, requestId?: string): Promise<void>;
      }
    ).failTask.bind(workflow);

    await failTask(
      TASK_ID,
      new MelloError("SERVICE_DELIVERY_FAILED", "seller response invalid"),
      "terminal-failure",
    );

    expect(state.task).toMatchObject({
      status: "FAILED",
      errorCode: "SERVICE_DELIVERY_FAILED",
    });
    expect(state.purchase.status).toBe("FAILED");
    expect(state.anchors[2]).toMatchObject({
      kind: "FAIL",
      status: "CONFIRMED",
      transactionHash,
      blockNumber: 91n,
    });
    expect(markFailed).toHaveBeenCalledWith(
      PURCHASE_ID,
      hashCanonicalJson({
        schemaVersion: "1",
        kind: "PURCHASE_FAILURE",
        purchaseId: PURCHASE_ID,
        errorCode: "SERVICE_DELIVERY_FAILED",
      }),
      expect.objectContaining({ onSubmitted: expect.any(Function) }),
    );
    expect(state.events.map((event) => event["eventType"])).toEqual(
      expect.arrayContaining([
        "TASK_FAILED",
        "FAIL_ANCHOR_ATTEMPT_STARTED",
        "FAIL_ANCHOR_SUBMITTED",
        "FAILURE_ANCHOR_CONFIRMED",
      ]),
    );
    expect(
      state.events.findIndex((event) => event["eventType"] === "TASK_FAILED"),
    ).toBeLessThan(
      state.events.findIndex((event) => event["eventType"] === "FAIL_ANCHOR_ATTEMPT_STARTED"),
    );
  });

  it("retries a failed terminal anchor without reopening the failed purchase", async () => {
    const { prisma, state } = createHarness({
      authorizeStatus: "CONFIRMED",
      failStatus: "FAILED_RETRYABLE",
    });
    state.task.status = "FAILED";
    state.task.errorCode = "SERVICE_DELIVERY_FAILED";
    state.purchase.status = "FAILED";
    const transactionHash = bytes32("e");
    const markFailed = vi.fn(
      async (
        _purchaseId: string,
        _reasonHash: `0x${string}`,
        options?: AnchorSubmissionOptions,
      ) => {
        await options?.onSubmitted?.(transactionHash);
        return { transactionHash, blockNumber: 92n, chainId: 84_532 };
      },
    );
    const anchorClient: AuditAnchorClient = {
      mode: "onchain",
      authorizePurchase: vi.fn(),
      finalizePurchase: vi.fn(),
      markFailed,
      reconcileTransaction: vi.fn(),
      getPurchaseState: vi.fn(async () => ({
        status: "AUTHORIZED" as const,
        paymentAuthorizationHash: bytes32("3"),
      })),
      hasContractCode: vi.fn(async () => true),
    };
    const workflow = createWorkflow(prisma, anchorClient, inertPaymentProvider());

    await workflow.retryAnchor(PURCHASE_ID, "retry-failure-anchor");

    expect(markFailed).toHaveBeenCalledOnce();
    expect(state.task.status).toBe("FAILED");
    expect(state.purchase.status).toBe("FAILED");
    expect(state.anchors[2]).toMatchObject({
      status: "CONFIRMED",
      transactionHash,
      retryClaimId: null,
      retryClaimedAt: null,
    });
  });

  it("keeps a returned settlement pending for reconciliation when persistence fails", async () => {
    const { prisma, state } = createHarness({
      authorizeStatus: "CONFIRMED",
      paymentStatus: "AUTHORIZED",
      failSettlementPersistence: true,
    });
    state.task.status = "AUTH_ANCHOR_PENDING";
    state.purchase.status = "AUTH_ANCHOR_PENDING";
    const authorization = recordSignedAuthorization({
      purchaseId: PURCHASE_ID,
      paymentId: PAYMENT_ID,
      network: MELLO_NETWORK,
      tokenAddress: BASE_SEPOLIA_USDC,
      from: BUYER,
      to: SELLER,
      value: "100000",
      validAfter: String(Math.floor(NOW.getTime() / 1_000) - 1),
      validBefore: String(Math.floor(NOW.getTime() / 1_000) + 300),
      nonce: bytes32("a"),
      signature: `0x${"1".repeat(130)}`,
      eip712Name: "USDC",
      eip712Version: "2",
    });
    applyData(state.authorization, authorization);
    const prepared: PreparedPayment = {
      authorization,
      authorizationHash: authorizationEvidenceHash(authorization),
      paymentRequired: { x402Version: 2 },
      validatedTerms: VALIDATED_TERMS,
      cancel: vi.fn(),
      submit: vi.fn(async (hooks?: PaymentSubmissionHooks) => {
        await hooks?.onBeforePaidRequest?.();
        await hooks?.onPaidRequestReleased?.();
        return {
          paymentId: PAYMENT_ID,
          transactionHash: bytes32("d"),
          payerAddress: BUYER,
          payeeAddress: SELLER,
          amountAtomic: "100000",
          network: MELLO_NETWORK,
          tokenAddress: BASE_SEPOLIA_USDC,
          paymentResponse: { success: true },
          verifiedChainId: 84_532,
          report: REPORT,
        };
      }),
    };
    const markFailed = vi.fn();
    const anchorClient: AuditAnchorClient = {
      mode: "onchain",
      authorizePurchase: vi.fn(),
      finalizePurchase: vi.fn(),
      markFailed,
      reconcileTransaction: vi.fn(),
      getPurchaseState: vi.fn(async () => ({
        status: "AUTHORIZED" as const,
        paymentAuthorizationHash: bytes32("3"),
      })),
      hasContractCode: vi.fn(async () => true),
    };
    const workflow = createWorkflow(prisma, anchorClient, {
      mode: "x402",
      getAddress: async () => BUYER,
      prepare: vi.fn(),
    });
    const submit = (
      workflow as unknown as {
        submitPreparedPaymentAndContinue(input: {
          taskId: string;
          purchaseId: string;
          paymentId: string;
          sellerId: string;
          prepared: PreparedPayment;
          authorizationAnchorConfirmed: boolean;
          requestId: string;
        }): Promise<void>;
      }
    ).submitPreparedPaymentAndContinue.bind(workflow);
    const failTask = (
      workflow as unknown as {
        failTask(taskId: string, error: unknown, requestId?: string): Promise<void>;
      }
    ).failTask.bind(workflow);

    let persistenceError: unknown;
    try {
      await submit({
        taskId: TASK_ID,
        purchaseId: PURCHASE_ID,
        paymentId: PAYMENT_ID,
        sellerId: "seller-b",
        prepared,
        authorizationAnchorConfirmed: true,
        requestId: "settlement-persistence-failure",
      });
    } catch (error: unknown) {
      persistenceError = error;
    }
    expect(persistenceError).toBeInstanceOf(Error);
    await failTask(TASK_ID, persistenceError, "settlement-persistence-failure");

    expect(prepared.submit).toHaveBeenCalledOnce();
    expect(state.payment.status).toBe("SETTLEMENT_PENDING");
    expect(state.authorization["status"]).toBe("SUBMITTED");
    expect(state.task.status).toBe("ACTION_REQUIRED");
    expect(state.purchase.status).toBe("ACTION_REQUIRED");
    expect(state.anchors[2]?.status).toBe("NOT_STARTED");
    expect(markFailed).not.toHaveBeenCalled();
    expect(
      state.events.find((event) => event["eventType"] === "TASK_FAILURE_REQUIRES_ACTION")?.[
        "payload"
      ],
    ).toMatchObject({
      paymentMayHaveExecuted: true,
      authorizationMayHaveExecuted: true,
      automaticRepaymentAllowed: false,
    });
  });

  it("rejects a concurrently claimed anchor retry before preparing another payment", async () => {
    const { prisma, state } = createHarness();
    state.anchors[0]!.retryClaimId = "00000000-0000-4000-8000-000000000099";
    state.anchors[0]!.retryClaimedAt = NOW;
    const prepare = vi.fn();
    const workflow = createWorkflow(prisma, new MockAuditAnchorClient(), {
      mode: "mock",
      getAddress: async () => BUYER,
      prepare,
    });

    await expect(workflow.retryAnchor(PURCHASE_ID, "overlap")).rejects.toMatchObject({
      code: "CONTRACT_ANCHOR_FAILED",
      statusCode: 409,
    });
    expect(prepare).not.toHaveBeenCalled();
    expect(state.payment.status).toBe("AUTHORIZED");
  });
});
