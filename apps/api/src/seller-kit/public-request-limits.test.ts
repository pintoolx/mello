import express, { type Response } from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createPublicRequestLimits } from "./public-request-limits.js";

describe("public demo request circuit breaker", () => {
  it("bounds global requests, ignores spoofed proxy identity and resets its fixed window", async () => {
    let time = 0;
    const app = express();
    app.post("/report", createPublicRequestLimits({ now: () => time, requestsPerWindow: 2 }), (_req, res) => { res.sendStatus(200); });
    app.get("/health", (_req, res) => { res.sendStatus(200); });
    await request(app).post("/report").expect(200);
    await request(app).post("/report").expect(200);
    const limited = await request(app).post("/report").set("x-forwarded-for", "203.0.113.4").expect(429);
    expect(limited.headers["retry-after"]).toBe("60");
    expect(limited.headers["cache-control"]).toBe("no-store");
    await request(app).get("/health").expect(200);
    time = 60_000;
    await request(app).post("/report").expect(200);
  });
  it("separately bounds paid attempts before calling the facilitator or parsing signatures", async () => {
    let accepted = 0;
    const app = express();
    app.post("/report", createPublicRequestLimits({ paidAttemptsPerWindow: 1 }), (_req, res) => { accepted++; res.sendStatus(200); });
    await request(app).post("/report").set("payment-signature", "untrusted").expect(200);
    await request(app).post("/report").set("payment-signature", "another-untrusted").expect(429);
    await request(app).post("/report").expect(200);
    expect(accepted).toBe(2);
  });
  it("bounds in-flight requests and releases the slot exactly once on completion", async () => {
    let firstResponse: Response;
    let entered: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const app = express();
    let calls = 0;
    app.post("/report", createPublicRequestLimits({ concurrentRequests: 1 }), (_req, res) => {
      if (calls++ === 0) { firstResponse = res; entered(); }
      else res.sendStatus(200);
    });
    const first = request(app).post("/report").then(response => response);
    await started;
    await request(app).post("/report").expect(503);
    firstResponse!.sendStatus(200);
    expect((await first).status).toBe(200);
    await request(app).post("/report").expect(200);
    expect(calls).toBe(2);
  });
});
