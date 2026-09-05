import { PrismaClient } from "./generated/prisma/client.ts";

const globalForPrisma = globalThis as unknown as { melloPrisma?: PrismaClient };

export const prisma = globalForPrisma.melloPrisma ?? new PrismaClient();

if (process.env["NODE_ENV"] !== "production") {
  globalForPrisma.melloPrisma = prisma;
}

export * from "./generated/prisma/client.ts";
export * from "./generated/prisma/enums.ts";
