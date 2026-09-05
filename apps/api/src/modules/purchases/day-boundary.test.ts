import { describe, expect, it } from "vitest";
import { taipeiDayBounds } from "./day-boundary.js";

describe("Taipei accounting day", () => {
  it("uses Asia/Taipei midnight while persisting UTC", () => {
    const result = taipeiDayBounds(new Date("2026-09-04T23:00:00.000Z"));
    expect(result.start.toISOString()).toBe("2026-09-04T16:00:00.000Z");
    expect(result.end.toISOString()).toBe("2026-09-05T16:00:00.000Z");
  });
});
