import { describe, expect, it } from "vitest";
import { MockInvoiceAdapter } from "./mock-invoice-adapter.js";
import { loadConfig } from "../../config.js";

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
  it("issues an explicitly non-official deterministic invoice successfully on its first attempt", async () => {
    const adapter = new MockInvoiceAdapter();
    const result = await adapter.issue(input);
    expect(result.status).toBe("ISSUED_DEMO");
    expect(await adapter.getStatus(result.providerReference)).toBe("ISSUED_DEMO");
    expect(result.invoiceNumber).toMatch(/^DEMO-INV-20260904-[A-F0-9]{6}$/);
    expect(result.twdEquivalentMinor).toBe("160");
    expect(result.disclaimer).toContain("非正式統一發票");
  });

  it("uses first-attempt success for every new purchase with normal runtime configuration", async () => {
    const config = loadConfig({ DATABASE_URL: "postgresql://mello:mello@localhost:5432/mello_test" });
    const adapter = new MockInvoiceAdapter(config.MOCK_INVOICE_FAIL_ONCE);
    await expect(adapter.issue({ ...input, itemName: "總經分析" })).resolves.toMatchObject({ status: "ISSUED_DEMO", itemName: "總經分析" });
    await expect(adapter.issue({ ...input, purchaseId: "00000000-0000-4000-8000-000000000011", itemName: "加密市場資訊" }))
      .resolves.toMatchObject({ status: "ISSUED_DEMO", itemName: "加密市場資訊" });
  });

  it("fails once and succeeds on retry only when the fault is explicitly injected", async () => {
    const adapter = new MockInvoiceAdapter(true);
    await expect(adapter.issue(input)).rejects.toMatchObject({ retryable: true });
    await expect(adapter.issue(input)).resolves.toMatchObject({ status: "ISSUED_DEMO" });
  });

  it("binds the saved billing profile into invoice evidence", async () => {
    const adapter = new MockInvoiceAdapter();
    const buyerProfile = { legalName: "Company A", businessId: input.buyerBusinessId, email: "billing@example.test", address: "Taipei", contactName: "Finance", phone: "02-12345678" };
    const first = await adapter.issue({ ...input, buyerProfile });
    const same = await adapter.issue({ ...input, buyerProfile });
    const changed = await adapter.issue({ ...input, buyerProfile: { ...buyerProfile, email: "different@example.test" } });
    expect(first.canonicalHash).toBe(same.canonicalHash);
    expect(first.canonicalHash).not.toBe(changed.canonicalHash);
  });
});
