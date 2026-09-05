// Read-only smoke: no env keys, seller calls, signatures, or transactions.
import { CdpBazaarClient } from "../src/modules/service-registry/bazaar-client.js";

try {
  const result = await new CdpBazaarClient().search({ query: "credit report" });
  process.stdout.write(JSON.stringify({ source: result.source, fetchedAt: result.fetchedAt,
    resourceCount: result.resources.length, rejectedResourceCount: result.rejectedResourceCount,
    partialResults: result.partialResults, paidRequests: 0 }, null, 2) + "\n");
} catch (error) {
  console.error(error instanceof Error ? error.message : "Discovery failed");
  process.exitCode = 1;
}
