import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type BrowserContext } from "playwright";
import { chromiumExtensionArgs, config } from "../config.js";
import { OpenBrowseError } from "../errors.js";
import { assertSafeUrl, normalizeUrl } from "../security.js";
import { BrowserPool } from "./pool.js";
import { proxySettings, timeout } from "./shared.js";
import type { FetchInput } from "./types.js";

export async function screenshot(
  pool: BrowserPool,
  input: FetchInput & {
    format?: "png" | "jpeg";
    fullPage?: boolean;
    quality?: number;
  },
): Promise<Buffer> {
  await assertSafeUrl(input.url, input.proxy?.allowedDomains);
  return pool.withContext(
    input.viewport,
    input.proxy,
    async (_context, page) => {
      await page.goto(input.url, {
        waitUntil: input.waitUntil ?? "networkidle",
        timeout: timeout(input.timeoutMs),
      });
      return page.screenshot({
        type: input.format === "jpeg" ? "jpeg" : "png",
        fullPage: input.fullPage ?? true,
        ...(input.format === "jpeg" && input.quality
          ? { quality: input.quality }
          : {}),
      });
    },
  );
}

export async function pdf(
  pool: BrowserPool,
  input: FetchInput & {
    format?: string;
    landscape?: boolean;
    printBackground?: boolean;
    margin?: { top?: string; right?: string; bottom?: string; left?: string };
  },
): Promise<Buffer> {
  await assertSafeUrl(input.url, input.proxy?.allowedDomains);
  return pool.withContext(
    input.viewport,
    input.proxy,
    async (_context, page) => {
      await page.goto(input.url, {
        waitUntil: input.waitUntil ?? "networkidle",
        timeout: timeout(input.timeoutMs),
      });
      return page.pdf({
        format: input.format ?? "A4",
        landscape: input.landscape ?? false,
        printBackground: input.printBackground ?? true,
        ...(input.margin ? { margin: input.margin } : {}),
      });
    },
  );
}

export async function recordVideo(
  input: FetchInput & { durationMs?: number },
): Promise<{ body: Buffer; finalUrl: string }> {
  await assertSafeUrl(input.url, input.proxy?.allowedDomains);
  const directory = await mkdtemp(join(tmpdir(), "openbrowse-video-"));
  const browser = await chromium.launch({
    headless: true,
    chromiumSandbox: config.chromiumSandbox,
    args: chromiumExtensionArgs,
  });
  let context: BrowserContext | undefined;
  try {
    const size = {
      width: input.viewport?.width ?? 1280,
      height: input.viewport?.height ?? 720,
    };
    context = await browser.newContext({
      viewport: size,
      recordVideo: { dir: directory, size },
      serviceWorkers: "block",
      ...(input.proxy ? { proxy: proxySettings(input.proxy) } : {}),
    });
    await context.route("**/*", async (route) => {
      try {
        await assertSafeUrl(route.request().url(), input.proxy?.allowedDomains);
        await route.continue();
      } catch {
        await route.abort("blockedbyclient");
      }
    });
    const page = await context.newPage();
    const video = page.video();
    await page.goto(input.url, {
      waitUntil: input.waitUntil ?? "domcontentloaded",
      timeout: timeout(input.timeoutMs),
    });
    const html = await page.content();
    if (/captcha|recaptcha|hcaptcha|cf-chl-/i.test(html))
      throw new OpenBrowseError(
        "CAPTCHA_DETECTED",
        "A challenge was detected and the configured policy is fail",
        423,
      );
    await new Promise((resolve) =>
      setTimeout(
        resolve,
        Math.min(Math.max(input.durationMs ?? 1500, 0), 10000),
      ),
    );
    const finalUrl = normalizeUrl(page.url());
    await context.close();
    context = undefined;
    const path = await video?.path();
    if (!path)
      throw new OpenBrowseError(
        "RENDER_FAILED",
        "Browser did not produce a video recording",
        422,
        true,
      );
    const body = await readFile(path);
    if (body.length > config.maxResponseBytes)
      throw new OpenBrowseError(
        "PAYLOAD_TOO_LARGE",
        "Recording exceeds the configured artifact byte limit",
        413,
      );
    return { body, finalUrl };
  } catch (error: unknown) {
    if (error instanceof OpenBrowseError) throw error;
    if (error instanceof Error && /Timeout/i.test(error.message))
      throw new OpenBrowseError(
        "TARGET_TIMEOUT",
        "Video recording timed out",
        408,
        true,
      );
    throw new OpenBrowseError(
      "RENDER_FAILED",
      "Video recording failed",
      422,
      true,
    );
  } finally {
    await context?.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
}
