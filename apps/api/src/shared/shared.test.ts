import { describe, expect, it } from "vitest";
import {
  calculateTwdMinorUnits,
  canonicalJson,
  formatUsdcAtomic,
  hashCanonicalJson,
  isValidTaiwanBusinessId,
  parseUsdcToAtomic,
} from "./index.js";

describe("Taiwan business ID", () => {
  it("accepts the seeded demo ID including the seventh-digit rule", () => {
    expect(isValidTaiwanBusinessId("12345675")).toBe(true);
  });

  it("rejects malformed and invalid IDs", () => {
    expect(isValidTaiwanBusinessId("1234567")).toBe(false);
    expect(isValidTaiwanBusinessId("12345678")).toBe(false);
  });
});

describe("atomic money", () => {
  it("parses and formats USDC without floating point", () => {
    expect(parseUsdcToAtomic("0.05")).toBe("50000");
    expect(parseUsdcToAtomic("1.000001")).toBe("1000001");
    expect(formatUsdcAtomic("50000")).toBe("0.05");
  });

  it("rounds the demo TWD display to cents deterministically", () => {
    expect(calculateTwdMinorUnits("50000", "32.0")).toBe("160");
  });

  it("rejects fractional precision beyond token decimals", () => {
    expect(() => parseUsdcToAtomic("0.0000001")).toThrow(/at most 6/);
  });
});

describe("canonical hashing", () => {
  it("is independent of object insertion order", () => {
    const first = { schemaVersion: "1", b: 2, a: { z: true, y: "x" } };
    const second = { a: { y: "x", z: true }, b: 2, schemaVersion: "1" };
    expect(canonicalJson(first)).toBe(canonicalJson(second));
    expect(hashCanonicalJson(first)).toBe(hashCanonicalJson(second));
  });

  it("changes when schema version changes", () => {
    expect(hashCanonicalJson({ schemaVersion: "1", value: "x" })).not.toBe(
      hashCanonicalJson({ schemaVersion: "2", value: "x" }),
    );
  });
});
