import type { Prisma, PrismaClient } from "@mello/db";
import { describe, expect, it } from "vitest";
import { WORKFLOW_QUEUE_ADVISORY_LOCK } from "../workflow-jobs/queue-lock.js";
import {
  assertPristineSellerRotationDrafts, rotateSellerWallets, sellerWalletRotationTargets,
  type SellerRotationDraft,
} from "./wallet-rotation.js";

const env = {
  SELLER_A_URL: "https://seller-a.example.com", SELLER_B_URL: "https://seller-b.example.com",
  SELLER_A_PREVIOUS_PAY_TO: "0x7C17F92a2686d2ee708F711e961675b8fB4Bd2C0",
  SELLER_B_PREVIOUS_PAY_TO: "0xc7f80159aEe4fEe2b4C53FfC068B0AB123a5eB36",
  SELLER_A_PAY_TO: "0xeD6C588900675849e43DFabd12Fad227F21a5E8E",
  SELLER_B_PAY_TO: "0x9e82d7Af834AaCC4777cAf6b00b4104cb661c5a8",
};

const pristineDraft: SellerRotationDraft = {
  status: "CREATED", purchase: null, runStartedAt: null, completedAt: null,
  intent: null, candidates: null, decisionSummary: null, errorCode: null, errorMessage: null,
  usedFallbackParser: false, control: null,
};
const pristineControl: NonNullable<SellerRotationDraft["control"]> = {
  expectedPayTo: null, pendingTerms: null, approvedTermsHash: null, approvedAt: null,
  paymentReleaseGrantedAt: null,
};

describe("pristine draft preservation during seller wallet rotation", () => {
  it("accepts untouched drafts with or without an initial control without changing them", () => {
    const drafts = [structuredClone(pristineDraft), { ...structuredClone(pristineDraft), control: {
      ...pristineControl, requestKey: "original-request", requestHash: "original-hash", approvalLimitAtomic: "50000",
    } }];
    const before = structuredClone(drafts);
    expect(() => assertPristineSellerRotationDrafts(drafts)).not.toThrow();
    expect(drafts).toEqual(before);
  });
  it.each<[string, Partial<SellerRotationDraft>]>([
    ["active status", { status: "EVALUATING" }], ["purchase", { purchase: { id: "existing-purchase" } }],
    ["started run", { runStartedAt: new Date() }], ["previous completion", { completedAt: new Date() }],
    ["intent", { intent: {} }], ["candidates", { candidates: [] }],
    ["decision", { decisionSummary: "" }], ["error code", { errorCode: "" }],
    ["error message", { errorMessage: "" }], ["previous fallback parser", { usedFallbackParser: true }],
  ])("refuses a CREATED-looking draft with %s evidence", (_name, change) => {
    expect(() => assertPristineSellerRotationDrafts([{ ...pristineDraft, ...change }])).toThrow("Existing work");
  });
  it.each<[string, Partial<NonNullable<SellerRotationDraft["control"]>>]>([
    ["pinned wallet", { expectedPayTo: env.SELLER_A_PREVIOUS_PAY_TO }],
    ["pending approval", { pendingTerms: {} }], ["approved terms", { approvedTermsHash: "original-terms" }],
    ["approval", { approvedAt: new Date() }], ["release permit", { paymentReleaseGrantedAt: new Date() }],
  ])("refuses a draft control with %s evidence", (_name, change) => {
    expect(() => assertPristineSellerRotationDrafts([{ ...pristineDraft, control: { ...pristineControl, ...change } }]))
      .toThrow("Existing work");
  });
  it("fails closed beyond the bounded review limit", () => {
    expect(() => assertPristineSellerRotationDrafts(Array.from({ length: 101 }, () => pristineDraft)))
      .toThrow("Too many existing drafts");
  });
});

describe("explicit seller wallet rotation targets", () => {
  it("bounds fetched task safety evidence and refuses an oversized batch before seller writes", async () => {
    let inspectedQuery: unknown;
    const transaction = {
      $queryRaw: async () => [], paymentControl: { findUnique: async () => ({ paymentsFrozen: true }) },
      workflowJob: { count: async () => 0 }, purchase: { count: async () => 0 },
      payment: { count: async () => 0 }, sellerPaymentCache: { count: async () => 0 },
      task: { findMany: async (query: unknown) => {
        inspectedQuery = query;
        return Array.from({ length: 101 }, () => pristineDraft);
      } },
    } as unknown as Prisma.TransactionClient;
    const database = {
      $transaction: async (action: (tx: Prisma.TransactionClient) => Promise<unknown>) => action(transaction),
    } as unknown as PrismaClient;
    await expect(rotateSellerWallets(database, { ...env, MELLO_ROTATE_SELLER_WALLETS: "true" }))
      .rejects.toThrow("Too many existing drafts");
    expect(inspectedQuery).toMatchObject({
      where: { status: { notIn: ["COMPLETED", "REJECTED", "FAILED"] } }, take: 101,
      select: { status: true, purchase: { select: { id: true } }, runStartedAt: true,
        control: { select: { expectedPayTo: true, pendingTerms: true, approvedAt: true, paymentReleaseGrantedAt: true } } },
    });
  });
  it("fences the workflow queue before service locks, the payment gate and control reads", async () => {
    const calls: { sql: string; values: unknown[] }[] = [];
    const transaction = {
      $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
        calls.push({ sql: strings.join("?"), values });
        return [];
      },
      paymentControl: { findUnique: async () => {
        calls.push({ sql: "read-payment-control", values: [] });
        return { paymentsFrozen: false };
      } },
    } as unknown as Prisma.TransactionClient;
    const database = {
      $transaction: async (action: (tx: Prisma.TransactionClient) => Promise<unknown>) => action(transaction),
    } as unknown as PrismaClient;
    await expect(rotateSellerWallets(database, { ...env, MELLO_ROTATE_SELLER_WALLETS: "true" }))
      .rejects.toThrow("Freeze new payments");
    expect(calls).toHaveLength(5);
    expect(calls[0]?.sql).toContain("pg_advisory_xact_lock(");
    expect(calls[0]?.values).toEqual([WORKFLOW_QUEUE_ADVISORY_LOCK]);
    expect(calls[1]?.values).toEqual(["mello:verification:credit-report-a"]);
    expect(calls[2]?.values).toEqual(["mello:verification:credit-report-b"]);
    expect(calls[3]?.sql).toContain("pg_advisory_xact_lock_shared(");
    expect(calls[3]?.values).toEqual(["mello:payment-release-gate"]);
    expect(calls[4]?.sql).toBe("read-payment-control");
  });
  it("skips without an exact opt-in and never accesses the database", async () => {
    for (const flag of [undefined, "false", "TRUE", "1"]) {
      expect(await rotateSellerWallets({} as PrismaClient, { MELLO_ROTATE_SELLER_WALLETS: flag }))
        .toEqual({ skipped: true, updated: [] });
    }
  });
  it("binds explicit old/new wallets to the two existing public demo services", () => {
    expect(sellerWalletRotationTargets(env)).toMatchObject([
      { id: "credit-report-a", sellerId: "seller-a", priceAtomic: "40000", payTo: env.SELLER_A_PAY_TO },
      { id: "credit-report-b", sellerId: "seller-b", priceAtomic: "50000", payTo: env.SELLER_B_PAY_TO },
    ]);
  });
  it.each(["SELLER_A_PREVIOUS_PAY_TO", "SELLER_B_PREVIOUS_PAY_TO", "SELLER_A_PAY_TO", "SELLER_B_PAY_TO"])(
    "refuses missing, invalid, zero or invalid-checksum %s", (key) => {
      for (const value of [undefined, "bad", `0x${"0".repeat(40)}`, "0xeD6c588900675849e43DFabd12Fad227F21a5E8E"]) {
        expect(() => sellerWalletRotationTargets({ ...env, [key]: value })).toThrow("explicit, nonzero EVM address");
      }
    },
  );
  it("refuses reused or cross-swapped wallets", () => {
    expect(() => sellerWalletRotationTargets({ ...env, SELLER_B_PAY_TO: env.SELLER_A_PAY_TO })).toThrow("distinct");
    expect(() => sellerWalletRotationTargets({ ...env, SELLER_A_PAY_TO: env.SELLER_A_PREVIOUS_PAY_TO })).toThrow("distinct");
    expect(() => sellerWalletRotationTargets({ ...env, SELLER_A_PAY_TO: env.SELLER_B_PREVIOUS_PAY_TO })).toThrow("distinct");
  });
  it("refuses private, altered-route or duplicate public endpoints", () => {
    for (const url of ["http://localhost:4011", "https://seller-a.railway.internal", "https://seller-a.example.com/other"]) {
      expect(() => sellerWalletRotationTargets({ ...env, SELLER_A_URL: url })).toThrow();
    }
    expect(() => sellerWalletRotationTargets({ ...env, SELLER_B_URL: env.SELLER_A_URL })).toThrow("distinct");
  });
});
