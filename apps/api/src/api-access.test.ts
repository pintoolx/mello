import pino from "pino";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import type { CoreApiDependencies } from "./http/contracts.js";

const accessToken = "api-auth-unit-test-key-not-a-runtime-secret";
const dependencies = {
  config: loadConfig({ NODE_ENV: "test", DATABASE_URL: "postgresql://localhost/mello_unit", API_ACCESS_TOKEN: accessToken }),
  logger: pino({ level: "silent" }),
  healthService: { check: async () => ({ status: "ok" }) },
} as CoreApiDependencies;

describe("deployed API access boundary", () => {
  it("keeps the readiness endpoint public but rejects anonymous reads and signing requests", async () => {
    const app = createApp(dependencies);
    expect((await request(app).get("/healthz")).status).toBe(200);
    expect((await request(app).get("/api/v1/demo/health")).status).toBe(401);
    expect((await request(app).post("/api/v1/tasks").send({ prompt: "buy a report" })).status).toBe(401);
    expect((await request(app).get("/api/v1/demo/health").set("x-mello-api-key", "wrong")).status).toBe(401);
  });
  it("accepts the private BFF credential without reflecting it in the response", async () => {
    const result = await request(createApp(dependencies)).get("/api/v1/demo/health").set("x-mello-api-key", accessToken);
    expect(result.status).toBe(200);
    expect(JSON.stringify(result.body)).not.toContain(accessToken);
  });
  it("refuses production configuration without a private API credential", () => {
    expect(() => loadConfig({ NODE_ENV: "production", DATABASE_URL: "postgresql://localhost/mello_unit" })).toThrow();
  });
});
