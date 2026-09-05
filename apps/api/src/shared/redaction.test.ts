import { describe, expect, it } from "vitest";
import {
  redactSensitiveText,
  sanitizedErrorForLog,
  sanitizedErrorMessage,
} from "./redaction.js";

const PRIVATE_KEY = `0x${"ab".repeat(32)}`;

describe("error redaction", () => {
  it("redacts URL, database, bearer, named, and private-key-like credentials", () => {
    const input = [
      "https://api.example.invalid/run?api_key=URL_API_KEY_SENTINEL&safe=yes",
      "https://api.example.invalid/token/PATH_TOKEN_SENTINEL",
      "https://base-sepolia.g.alchemy.com/v2/ALCHEMY_SENTINEL",
      "https://mainnet.infura.io/v3/INFURA_SENTINEL",
      "https://example.quiknode.pro/QUICKNODE_SENTINEL",
      "https://rpc.example.invalid/project/GENERIC_RPC_SENTINEL",
      "https://rpc.example.invalid?provider_key=GENERIC_QUERY_SENTINEL",
      "postgresql://mello:DB_SENTINEL@localhost:5432/mello",
      "Bearer BEARER_SENTINEL",
      "OPENAI_API_KEY=OPENAI_SENTINEL",
      PRIVATE_KEY,
    ].join(" ");

    const sanitized = redactSensitiveText(input);

    expect(sanitized).toContain("safe=yes");
    expect(sanitized).toContain("[REDACTED]");
    for (const secret of [
      "URL_API_KEY_SENTINEL",
      "PATH_TOKEN_SENTINEL",
      "ALCHEMY_SENTINEL",
      "INFURA_SENTINEL",
      "QUICKNODE_SENTINEL",
      "GENERIC_RPC_SENTINEL",
      "GENERIC_QUERY_SENTINEL",
      "DB_SENTINEL",
      "BEARER_SENTINEL",
      "OPENAI_SENTINEL",
      PRIVATE_KEY,
    ]) {
      expect(sanitized).not.toContain(secret);
    }
  });

  it("sanitizes Error messages and stacks without discarding safe diagnostics", () => {
    const error = Object.assign(
      new Error("upstream https://example.invalid?api_key=URL_API_KEY_SENTINEL timed out"),
      { code: "ETIMEDOUT" },
    );

    expect(sanitizedErrorMessage(error, "fallback")).toBe(
      "upstream https://example.invalid?api_key=[REDACTED] timed out",
    );
    expect(sanitizedErrorForLog(error)).toMatchObject({
      type: "Error",
      message: "upstream https://example.invalid?api_key=[REDACTED] timed out",
      code: "ETIMEDOUT",
    });
    expect(sanitizedErrorForLog(error).stack).not.toContain(
      "URL_API_KEY_SENTINEL",
    );
  });
});
