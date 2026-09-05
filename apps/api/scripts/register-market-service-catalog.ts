import { prisma } from "@mello/db";
import { registerMarketServiceCatalog } from "../src/modules/service-registry/market-service-catalog.js";

try {
  const result = await registerMarketServiceCatalog(prisma);
  process.stdout.write(JSON.stringify({ operation: "register-market-service-catalog", ...result }) + "\n");
} catch {
  // Do not print database URLs, private configuration, or serialized records.
  process.stderr.write("Market catalog registration stopped. Resolve active work or unexpected catalog identities before retrying; existing records were preserved.\n");
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
