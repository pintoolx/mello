import { describe, expect, it } from "vitest";
import { MockInvoiceAdapter } from "./mock-invoice-adapter.js";

const input = {
  purchaseId: "00000000-0000-4000-8000-000000000010",
  buyerBusinessId: "12345675",
  sellerBusinessId: "24536806",
  sellerProfileId: "seller-b",
  sourceAmountAtomic: "50000",
  fxRateTwdPerUsdc: "32.0",
  itemName: "Example Co. 信用報告",
  paymentId: "pay_00000000000000000000000000000010",
  paymentTxHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  issuedAt: new Date("2026-09-04T04:00:00.000Z"),
};

describe("MockInvoiceAdapter", () => {
  it("issues an explicitly non-official deterministic invoice", async () => {
    const result = await new MockInvoiceAdapter().issue(input);
    expect(result.invoiceNumber).toMatch(/^DEMO-INV-20260904-[A-F0-9]{6}$/);
    expect(result.twdEquivalentMinor).toBe("160");
    expect(result.disclaimer).toContain("非正式統一發票");
  });

  it("fails once and succeeds on retry", async () => {
    const adapter = new MockInvoiceAdapter(true);
    await expect(adapter.issue(input)).rejects.toMatchObject({ retryable: true });
    await expect(adapter.issue(input)).resolves.toMatchObject({ status: "ISSUED_DEMO" });
  });
});
