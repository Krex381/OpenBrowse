import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { Services } from "../../src/server.js";

let provider: Server;
let services: Services;

beforeAll(async () => {
  provider = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        results: [
          {
            title: "Example",
            url: "https://example.com",
            content: "fixture result",
          },
        ],
      }),
    );
  });
  await new Promise<void>((resolve) =>
    provider.listen(3112, "127.0.0.1", resolve),
  );
  process.env.OPENBROWSE_SEARCH_ENDPOINT = "http://127.0.0.1:3112/search";
  const module = await import("../../src/server.js");
  services = await module.buildServer();
});
afterAll(async () => {
  await services.close();
  await new Promise<void>((resolve) => provider.close(() => resolve()));
  delete process.env.OPENBROWSE_SEARCH_ENDPOINT;
});

describe("search adapter", () => {
  it("uses the configured SearXNG-compatible provider", async () => {
    const response = await services.app.inject({
      method: "POST",
      url: "/search?token=dev-key",
      payload: { query: "example" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().results[0]).toMatchObject({
      title: "Example",
      url: "https://example.com",
    });
  });
});
