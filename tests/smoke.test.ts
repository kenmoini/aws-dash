import { describe, expect, it } from "vitest";

describe("toolchain", () => {
  it("runs under node 24 or newer", () => {
    expect(Number(process.versions.node.split(".")[0])).toBeGreaterThanOrEqual(24);
  });
});
