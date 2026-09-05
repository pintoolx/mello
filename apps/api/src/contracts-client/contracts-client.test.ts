import { describe, expect, it } from "vitest";
import {
  AnchorSubmissionPersistenceError,
  MockAuditAnchorClient,
  purchaseIdOnchain,
} from "./index.js";

describe("contracts client", () => {
  it("maps a purchase UUID to a deterministic bytes32 ID", () => {
    expect(purchaseIdOnchain("00000000-0000-4000-8000-000000000010")).toMatch(
      /^0x[a-f0-9]{64}$/,
    );
  });

  it("returns distinct deterministic mock anchor receipts", async () => {
    const client = new MockAuditAnchorClient();
    const common = {
      purchaseId: "00000000-0000-4000-8000-000000000010",
      buyer: "0x9999999999999999999999999999999999999999" as const,
      seller: "0x2222222222222222222222222222222222222222" as const,
      token: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as const,
      maxAmount: 50_000n,
      expiresAt: 1_800_000_000n,
      mandateHash: `0x${"1".repeat(64)}` as const,
      policyHash: `0x${"2".repeat(64)}` as const,
      paymentAuthorizationHash: `0x${"3".repeat(64)}` as const,
    };
    const first = await client.authorizePurchase(common);
    const second = await client.authorizePurchase({ ...common, purchaseId: `${common.purchaseId}-2` });
    expect(first.transactionHash).not.toBe(second.transactionHash);
    expect(second.blockNumber).toBe(2n);
  });

  it("publishes the transaction hash before returning its receipt", async () => {
    const client = new MockAuditAnchorClient();
    const submitted: string[] = [];
    const input = {
      purchaseId: "00000000-0000-4000-8000-000000000010",
      buyer: "0x9999999999999999999999999999999999999999" as const,
      seller: "0x2222222222222222222222222222222222222222" as const,
      token: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as const,
      maxAmount: 50_000n,
      expiresAt: 1_800_000_000n,
      mandateHash: `0x${"1".repeat(64)}` as const,
      policyHash: `0x${"2".repeat(64)}` as const,
      paymentAuthorizationHash: `0x${"3".repeat(64)}` as const,
    };

    const result = await client.authorizePurchase(input, {
      onSubmitted: async (hash) => {
        submitted.push(hash);
      },
    });

    expect(submitted).toEqual([result.transactionHash]);
  });

  it("preserves a submitted hash when the persistence callback fails", async () => {
    const client = new MockAuditAnchorClient();
    const input = {
      purchaseId: "00000000-0000-4000-8000-000000000010",
      buyer: "0x9999999999999999999999999999999999999999" as const,
      seller: "0x2222222222222222222222222222222222222222" as const,
      token: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as const,
      maxAmount: 50_000n,
      expiresAt: 1_800_000_000n,
      mandateHash: `0x${"1".repeat(64)}` as const,
      policyHash: `0x${"2".repeat(64)}` as const,
      paymentAuthorizationHash: `0x${"3".repeat(64)}` as const,
    };

    let submittedHash: `0x${string}` | undefined;
    try {
      await client.authorizePurchase(input, {
        onSubmitted: async () => {
          throw new Error("database unavailable");
        },
      });
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(AnchorSubmissionPersistenceError);
      submittedHash = (error as AnchorSubmissionPersistenceError).transactionHash;
    }

    expect(submittedHash).toBeDefined();
    await expect(client.reconcileTransaction(submittedHash!)).resolves.toMatchObject({
      transactionHash: submittedHash,
    });
  });
});
