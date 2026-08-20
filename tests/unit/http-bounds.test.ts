import { describe, expect, it } from "vitest";
import { config } from "../../src/config.js";
import { readBoundedResponse } from "../../src/execution/http.js";

describe("HTTP response bounds", () => {
  it("rejects an oversized declared response before reading the body", async () => {
    const response = new Response("small", {
      headers: { "content-length": String(config.maxResponseBytes + 1) },
    });
    await expect(readBoundedResponse(response)).rejects.toMatchObject({
      code: "PAYLOAD_TOO_LARGE",
      statusCode: 413,
    });
  });

  it("accepts a response within the configured byte limit", async () => {
    const response = new Response("bounded");
    await expect(readBoundedResponse(response)).resolves.toEqual(Buffer.from("bounded"));
  });
});
