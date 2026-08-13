import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import type { Services } from "../../src/server.js";
import { buildServer } from "../../src/server.js";
import { acceptsQueryToken } from "../../src/server/lifecycle.js";

let services: Services;
beforeAll(async () => {
  services = await buildServer();
});
afterAll(async () => {
  await services.close();
});

describe("API security boundaries", () => {
  it("accepts query tokens only for compatibility routes and session VNC sockets", () => {
    expect(acceptsQueryToken("/v1/sessions/ses_example/vnc")).toBe(true);
    expect(acceptsQueryToken("/v1/sessions")).toBe(false);
    expect(acceptsQueryToken("/v1/sessions/ses_example/navigate")).toBe(false);
  });

  it("reports malformed JSON as a client error", async () => {
    const response = await services.app.inject({
      method: "POST",
      url: "/v1/fetch",
      headers: {
        authorization: "Bearer dev-key",
        "content-type": "application/json",
      },
      payload: "{not-json",
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("INVALID_REQUEST");
  });
  it("requires an API key", async () => {
    const response = await services.app.inject({
      method: "POST",
      url: "/v1/content",
      payload: { url: "https://example.com" },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("UNAUTHORIZED");
  });
  it("does not accept query-string API keys on native routes", async () => {
    const response = await services.app.inject({
      method: "GET",
      url: "/v1/sessions?token=dev-key",
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("UNAUTHORIZED");
  });
  it("keeps raw browser protocol routes disabled by default", async () => {
    const response = await services.app.inject({
      method: "GET",
      url: "/chromium?token=dev-key",
    });
    expect(response.statusCode).toBe(404);
    const reconnect = await services.app.inject({
      method: "POST",
      url: "/v1/cdp/sessions",
      headers: { authorization: "Bearer dev-key" },
    });
    expect(reconnect.statusCode).toBe(404);
  });
  it("rejects loopback targets", async () => {
    const response = await services.app.inject({
      method: "POST",
      url: "/v1/content",
      headers: { authorization: "Bearer dev-key" },
      payload: { url: "http://127.0.0.1" },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("SSRF_BLOCKED");
  });
  it("does not reveal proxy credentials", async () => {
    const response = await services.app.inject({
      method: "POST",
      url: "/v1/proxies",
      headers: { authorization: "Bearer dev-key" },
      payload: {
        name: `secured-${Date.now()}`,
        url: "http://user:secret@proxy.example:8080",
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain("secret");
    expect(response.body).not.toContain("user");
    await services.app.inject({
      method: "DELETE",
      url: `/v1/proxies/${response.json().id}`,
      headers: { authorization: "Bearer dev-key" },
    });
  });
  it("enforces ownership for operational artifacts, proxies, and webhooks", async () => {
    const owner = "dev-key";
    const other = "other-key";
    const ownerKeyHash = createHash("sha256").update(owner).digest("hex");
    const artifact = await services.storage.createArtifact(
      Buffer.from("tenant-only"),
      "text/plain",
      ownerKeyHash,
      60,
    );
    const deniedArtifact = await services.app.inject({
      method: "GET",
      url: `/v1/artifacts/${artifact.id}`,
      headers: { authorization: `Bearer ${other}` },
    });
    expect(deniedArtifact.statusCode).toBe(404);
    const allowedArtifact = await services.app.inject({
      method: "GET",
      url: `/v1/artifacts/${artifact.id}`,
      headers: { authorization: `Bearer ${owner}` },
    });
    expect(allowedArtifact.statusCode).toBe(200);
    const proxy = await services.app.inject({
      method: "POST",
      url: "/v1/proxies",
      headers: { authorization: `Bearer ${owner}` },
      payload: { name: `owned-${Date.now()}`, url: "http://proxy.example:8080" },
    });
    const deleted = await services.app.inject({
      method: "DELETE",
      url: `/v1/proxies/${proxy.json().id}`,
      headers: { authorization: `Bearer ${other}` },
    });
    expect(deleted.json().deleted).toBe(false);
    const retained = await services.app.inject({
      method: "DELETE",
      url: `/v1/proxies/${proxy.json().id}`,
      headers: { authorization: `Bearer ${owner}` },
    });
    expect(retained.json().deleted).toBe(true);
  });
});
