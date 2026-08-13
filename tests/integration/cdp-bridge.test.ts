import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AddressInfo } from "node:net";
import WebSocket from "ws";
import { chromium, webkit } from "playwright";
import type { Services } from "../../src/server.js";
import { buildServer } from "../../src/server.js";

let services: Services;
let port: number;

beforeAll(async () => {
  services = await buildServer();
  await services.app.listen({ host: "127.0.0.1", port: 0 });
  port = (services.app.server.address() as AddressInfo).port;
});
afterAll(async () => {
  if (services) await services.close();
});

describe("raw CDP migration bridge", () => {
  it("forwards a Chromium DevTools command through the authenticated WebSocket", async () => {
    const response = await new Promise<{
      id: number;
      result?: { product?: string };
    }>((resolve, reject) => {
      const socket = new WebSocket(
        `ws://127.0.0.1:${port}/chromium?token=dev-key&timeout=10000`,
      );
      const timer = setTimeout(() => {
        socket.close();
        reject(new Error("CDP bridge timed out"));
      }, 15000);
      socket.on("open", () =>
        socket.send(JSON.stringify({ id: 1, method: "Browser.getVersion" })),
      );
      socket.on("message", (data) => {
        const message = JSON.parse(data.toString()) as {
          id?: number;
          result?: { product?: string };
        };
        if (message.id === 1) {
          clearTimeout(timer);
          socket.close();
          resolve({ id: message.id, result: message.result });
        }
      });
      socket.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    expect(response.result?.product).toContain("Chrome/");
  }, 30000);
  it("accepts a real Playwright CDP client through the Chromium migration route", async () => {
    const launch = Buffer.from(
      JSON.stringify({ args: ["--disable-gpu", "--lang=de-DE"], slowMo: 1 }),
    ).toString("base64");
    const browser = await chromium.connectOverCDP(
      `ws://127.0.0.1:${port}/chromium?token=dev-key&timeout=10000&launch=${encodeURIComponent(launch)}`,
    );
    try {
      const context = browser.contexts()[0];
      const page = context.pages()[0];
      await page.goto("https://example.com", { waitUntil: "domcontentloaded" });
      expect(await page.title()).toBe("Example Domain");
    } finally {
      await browser.close();
    }
  }, 30000);
  it("proxies a native WebKit Playwright session through the authenticated route", async () => {
    const browser = await webkit.connect(
      `ws://127.0.0.1:${port}/webkit/playwright?token=dev-key&timeout=10000`,
    );
    try {
      const context = await browser.newContext({ ignoreHTTPSErrors: true });
      const page = await context.newPage();
      await page.goto("https://example.com", { waitUntil: "domcontentloaded" });
      expect(await page.title()).toBe("Example Domain");
      await context.close();
    } finally {
      await browser.close();
    }
  }, 30000);
});
