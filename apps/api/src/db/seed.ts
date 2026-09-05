import "dotenv/config";
import { PrismaClient } from "./generated/prisma/client.ts";
import { seedCompany, seedPolicy, seedSellers, seedServices } from "./seed-data.js";

export async function seedDemo(prisma: PrismaClient): Promise<void> {
  await prisma.$transaction(async (transaction) => {
    await transaction.companyProfile.upsert({
      where: { id: seedCompany.id },
      create: seedCompany,
      update: {
        legalName: seedCompany.legalName,
        businessId: seedCompany.businessId,
        email: seedCompany.email,
        defaultCostCenter: seedCompany.defaultCostCenter,
      },
    });

    await transaction.policy.updateMany({ data: { active: false } });
    await transaction.policy.upsert({
      where: { id: seedPolicy.id },
      create: seedPolicy,
      update: {
        perTxLimitAtomic: seedPolicy.perTxLimitAtomic,
        dailyLimitAtomic: seedPolicy.dailyLimitAtomic,
        requireTwInvoice: seedPolicy.requireTwInvoice,
        allowedNetworks: [...seedPolicy.allowedNetworks],
        allowedTokens: [...seedPolicy.allowedTokens],
        allowedSellerIds: [...seedPolicy.allowedSellerIds],
        active: true,
      },
    });

    for (const seller of seedSellers) {
      await transaction.seller.upsert({
        where: { id: seller.id },
        create: seller,
        update: seller,
      });
    }

    for (const service of seedServices) {
      await transaction.service.upsert({
        where: { id: service.id },
        create: service,
        update: service,
      });
    }
  });
}

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    await seedDemo(prisma);
    process.stdout.write("Mello demo data seeded.\n");
  } finally {
    await prisma.$disconnect();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main().catch((error: unknown) => {
    process.stderr.write(`Seed failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
