import { prisma } from "@mello/db";
import { seedDemo } from "../src/db/seed.js";

try {
  if (await prisma.companyProfile.count() === 0) {
    await seedDemo(prisma);
    process.stdout.write("Initialized a new Mello database.\n");
  } else {
    process.stdout.write("Existing company and policy preserved; initialization skipped.\n");
  }
} finally {
  await prisma.$disconnect();
}
