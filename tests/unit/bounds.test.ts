import { describe, expect, it } from "vitest";
import { assertBoundedBuffer, assertBoundedJson, boundedJsonText } from "../../src/bounds.js";
import { config } from "../../src/config.js";

describe("aggregate output bounds", () => {
  it("accepts small JSON and rejects aggregate JSON over the response limit", () => {
    expect(assertBoundedJson({ value: "small" }, "Test output")).toEqual({
      value: "small",
    });
    expect(boundedJsonText({ value: "small" }, "Test output")).toBe(
      '{"value":"small"}',
    );
    expect(() =>
      assertBoundedJson(
        { value: "x".repeat(config.maxResponseBytes) },
        "Test output",
      ),
    ).toThrow("Test output exceeds the configured byte limit");
  });

  it("rejects oversized binary artifacts", () => {
    expect(() =>
      assertBoundedBuffer(
        Buffer.alloc(config.maxResponseBytes + 1),
        "Binary output",
      ),
    ).toThrow("Binary output exceeds the configured byte limit");
  });
});
