import { prisma } from "@mello/db";
import { registerDemoServiceOptions } from "../src/modules/service-registry/demo-service-options.js";

try {
  const result = await registerDemoServiceOptions(prisma);
  process.stdout.write(JSON.stringify({ operation: "register-demo-service-options", ...result }) + "\n");
} catch {
  process.stderr.write("Demo service registration stopped. Check the existing demo providers and service IDs.\n");
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
