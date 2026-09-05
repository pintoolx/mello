import { prisma } from "@mello/db";
import { rotateSellerWallets } from "../src/modules/service-registry/wallet-rotation.js";

try {
  const result = await rotateSellerWallets(prisma, process.env);
  process.stdout.write(JSON.stringify({ operation: "seller-wallet-rotation", ...result }) + "\n");
} catch {
  // Deployment errors must never expose database URLs or credentials.
  process.stderr.write("Seller wallet rotation refused. Check explicit opt-in, previous/replacement public addresses, exact demo service bindings, frozen payments, and no active work or seller settlements.\n");
  process.exitCode = 1;
} finally { await prisma.$disconnect(); }
