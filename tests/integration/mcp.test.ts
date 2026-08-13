import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Services } from "../../src/server.js";
import { buildServer } from "../../src/server.js";

let services: Services;
const headers = {
  authorization: "Bearer dev-key",
  origin: "http://localhost:80",
};

beforeAll(async () => {
  services = await buildServer();
});
afterAll(async () => {
  if (services) await services.close();
});

describe("Streamable HTTP MCP", () => {
  it("lists and invokes authenticated OpenBrowse tools", async () => {
    const listed = await services.app.inject({
      method: "POST",
      url: "/mcp",
      headers,
      payload: { jsonrpc: "2.0", id: 1, method: "tools/list" },
    });
    expect(listed.statusCode).toBe(200);
    expect(
      listed.json().result.tools.map((tool: { name: string }) => tool.name),
    ).toEqual([
      "browserless_agent",
      "openbrowse_fetch",
      "openbrowse_extract",
      "openbrowse_map",
      "openbrowse_screenshot",
    ]);
    const called = await services.app.inject({
      method: "POST",
      url: "/mcp",
      headers,
      payload: {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "openbrowse_fetch",
          arguments: { url: "https://example.com", output: ["markdown"] },
        },
      },
    });
    expect(called.statusCode).toBe(200);
    expect(called.json().result.content[0].text).toContain("Example Domain");
  }, 30000);
  it("runs a stateful snapshot-driven browser agent across MCP calls", async () => {
    const created = await services.app.inject({
      method: "POST",
      url: "/mcp",
      headers,
      payload: {
        jsonrpc: "2.0",
        id: 10,
        method: "tools/call",
        params: {
          name: "browserless_agent",
          arguments: {
            commands: [
              { method: "goto", params: { url: "https://example.com" } },
              { method: "snapshot" },
            ],
          },
        },
      },
    });
    expect(created.statusCode).toBe(200);
    const answer = created.json().result.structuredContent;
    expect(answer.created).toBe(true);
    expect(answer.results[1].result.elements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ tag: "h1", text: "Example Domain" }),
      ]),
    );
    const resumed = await services.app.inject({
      method: "POST",
      url: "/mcp",
      headers,
      payload: {
        jsonrpc: "2.0",
        id: 11,
        method: "tools/call",
        params: {
          name: "browserless_agent",
          arguments: {
            sessionId: answer.sessionId,
            commands: [
              { method: "text", params: { selector: "h1" } },
              { method: "close" },
            ],
          },
        },
      },
    });
    expect(resumed.statusCode).toBe(200);
    expect(resumed.json().result.structuredContent.results[0].result.text).toBe(
      "Example Domain",
    );
    expect(resumed.json().result.structuredContent.closed).toBe(true);
  }, 30000);
  it("rejects cross-origin browser MCP requests", async () => {
    const response = await services.app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        authorization: "Bearer dev-key",
        origin: "https://attacker.example",
      },
      payload: { jsonrpc: "2.0", id: 1, method: "tools/list" },
    });
    expect(response.statusCode).toBe(403);
  });
});
