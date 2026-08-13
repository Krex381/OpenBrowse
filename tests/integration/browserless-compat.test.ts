import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Services } from "../../src/server.js";
import { buildServer } from "../../src/server.js";

let services: Services;
let downloadFixture: Server;
let downloadFixtureUrl: string;

vi.mock("../../src/security.js", async (importOriginal) => {
  const security = await importOriginal<typeof import("../../src/security.js")>();
  return {
    ...security,
    assertSafeUrl: async (value: string, allowedDomains?: readonly string[]) =>
      value.startsWith("http://127.0.0.1:")
        ? new URL(value)
        : security.assertSafeUrl(value, allowedDomains),
  };
});

beforeAll(async () => {
  downloadFixture = createServer((request, response) => {
    if (request.url === "/download") {
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end('<a data-download href="/fixture.csv" download="fixture.csv">Download</a>');
      return;
    }
    if (request.url === "/fixture.csv") {
      response.setHeader("content-type", "text/csv; charset=utf-8");
      response.setHeader("content-disposition", 'attachment; filename="fixture.csv"');
      response.end("id,name\n1,OpenBrowse\n");
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  await new Promise<void>((resolve) =>
    downloadFixture.listen(0, "127.0.0.1", resolve),
  );
  const address = downloadFixture.address();
  if (!address || typeof address === "string")
    throw new Error("Download fixture did not bind to a TCP port");
  downloadFixtureUrl = `http://127.0.0.1:${address.port}/download`;
  services = await buildServer();
});
afterAll(async () => {
  await services.close();
  await new Promise<void>((resolve) => downloadFixture.close(() => resolve()));
});

describe("Browserless migration aliases", () => {
  it("accepts a query token and smart-scrapes HTTP-first", async () => {
    const response = await services.app.inject({
      method: "POST",
      url: "/smart-scrape?token=dev-key",
      payload: { url: "https://example.com", formats: ["markdown", "links"] },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().strategy).toBe("http");
    expect(response.json().markdown).toContain("Example Domain");
  }, 30000);
  it("maps same-origin links with a bounded crawl", async () => {
    const response = await services.app.inject({
      method: "POST",
      url: "/map?token=dev-key",
      payload: { url: "https://example.com", maxUrls: 10, maxDepth: 1 },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().urls[0].url).toContain("example.com");
  }, 30000);
  it("describes bypass-sensitive features as disabled", async () => {
    const response = await services.app.inject({
      method: "GET",
      url: "/v1/capabilities",
      headers: { authorization: "Bearer dev-key" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().policies.captcha).toBe("detect-and-fail");
  });
  it("exports bounded offline bundles", async () => {
    const response = await services.app.inject({
      method: "POST",
      url: "/export?token=dev-key",
      payload: { url: "https://example.com", includeResources: true },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("application/zip");
    expect(response.rawPayload.subarray(0, 4).toString("hex")).toBe("504b0304");
  }, 30000);
  it("downloads a selected browser file with only a CSS selector", async () => {
    const response = await services.app.inject({
      method: "POST",
      url: "/download?token=dev-key",
      payload: {
        url: downloadFixtureUrl,
        selector: "a[data-download]",
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/csv");
    expect(response.headers["content-disposition"]).toContain("fixture.csv");
    expect(response.rawPayload.toString("utf8")).toBe("id,name\n1,OpenBrowse\n");
  }, 30000);
  it("records an authenticated session trace and serves it as a ZIP", async () => {
    const headers = { authorization: "Bearer dev-key" };
    const session = await services.app.inject({
      method: "POST",
      url: "/v1/sessions",
      headers,
      payload: { ttlSeconds: 120, recordTrace: true },
    });
    expect(session.statusCode).toBe(200);
    const id = session.json().id as string;
    expect(session.json().connectUrl).toBe(
      `wss://openbrowse.example.test/edge/v1/sessions/${id}/cdp`,
    );
    const listed = await services.app.inject({
      method: "GET",
      url: "/v1/sessions",
      headers,
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().sessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id, active: true, tracing: true }),
      ]),
    );
    const navigation = await services.app.inject({
      method: "POST",
      url: `/v1/sessions/${id}/navigate`,
      headers,
      payload: { url: "https://example.com" },
    });
    expect(navigation.statusCode).toBe(200);
    const inspect = await services.app.inject({
      method: "GET",
      url: `/v1/sessions/${id}/inspect`,
      headers,
    });
    expect(inspect.statusCode).toBe(200);
    expect(inspect.json()).toMatchObject({
      active: true,
      title: "Example Domain",
      url: "https://example.com/",
    });
    const frame = await services.app.inject({
      method: "GET",
      url: inspect.json().screenshotPath,
      headers,
    });
    expect(frame.statusCode).toBe(200);
    expect(frame.headers["content-type"]).toBe("image/png");
    expect(frame.rawPayload.subarray(0, 8).toString("hex")).toBe(
      "89504e470d0a1a0a",
    );
    const stream = await services.app.inject({
      method: "GET",
      url: `${inspect.json().streamPath}?maxFrames=1`,
      headers,
    });
    expect(stream.statusCode).toBe(200);
    expect(stream.headers["content-type"]).toContain("text/event-stream");
    expect(stream.body).toContain("event: frame");
    expect(stream.body).toContain('"mimeType":"image/jpeg"');
    const crossKey = await services.app.inject({
      method: "GET",
      url: `/v1/sessions/${id}`,
      headers: { authorization: "Bearer other-key" },
    });
    expect(crossKey.statusCode).toBe(404);
    const stopped = await services.app.inject({
      method: "POST",
      url: `/v1/sessions/${id}/replay/stop`,
      headers,
    });
    expect(stopped.statusCode).toBe(200);
    const archive = await services.app.inject({
      method: "GET",
      url: stopped.json().downloadPath,
      headers,
    });
    const deniedArchive = await services.app.inject({
      method: "GET",
      url: stopped.json().downloadPath,
      headers: { authorization: "Bearer other-key" },
    });
    expect(deniedArchive.statusCode).toBe(404);
    expect(archive.statusCode).toBe(200);
    expect(archive.headers["content-type"]).toBe("application/zip");
    expect(archive.rawPayload.subarray(0, 4).toString("hex")).toBe("504b0304");
    await services.app.inject({
      method: "DELETE",
      url: `/v1/sessions/${id}`,
      headers,
    });
  }, 30000);
  it("returns a filtered Browserless-style performance report", async () => {
    const response = await services.app.inject({
      method: "POST",
      url: "/performance?token=dev-key",
      payload: {
        url: "https://example.com",
        config: {
          settings: {
            onlyCategories: ["accessibility", "seo"],
            onlyAudits: ["is-on-https", "viewport"],
          },
        },
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().engine).toBe("openbrowse-hardened-performance-v1");
    expect(Object.keys(response.json().audits.categories)).toEqual([
      "accessibility",
      "seo",
    ]);
    expect(Object.keys(response.json().audits.audits)).toEqual([
      "is-on-https",
      "viewport",
    ]);
  }, 30000);
  it("captures a bounded WebM screen-recording artifact", async () => {
    const headers = { authorization: "Bearer dev-key" };
    const recording = await services.app.inject({
      method: "POST",
      url: "/v1/recordings",
      headers,
      payload: { url: "https://example.com", durationMs: 250, ttlSeconds: 120 },
    });
    expect(recording.statusCode).toBe(200);
    expect(recording.json().contentType).toBe("video/webm");
    const artifact = await services.app.inject({
      method: "GET",
      url: recording.json().downloadPath,
      headers,
    });
    expect(artifact.statusCode).toBe(200);
    expect(artifact.headers["content-type"]).toBe("video/webm");
    expect(artifact.rawPayload.subarray(0, 4).toString("hex")).toBe("1a45dfa3");
  }, 30000);
  it("runs a typed browser workflow without evaluating caller JavaScript", async () => {
    const response = await services.app.inject({
      method: "POST",
      url: "/v1/workflows/run",
      headers: { authorization: "Bearer dev-key" },
      payload: {
        url: "https://example.com",
        steps: [
          { action: "wait", selector: "h1" },
          { action: "extract", name: "heading", selector: "h1", type: "text" },
          {
            action: "extract",
            name: "more",
            selector: "a",
            type: "attribute",
            attribute: "href",
          },
        ],
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().outputs).toMatchObject({
      heading: "Example Domain",
      more: "https://iana.org/domains/example",
    });
  }, 30000);
  it("executes a safe BrowserQL mutation with aliases, variables, extraction, and screenshots", async () => {
    const response = await services.app.inject({
      method: "POST",
      url: "/chromium/bql?token=dev-key",
      payload: {
        query:
          'mutation ReadPage($target: String!) { opened: goto(url: $target, waitUntil: domContentLoaded) { status url time } heading: text(selector: "h1") { text time } pageTitle: title { title } current: url { url } links: querySelectorAll(selector: "a") { innerText childElementCount } shot: screenshot { mimeType bytes base64 } crop: screenshot(selector: "h1", type: jpeg, quality: 60) { mimeType bytes base64 } document: pdf(format: A5, printBackground: true) { mimeType size base64 } }',
        variables: { target: "https://example.com" },
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      data: {
        opened: { status: 200, url: "https://example.com/" },
        heading: { text: "Example Domain" },
        pageTitle: { title: "Example Domain" },
        current: { url: "https://example.com/" },
        links: [expect.objectContaining({ innerText: "Learn more" })],
        shot: { mimeType: "image/png" },
        crop: { mimeType: "image/jpeg" },
        document: { mimeType: "application/pdf" },
      },
      extensions: { engine: "openbrowse-browserql-safe", bypass: "disabled" },
    });
    expect(response.json().data.shot.bytes).toBeGreaterThan(1000);
    expect(response.json().data.shot.base64).toMatch(/^iVBOR/);
    expect(response.json().data.opened.time).toBeGreaterThanOrEqual(0);
    expect(response.json().data.heading.time).toBeGreaterThanOrEqual(0);
    expect(response.json().data.crop.bytes).toBeGreaterThan(100);
    expect(response.json().data.crop.base64).toMatch(/^\/9j\//);
    expect(response.json().data.document.size).toBeGreaterThan(1000);
    expect(response.json().data.document.base64).toMatch(/^JVBER/);
  }, 30000);
  it("rejects BrowserQL CAPTCHA-solver mutations", async () => {
    const response = await services.app.inject({
      method: "POST",
      url: "/chromium/bql?token=dev-key",
      payload: { query: "mutation { solve { found solved } }" },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("FEATURE_DISABLED");
  });
  it("waits for a browser request through BrowserQL", async () => {
    const response = await services.app.inject({
      method: "POST",
      url: "/chromium/bql?token=dev-key",
      payload: {
        query:
          "mutation { scheduled: evaluate(content: \"setTimeout(() => fetch('https://example.com'), 150); 'scheduled'\") { value } request: waitForRequest(url: \"example.com\") { url method } }",
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toMatchObject({
      scheduled: { value: "scheduled" },
      request: { method: "GET", url: "https://example.com/" },
    });
  }, 30000);
  it("sets page content and checks a checkbox through safe BrowserQL mutations", async () => {
    const response = await services.app.inject({
      method: "POST",
      url: "/chromium/bql?token=dev-key",
      payload: {
        query:
          'mutation { content(html: "<h1>Local page</h1><input id=\'enabled\' type=\'checkbox\'><input id=\'entry\'><div id=\'hidden\' style=\'display:none\'></div>") { status } enabled: checkbox(selector: "#enabled", checked: true) { checked } typed: type(selector: "#entry", text: "events") { text } value: evaluate(content: "document.querySelector(\'#entry\').value") { value } attached: waitForSelector(selector: "#enabled") { selector width } hidden: waitForSelector(selector: "#hidden", hidden: true) { selector } inputs: querySelectorAll(selector: "input") { id } stored: cookies(cookies: [{name: "bql-state", value: "yes", url: "https://example.com"}]) { updated cookies { name value } } }',
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toMatchObject({
      content: { status: 200 },
      enabled: { checked: true },
      typed: { text: "events" },
      value: { value: "events" },
      attached: { selector: "#enabled" },
      hidden: { selector: "#hidden" },
      inputs: [{ id: "enabled" }, { id: "entry" }],
      stored: {
        updated: 1,
        cookies: [expect.objectContaining({ name: "bql-state", value: "yes" })],
      },
    });
  });
  it("accepts operator-authorized long-lived persistent session state", async () => {
    const headers = { authorization: "Bearer dev-key" };
    const created = await services.app.inject({
      method: "POST",
      url: "/v1/sessions",
      headers,
      payload: { persistent: true, ttlSeconds: 7776000 },
    });
    expect(created.statusCode).toBe(200);
    expect(Date.parse(created.json().expiresAt) - Date.now()).toBeGreaterThan(
      7775000000,
    );
    await services.app.inject({
      method: "DELETE",
      url: `/v1/sessions/${created.json().id}`,
      headers,
    });
  });
  it("captures an encrypted, tenant-isolated authenticated profile for new sessions", async () => {
    const headers = { authorization: "Bearer dev-key" };
    const profileName = `example-login-${Date.now()}`;
    const source = await services.app.inject({
      method: "POST",
      url: "/v1/sessions",
      headers,
      payload: { ttlSeconds: 120 },
    });
    expect(source.statusCode).toBe(200);
    const sourceId = source.json().id as string;
    const cookie = await services.app.inject({
      method: "PUT",
      url: `/v1/sessions/${sourceId}/cookies`,
      headers,
      payload: {
        cookies: [
          {
            name: "profile-test",
            value: "secret",
            domain: "example.com",
            path: "/",
          },
        ],
      },
    });
    expect(cookie.statusCode).toBe(200);
    const saved = await services.app.inject({
      method: "POST",
      url: "/v1/profiles",
      headers,
      payload: { name: profileName, sourceSessionId: sourceId },
    });
    expect(saved.statusCode).toBe(200);
    const profileId = saved.json().id as string;
    const crossTenant = await services.app.inject({
      method: "GET",
      url: "/v1/profiles",
      headers: { authorization: "Bearer other-key" },
    });
    expect(crossTenant.json().profiles).toEqual([]);
    const resumed = await services.app.inject({
      method: "POST",
      url: "/v1/sessions",
      headers,
      payload: { ttlSeconds: 120, profileName },
    });
    expect(resumed.statusCode).toBe(200);
    const cookies = await services.app.inject({
      method: "GET",
      url: `/v1/sessions/${resumed.json().id}/cookies`,
      headers,
    });
    expect(cookies.json().cookies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "profile-test" }),
      ]),
    );
    const bqlProfile = await services.app.inject({
      method: "POST",
      url: `/chromium/bql?token=dev-key&profile=${encodeURIComponent(profileName)}`,
      payload: {
        query:
          'mutation { opened: goto(url: "https://example.com") { status } cookie: evaluate(content: "document.cookie") { value } }',
      },
    });
    expect(bqlProfile.statusCode).toBe(200);
    expect(bqlProfile.json().data.cookie.value).toContain(
      "profile-test=secret",
    );
    expect(
      (
        await services.app.inject({
          method: "DELETE",
          url: `/v1/profiles/${profileId}`,
          headers: { authorization: "Bearer other-key" },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await services.app.inject({
          method: "DELETE",
          url: `/v1/profiles/${profileId}`,
          headers,
        })
      ).statusCode,
    ).toBe(200);
    await services.app.inject({
      method: "DELETE",
      url: `/v1/sessions/${sourceId}`,
      headers,
    });
    await services.app.inject({
      method: "DELETE",
      url: `/v1/sessions/${resumed.json().id}`,
      headers,
    });
  }, 30000);
  it("meters daily usage for the authenticated API key", async () => {
    const headers = { authorization: "Bearer dev-key" };
    const before = await services.app.inject({
      method: "GET",
      url: "/v1/usage",
      headers,
    });
    expect(before.statusCode).toBe(200);
    const baseline = before.json().usage.requests as number;
    const fetch = await services.app.inject({
      method: "POST",
      url: "/v1/fetch",
      headers,
      payload: { url: "https://example.com", output: ["markdown"] },
    });
    expect(fetch.statusCode).toBe(200);
    const after = await services.app.inject({
      method: "GET",
      url: "/v1/usage",
      headers,
    });
    expect(after.statusCode).toBe(200);
    expect(after.json().usage.requests).toBeGreaterThan(baseline);
    expect(after.json().keyId).toHaveLength(12);
  }, 30000);
  it("enforces administrator-defined key route scopes and exposes the key policy", async () => {
    const restricted = { authorization: "Bearer reporting-key" };
    const usage = await services.app.inject({
      method: "GET",
      url: "/v1/usage",
      headers: restricted,
    });
    expect(usage.statusCode).toBe(200);
    expect(usage.json().policy).toBe("reporting");
    expect(usage.json().quota.dailyRequests).toBe(100000);
    expect(usage.json().quota.remaining).toBe(
      100000 - usage.json().usage.requests,
    );
    const blocked = await services.app.inject({
      method: "POST",
      url: "/v1/fetch",
      headers: restricted,
      payload: { url: "https://example.com" },
    });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error.code).toBe("FORBIDDEN");
  });
});
