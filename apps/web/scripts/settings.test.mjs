import assert from "node:assert/strict";
import { test } from "node:test";
import { companyFields, creditBalanceAtomic } from "../src/lib/settings.ts";

const health = () => ({ modes: { payment: "x402" }, checks: {
  baseRpc: { status: "ok", details: { chainId: 84532 } },
  buyerWallet: { status: "ok", details: { usdcBalanceAtomic: "1234567890123456789" } },
} });

test("credit keeps precise on-chain amounts and real zero", () => {
  assert.equal(creditBalanceAtomic(health()), "1234567890123456789");
  const zero = health();
  zero.checks.buyerWallet.details.usdcBalanceAtomic = "0";
  assert.equal(creditBalanceAtomic(zero), "0");
});

test("unavailable, simulated, malformed and wrong-chain balances never become credit", () => {
  assert.equal(creditBalanceAtomic(null), null);
  for (const mutate of [
    value => { value.modes.payment = "mock"; },
    value => { value.checks.buyerWallet.status = "degraded"; },
    value => { value.checks.buyerWallet.details.simulated = true; },
    value => { value.checks.baseRpc.status = "degraded"; },
    value => { value.checks.baseRpc.details.chainId = 1; },
    value => { value.checks.buyerWallet.details.usdcBalanceAtomic = "NaN"; },
    value => { delete value.checks.buyerWallet.details.usdcBalanceAtomic; },
  ]) {
    const value = health();
    mutate(value);
    assert.equal(creditBalanceAtomic(value), null);
  }
});

test("saving company details includes only editable fields and leaves invoice fallbacks empty", () => {
  const company = { id: "private-db-id", legalName: "Mello", businessId: "12345675", email: "finance@example.test", defaultCostCenter: "OPS" };
  const fields = companyFields(company);
  assert.equal(fields.invoiceEmail, "");
  assert.equal(fields.invoiceAddress, "");
  assert.equal(fields.email, company.email);
  assert.equal("id" in fields, false);
});
