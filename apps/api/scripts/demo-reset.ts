import { apiBaseUrl, asRecord, requestJson, safeErrorMessage, writeJson } from "./lib.js";

function assertLocalCoreApi(): void {
  const url = new URL(apiBaseUrl());
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname.toLowerCase())) {
    throw new Error("Demo reset CLI only targets a localhost Core API");
  }
}

async function main(): Promise<void> {
  assertLocalCoreApi();
  const token = process.env["DEMO_ADMIN_TOKEN"];
  if (!token || token === "change-me-before-public-deploy") {
    throw new Error("Set a non-default DEMO_ADMIN_TOKEN in .env before resetting demo data");
  }
  const { body } = await requestJson("/api/v1/demo/reset", {
    method: "POST",
    headers: { "x-demo-admin-token": token },
  });
  const result = asRecord(body, "reset response");
  writeJson({ coreApi: apiBaseUrl(), ...result });
}

void main().catch((error: unknown) => {
  process.stderr.write(`Demo reset failed: ${safeErrorMessage(error)}\n`);
  process.exitCode = 1;
});
