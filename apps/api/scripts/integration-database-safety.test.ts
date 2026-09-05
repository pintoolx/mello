import { describe, expect, it } from "vitest";
import { assertSafeIntegrationDatabase } from "./integration-database-safety.js";

describe("integration database safety", () => {
  it.each([
    "postgresql://mello:mello@localhost:5432/mello?schema=public",
    "postgres://mello:mello@127.0.0.1:5432/mello_test",
    "postgresql://mello:mello@127.9.8.7:5432/local-mello",
    "postgresql://mello:mello@[::1]:5432/mello-integration",
  ])("accepts the documented or clearly named loopback database: %s", (databaseUrl) => {
    expect(() =>
      assertSafeIntegrationDatabase({ databaseUrl, databaseApproved: undefined }),
    ).not.toThrow();
  });

  it("allows a nonstandard database name only with the database-specific opt-in", () => {
    expect(() =>
      assertSafeIntegrationDatabase({
        databaseUrl: "postgresql://mello:mello@localhost:5432/scratch",
        databaseApproved: "true",
      }),
    ).not.toThrow();
  });

  it.each([
    "postgresql://mello:mello@db.example.com:5432/mello_test",
    "postgresql://mello:mello@10.0.0.5:5432/mello_test",
    "postgresql://mello:mello@127.example.com:5432/mello_test",
    "prisma+postgres://localhost:51213/?api_key=local",
  ])("refuses a non-loopback or unsupported database even with approval: %s", (databaseUrl) => {
    expect(() =>
      assertSafeIntegrationDatabase({ databaseUrl, databaseApproved: "true" }),
    ).toThrow("refuses every non-loopback");
  });

  it("does not treat the payment approval flag as database approval", () => {
    const paymentEnvironment = {
      MELLO_TESTNET_PAYMENT_APPROVED: "true",
      DATABASE_URL: "postgresql://mello:mello@localhost:5432/production",
    };

    expect(() =>
      assertSafeIntegrationDatabase({
        databaseUrl: paymentEnvironment.DATABASE_URL,
        databaseApproved:
          (paymentEnvironment as Record<string, string | undefined>)[
            "MELLO_INTEGRATION_DATABASE_APPROVED"
          ],
      }),
    ).toThrow("MELLO_INTEGRATION_DATABASE_APPROVED=true");
  });

  it.each([undefined, "not a URL", "mysql://localhost/mello"])(
    "refuses a missing or invalid target: %s",
    (databaseUrl) => {
      expect(() =>
        assertSafeIntegrationDatabase({ databaseUrl, databaseApproved: undefined }),
      ).toThrow("DATABASE_URL");
    },
  );
});
