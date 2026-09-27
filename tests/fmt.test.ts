import { describe, expect, it } from "vitest";
import { fmt } from "../src/views/fmt.js";

describe("fmt", () => {
  it("or() substitutes a dash for empty values", () => {
    expect(fmt.or(null)).toBe("—");
    expect(fmt.or("")).toBe("—");
    expect(fmt.or(0)).toBe("0");
    expect(fmt.or("x")).toBe("x");
  });
  it("bytes() uses binary units", () => {
    expect(fmt.bytes(null)).toBe("—");
    expect(fmt.bytes(null, "unlimited")).toBe("unlimited");
    expect(fmt.bytes(512)).toBe("512 B");
    expect(fmt.bytes(536870912)).toBe("512.0 MiB");
    expect(fmt.bytes(1.5 * 1024 ** 3)).toBe("1.5 GiB");
  });
  it("cores() and time() and duration()", () => {
    expect(fmt.cores(null)).toBe("unlimited");
    expect(fmt.cores(0.5)).toBe("0.5 cores");
    expect(fmt.cores(2)).toBe("2 cores");
    expect(fmt.time(null)).toBe("never");
    expect(fmt.time("2026-01-01T12:34:56.000Z")).toBe("2026-01-01 12:34:56 UTC");
    expect(fmt.duration(7)).toBe("7s");
    expect(fmt.duration(306)).toBe("5m 6s");
    expect(fmt.duration(3 * 3600 + 240)).toBe("3h 4m");
    expect(fmt.duration(26 * 3600)).toBe("1d 2h");
  });
  it("until() counts down or reports expired", () => {
    expect(fmt.until("2026-01-01T00:04:12Z", "2026-01-01T00:00:00Z")).toBe("in 4m 12s");
    expect(fmt.until("2026-01-01T00:00:00Z", "2026-01-01T00:00:01Z")).toBe("expired");
  });
});
