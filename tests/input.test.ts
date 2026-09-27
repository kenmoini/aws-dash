import { describe, expect, it } from "vitest";
import { inputBool, inputInt } from "../src/routes/input.js";

describe("input parsing", () => {
  it("inputBool reads the usual spellings and returns undefined otherwise", () => {
    expect(inputBool({ enabled: "true" }, "enabled")).toBe(true);
    expect(inputBool({ enabled: "off" }, "enabled")).toBe(false);
    expect(inputBool({ enabled: "x" }, "enabled")).toBeUndefined();
    expect(inputBool({}, "enabled")).toBeUndefined();
  });
  it("inputInt returns the fallback when absent, the value when in range, undefined otherwise", () => {
    expect(inputInt({}, "workers", 1, 1, 64)).toBe(1);
    expect(inputInt({ workers: " " }, "workers", 1, 1, 64)).toBe(1);
    expect(inputInt({ workers: "8" }, "workers", 1, 1, 64)).toBe(8);
    expect(inputInt({ workers: "65" }, "workers", 1, 1, 64)).toBeUndefined();
    expect(inputInt({ workers: "0" }, "workers", 1, 1, 64)).toBeUndefined();
    expect(inputInt({ workers: "abc" }, "workers", 1, 1, 64)).toBeUndefined();
    expect(inputInt({ workers: "2.5" }, "workers", 1, 1, 64)).toBeUndefined();
  });
});
