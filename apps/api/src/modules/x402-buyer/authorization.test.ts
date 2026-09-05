import { describe, expect, it } from "vitest";
import {
  assertAuthorizationUsable,
  authorizationEvidenceHash,
  buildAuthorizationRecord,
  validatePaymentTerms,
} from "./authorization.js";

const baseInput = {
  purchaseId: "00000000-0000-4000-8000-000000000010",
  paymentId: "pay_00000000000000000000000000000010",
  network: "eip155:84532",
  tokenAddress: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  from: "0x9999999999999999999999999999999999999999",
  to: "0x2222222222222222222222222222222222222222",
  value: "50000",
  ttlSeconds: 300,
  nowSeconds: 1_700_000_000n,
  nonce: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
} as const;

describe("ERC-3009 authorization evidence", () => {
  it("creates a deterministic typed-data and evidence hash", () => {
    const first = buildAuthorizationRecord(baseInput);
    const second = buildAuthorizationRecord(baseInput);
    expect(first.typedDataHash).toBe(second.typedDataHash);
    expect(authorizationEvidenceHash(first)).toBe(authorizationEvidenceHash(second));
    expect(first.validBefore).toBe(1_700_000_300n);
  });

  it("rejects expired or already-settled authorizations", () => {
    const record = buildAuthorizationRecord(baseInput);
    expect(() => assertAuthorizationUsable(record, record.validBefore)).toThrow(/expired/i);
    expect(() => assertAuthorizationUsable({ ...record, status: "SETTLED" })).toThrow(
      /already settled/i,
    );
  });

  it("rejects wrong chain, token, recipient, or value before signing", () => {
    const approved = {
      network: baseInput.network,
      tokenAddress: baseInput.tokenAddress,
      from: baseInput.from,
      to: baseInput.to,
      value: baseInput.value,
    };
    expect(() =>
      validatePaymentTerms(approved, {
        ...approved,
        network: "eip155:1",
        tokenAddress: "0x1111111111111111111111111111111111111111",
        to: "0x3333333333333333333333333333333333333333",
        value: "50001",
      }),
    ).toThrow(/network, token, to, value/);
  });
});
