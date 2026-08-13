import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Services } from "../../src/server.js";
import { buildServer } from "../../src/server.js";

let services: Services;
beforeAll(async () => {
  services = await buildServer();
});
afterAll(async () => {
  if (services) await services.close();
});

describe("HTTP-first execution", () => {
  it("reports the distinct memory admission and diagnostic values", async () => {
    const pressure = await services.app.inject({ method: "GET", url: "/pressure" });
    expect(pressure.statusCode).toBe(200);
    const memory = pressure.json().memory as {
      rssMb: number;
      processTreeRssMb: number;
      admissionAuthority: string;
    };
    expect(memory.rssMb).toBeGreaterThan(0);
    expect(memory.processTreeRssMb).toBeGreaterThan(0);
    expect(["cgroup", "process-tree", "node"]).toContain(memory.admissionAuthority);

    const metrics = await services.app.inject({ method: "GET", url: "/metrics" });
    expect(metrics.body).toContain("openbrowse_admission_rss_megabytes");
    expect(metrics.body).toContain("openbrowse_process_tree_rss_megabytes");
    expect(metrics.body).toContain("openbrowse_memory_admission_authority");
  });

  it("serves the public product landing page with a restrictive CSP", async () => {
    const response = await services.app.inject({
      method: "GET",
      url: "/landing",
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");
    expect(response.headers["content-security-policy"]).toContain(
      "default-src 'self'",
    );
    expect(response.body).toContain('<div id="root"></div>');
    expect(response.body).toContain("/landing/assets/");
  });
  it("renders an HTTP Cats-backed error page for arbitrary client and server statuses", async () => {
    const missing = await services.app.inject({
      method: "GET",
      url: "/errors/404",
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.headers["content-type"]).toContain("text/html");
    expect(missing.headers["content-security-policy"]).toContain(
      "https://http.cat",
    );
    expect(missing.body).toContain("https://http.cat/404.jpg");
    expect(missing.body).toContain("Nothing is running at this address.");

    const timeout = await services.app.inject({
      method: "GET",
      url: "/errors/599",
    });
    expect(timeout.statusCode).toBe(599);
    expect(timeout.body).toContain("https://http.cat/599.jpg");
  });
  it("uses the custom blocked and public not-found pages without changing API errors", async () => {
    const blocked = await services.app.inject({
      method: "GET",
      url: "/blocked",
    });
    expect(blocked.statusCode).toBe(423);
    expect(blocked.body).toContain("OpenBrowse stopped this request.");

    const publicMissing = await services.app.inject({
      method: "GET",
      url: "/not-a-real-page",
    });
    expect(publicMissing.statusCode).toBe(404);
    expect(publicMissing.body).toContain("Return to landing");

    const apiMissing = await services.app.inject({
      method: "GET",
      url: "/v1/not-a-real-route",
      headers: { authorization: "Bearer dev-key" },
    });
    expect(apiMissing.statusCode).toBe(404);
    expect(apiMissing.json().error.code).toBe("NOT_FOUND");
  });
  it("keeps public error recovery actions on public product routes", async () => {
    const blocked = await services.app.inject({
      method: "GET",
      url: "/blocked",
    });
    expect(blocked.body).toContain('href="/landing#method"');
    expect(blocked.body).not.toContain('href="/v1/capabilities"');

    for (const status of [429, 500, 503]) {
      const response = await services.app.inject({
        method: "GET",
        url: `/errors/${status}`,
      });
      expect(response.statusCode).toBe(status);
      expect(response.body).toContain('href="/landing#request"');
    }
  });
  it("serves a strict allowlisted CORS preflight without authenticating it", async () => {
    const preflight = await services.app.inject({
      method: "OPTIONS",
      url: "/v1/fetch",
      headers: {
        origin: "https://console.example.test",
        "access-control-request-method": "POST",
      },
    });
    expect(preflight.statusCode).toBe(204);
    expect(preflight.headers["access-control-allow-origin"]).toBe(
      "https://console.example.test",
    );
    const denied = await services.app.inject({
      method: "OPTIONS",
      url: "/v1/fetch",
      headers: { origin: "https://untrusted.example.test" },
    });
    expect(denied.statusCode).toBe(401);
  });
  it("fetches static content with the HTTP strategy", async () => {
    const response = await services.app.inject({
      method: "POST",
      url: "/v1/fetch",
      headers: { authorization: "Bearer dev-key" },
      payload: {
        url: "https://example.com",
        strategy: "http",
        output: ["html", "links"],
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().strategy).toBe("http");
    expect(response.json().html).toContain("Example Domain");
  }, 30000);
  it("serves a cache hit on a repeat request", async () => {
    const request = {
      method: "POST" as const,
      url: "/v1/fetch",
      headers: { authorization: "Bearer dev-key" },
      payload: {
        url: "https://example.com",
        strategy: "http",
        output: ["html"],
      },
    };
    await services.app.inject(request);
    const cached = await services.app.inject(request);
    expect(cached.statusCode).toBe(200);
    expect(cached.json().cache.hit).toBe(true);
  }, 30000);
});
