import { prisma } from "@mello/db";
import { CompanyProfileInputSchema, invoiceBuyerProfile } from "@mello/shared";
import { afterAll, describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";
import { PrismaCoreApiRepository } from "./prisma-core-api-repository.js";

describe.sequential("persisted company and invoice settings", () => {
  const repository = new PrismaCoreApiRepository(prisma, loadConfig({ DATABASE_URL: process.env["DATABASE_URL"]! }));
  afterAll(async () => prisma.$disconnect());

  it("round-trips invoice details, preserves omitted fields, and never partially saves invalid data", async () => {
    const original = CompanyProfileInputSchema.parse(await repository.getCompany());
    const company = { ...original, contactName: "設定測試聯絡人", phone: "02-12345678",
      address: "台北市信義區", invoiceEmail: "billing@example.test", invoiceAddress: "台北市大安區" };
    try {
      await repository.saveCompany(company);
      expect(await repository.getCompany()).toMatchObject(company);
      await repository.saveCompany({ legalName: company.legalName, businessId: company.businessId, email: company.email, defaultCostCenter: company.defaultCostCenter });
      expect(await repository.getCompany()).toMatchObject(company);

      await expect(repository.saveCompany({ ...company, legalName: "Must roll back", invoiceAddress: "x".repeat(256) })).rejects.toThrow();
      expect(await repository.getCompany()).toMatchObject(company);

      await repository.saveCompany({ ...company, invoiceEmail: "", invoiceAddress: "" });
      expect(invoiceBuyerProfile(CompanyProfileInputSchema.parse(await repository.getCompany())))
        .toMatchObject({ email: company.email, address: company.address });
    } finally {
      await repository.saveCompany(original);
    }
  });
});
