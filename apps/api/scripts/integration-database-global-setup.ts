import { assertSafeIntegrationDatabase } from "./integration-database-safety.js";
import { prisma } from "../src/db/index.js";
import { seedDemo } from "../src/db/seed.js";

export default async function setup(): Promise<void> {
  assertSafeIntegrationDatabase({
    databaseUrl: process.env["DATABASE_URL"],
    databaseApproved: process.env["MELLO_INTEGRATION_DATABASE_APPROVED"],
  });
  try {
    await seedDemo(prisma);
  } finally {
    await prisma.$disconnect();
  }
}
