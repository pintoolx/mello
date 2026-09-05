import { prisma } from "@mello/db";
import { syncPublicSellerBindings } from "../src/modules/service-registry/deployment-sync.js";

try {
  const result = await syncPublicSellerBindings(prisma, process.env);
  process.stdout.write(JSON.stringify({ operation: "public-seller-binding-sync", ...result }) + "\n");
} catch {
  // Never print Prisma connection details or deployment credentials.
  process.stderr.write("Public seller binding sync refused. Check explicit opt-in, HTTPS targets, frozen payments, no active work, and the original private endpoints.\n");
  process.exitCode = 1;
} finally { await prisma.$disconnect(); }
