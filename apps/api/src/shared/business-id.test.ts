import { describe, expect, it } from "vitest";
import { isValidTaiwanBusinessId } from "./business-id.js";

describe("Taiwan business IDs under the expanded 2023 rules", () => {
  // Ministry of Finance examples, including newly allocated IDs that the old
  // divisible-by-10 rule rejected.
  it.each(["04595252", "10458570", "10458575", "10458574", "12345675", "24536806"])("accepts %s", (id) => {
    expect(isValidTaiwanBusinessId(id)).toBe(true);
  });
  it.each(["12345678", "123", "abcdefgh", " 04595252"])("rejects %s", (id) => {
    expect(isValidTaiwanBusinessId(id)).toBe(false);
  });
});
