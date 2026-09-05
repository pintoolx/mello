import assert from "node:assert/strict";
import { test } from "node:test";
import { atomicAmount, readPendingRequest } from "../src/lib/task-input.ts";

test("USDC conversion preserves six decimals without floating point", () => {
  assert.equal(atomicAmount("0.03"), "30000");
  assert.equal(atomicAmount("0.000001"), "1");
  assert.equal(atomicAmount("1000000.999999"), "1000000999999");
  assert.equal(atomicAmount("0"), "0");
  for (const invalid of ["-1", "NaN", "1e-6", "0.0000001", "Infinity", ""])
    assert.throws(() => atomicAmount(invalid));
});

test("pending legacy and current requests recover the original key and controls", () => {
  const original = {
    prompt: "信用報告，預算 0.10 USDC",
    requestKey: "8a7c6824-18cd-4f1d-9732-eab64145e11c",
    approvalLimitAtomic: "30000",
    expectedPayTo: "0x0000000000000000000000000000000000000001",
  };
  assert.deepEqual(
    readPendingRequest({ getItem: () => JSON.stringify(original) }),
    original,
  );
  assert.equal(readPendingRequest({ getItem: () => null }), null);
});

test("corrupt pending records are never silently discarded", () => {
  for (const value of [
    "{",
    "null",
    "42",
    '{"prompt":"x"}',
    JSON.stringify({
      prompt: "x",
      requestKey: "a".repeat(20),
      approvalLimitAtomic: 30000,
    }),
  ])
    assert.throws(() => readPendingRequest({ getItem: () => value }));
  assert.throws(() =>
    readPendingRequest({
      getItem: () => {
        throw new Error("Storage blocked");
      },
    }),
  );
});

test("a lost create response preserves all four requirement combinations", () => {
  for (const requiresTwInvoice of [true, false]) for (const requiresRegistryCertification of [true, false]) {
    const input = { prompt: "信用報告，預算 0.10 USDC", requestKey: "survey-request-key-1",
      requirements: { requiresTwInvoice, requiresRegistryCertification } };
    assert.deepEqual(readPendingRequest({ getItem: () => JSON.stringify(input) }), input);
  }
  assert.throws(() => readPendingRequest({ getItem: () => JSON.stringify({
    prompt: "信用報告", requestKey: "survey-request-key-1", requirements: { requiresTwInvoice: "false" },
  }) }));
});
