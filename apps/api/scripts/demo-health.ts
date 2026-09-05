import { apiBaseUrl, asRecord, requestJson, safeErrorMessage, writeJson } from "./lib.js";

async function main(): Promise<void> {
  const { body } = await requestJson("/api/v1/demo/health");
  const health = asRecord(body, "health response");
  writeJson({ coreApi: apiBaseUrl(), ...health });
  if (health["status"] !== "ok") process.exitCode = 1;
}

void main().catch((error: unknown) => {
  process.stderr.write(`Demo health failed: ${safeErrorMessage(error)}\n`);
  process.exitCode = 1;
});
