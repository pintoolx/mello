import type { generateJwt } from "@coinbase/cdp-sdk/auth";
import { describe, expect, it, vi } from "vitest";
import {
  CDP_FACILITATOR_URL,
  createCdpFacilitatorAuthHeaders,
  createFacilitatorClient,
} from "./facilitator.js";

const API_KEY_ID = "test-key-id";
const API_KEY_SECRET = "test-api-key-secret";

describe("facilitator authentication", () => {
  it("generates method- and path-bound CDP bearer headers", async () => {
    const jwtGenerator = vi.fn(
      async (options: Parameters<typeof generateJwt>[0]) =>
        `${options.requestMethod}:${options.requestPath}`,
    );
    const createAuthHeaders = createCdpFacilitatorAuthHeaders(
      { apiKeyId: API_KEY_ID, apiKeySecret: API_KEY_SECRET },
      jwtGenerator,
    );

    await expect(createAuthHeaders()).resolves.toEqual({
      verify: {
        Authorization: "Bearer POST:/platform/v2/x402/verify",
      },
      settle: {
        Authorization: "Bearer POST:/platform/v2/x402/settle",
      },
      supported: {
        Authorization: "Bearer GET:/platform/v2/x402/supported",
      },
    });
    expect(jwtGenerator.mock.calls.map(([options]) => options)).toEqual([
      {
        apiKeyId: API_KEY_ID,
        apiKeySecret: API_KEY_SECRET,
        requestMethod: "POST",
        requestHost: "api.cdp.coinbase.com",
        requestPath: "/platform/v2/x402/verify",
      },
      {
        apiKeyId: API_KEY_ID,
        apiKeySecret: API_KEY_SECRET,
        requestMethod: "POST",
        requestHost: "api.cdp.coinbase.com",
        requestPath: "/platform/v2/x402/settle",
      },
      {
        apiKeyId: API_KEY_ID,
        apiKeySecret: API_KEY_SECRET,
        requestMethod: "GET",
        requestHost: "api.cdp.coinbase.com",
        requestPath: "/platform/v2/x402/supported",
      },
    ]);
  });

  it("installs CDP authentication for the production URL and its trailing-slash form", async () => {
    for (const url of [CDP_FACILITATOR_URL, `${CDP_FACILITATOR_URL}/`]) {
      const jwtGenerator = vi.fn(
        async (options: Parameters<typeof generateJwt>[0]) =>
          `${options.requestMethod}:${options.requestPath}`,
      );
      const client = createFacilitatorClient(url, {
        env: {
          CDP_API_KEY_ID: API_KEY_ID,
          CDP_API_KEY_SECRET: API_KEY_SECRET,
        },
        jwtGenerator,
      });

      await expect(client.createAuthHeaders("verify")).resolves.toEqual({
        headers: {
          Authorization: "Bearer POST:/platform/v2/x402/verify",
        },
      });
      expect(jwtGenerator).toHaveBeenCalledTimes(3);
    }
  });

  it("requires credentials only for the exact CDP facilitator URL", async () => {
    expect(() =>
      createFacilitatorClient(CDP_FACILITATOR_URL, { env: {} }),
    ).toThrow(/CDP_API_KEY_ID, CDP_API_KEY_SECRET/);

    const jwtGenerator = vi.fn(async () => "unused");
    for (const url of [
      "https://x402.org/facilitator",
      "https://api.cdp.coinbase.com.example.com/platform/v2/x402",
    ]) {
      const client = createFacilitatorClient(url, {
        env: {},
        jwtGenerator,
      });
      await expect(client.createAuthHeaders("verify")).resolves.toEqual({
        headers: {},
      });
    }
    expect(jwtGenerator).not.toHaveBeenCalled();
  });
});
