import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "../config.js";
import { assertBoundedBuffer } from "../bounds.js";
import { OpenBrowseError } from "../errors.js";
import { assertSafeUrl, normalizeUrl } from "../security.js";
import { BrowserPool } from "./pool.js";
import { hasAccessChallenge, timeout } from "./shared.js";
import { runChallengeFallback } from "./challenge-fallback.js";
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
  const fallback = await runChallengeFallback(
    pool,
    input,
    input.browserBackend ?? config.defaultBrowserBackend,
    async (backend, backendOptions) => {
      const value = await pool.withContext(
        input.viewport,
        input.proxy,
        async (_context, page) => {
          await page.goto(input.url, {
            waitUntil: input.waitUntil ?? "networkidle",
            timeout: timeout(input.timeoutMs),
          });
          const challengeDetected = hasAccessChallenge(await page.content());
          const body = assertBoundedBuffer(
            await page.screenshot({
              type: input.format === "jpeg" ? "jpeg" : "png",
              fullPage: input.fullPage ?? true,
              ...(input.format === "jpeg" && input.quality
                ? { quality: input.quality }
                : {}),
            }),
            "Screenshot",
          );
          return { body, challengeDetected };
        },
        backend,
        backendOptions,
      );
      return { value, challengeDetected: value.challengeDetected };
    },
    "screenshots",
  );
  return fallback.value.body;
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
  const fallback = await runChallengeFallback(
    pool,
    input,
    input.browserBackend ?? config.defaultBrowserBackend,
    async (backend, backendOptions) => {
      const value = await pool.withContext(
        input.viewport,
        input.proxy,
        async (_context, page) => {
          await page.goto(input.url, {
            waitUntil: input.waitUntil ?? "networkidle",
            timeout: timeout(input.timeoutMs),
          });
          const challengeDetected = hasAccessChallenge(await page.content());
          const body = assertBoundedBuffer(
            await page.pdf({
              format: input.format ?? "A4",
              landscape: input.landscape ?? false,
              printBackground: input.printBackground ?? true,
              ...(input.margin ? { margin: input.margin } : {}),
            }),
            "PDF",
          );
          return { body, challengeDetected };
        },
        backend,
        backendOptions,
      );
      return { value, challengeDetected: value.challengeDetected };
    },
    "pdf",
  );
  return fallback.value.body;
}

export async function recordVideo(
  pool: BrowserPool,
  input: FetchInput & { durationMs?: number },
): Promise<{
  body: Buffer;
  finalUrl: string;
  execution: {
    backendAttempts: string[];
    selectedBackend: string;
    challengeRemaining: boolean;
  };
}> {
  await assertSafeUrl(input.url, input.proxy?.allowedDomains);
  const directory = await mkdtemp(join(tmpdir(), "openbrowse-video-"));
  try {
    const size = {
      width: input.viewport?.width ?? 1280,
      height: input.viewport?.height ?? 720,
    };
    const fallback = await runChallengeFallback(
      pool,
      input,
      input.browserBackend ?? config.defaultBrowserBackend,
      async (backend, backendOptions) => {
        const value = await pool.withContext(
          input.viewport,
          input.proxy,
          async (_context, page) => {
            const video = page.video();
            await page.goto(input.url, {
              waitUntil: input.waitUntil ?? "domcontentloaded",
              timeout: timeout(input.timeoutMs),
            });
            const challengeDetected = hasAccessChallenge(await page.content());
            if (!challengeDetected)
              await new Promise((resolve) =>
                setTimeout(
                  resolve,
                  Math.min(Math.max(input.durationMs ?? 1500, 0), 10000),
                ),
              );
            return {
              video,
              finalUrl: normalizeUrl(page.url()),
              challengeDetected,
            };
          },
          backend,
          backendOptions,
          { recordVideo: { dir: directory, size } },
        );
        return { value, challengeDetected: value.challengeDetected };
      },
      "recordings",
    );
    const video = fallback.value.video;
    if (!video)
      throw new OpenBrowseError(
        "RENDER_FAILED",
        "Browser did not produce a video recording",
        422,
        true,
      );
    const path = join(directory, `${crypto.randomUUID()}.webm`);
    await video.saveAs(path);
    const body = await readFile(path);
    if (body.length > config.maxResponseBytes)
      throw new OpenBrowseError(
        "PAYLOAD_TOO_LARGE",
        "Recording exceeds the configured artifact byte limit",
        413,
      );
    return {
      body,
      finalUrl: fallback.value.finalUrl,
      execution: {
        backendAttempts: fallback.backendAttempts,
        selectedBackend: fallback.selectedBackend,
        challengeRemaining: fallback.challengeRemaining,
      },
    };
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
      { cause: error instanceof Error ? error.message : "unknown error" },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
