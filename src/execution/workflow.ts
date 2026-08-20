import { config } from "../config.js";
import { assertBoundedJson } from "../bounds.js";
import { OpenBrowseError } from "../errors.js";
import { assertSafeUrl, normalizeUrl } from "../security.js";
import { BrowserPool } from "./pool.js";
import { hasAccessChallenge, timeout } from "./shared.js";
import { runChallengeFallback } from "./challenge-fallback.js";
import type { FetchInput } from "./types.js";

export type WorkflowStep =
  | { action: "wait"; selector: string }
  | { action: "click"; selector: string; index?: number }
  | { action: "fill"; selector: string; value: string }
  | { action: "press"; selector: string; key: string }
  | {
      action: "extract";
      name: string;
      selector: string;
      type: "text" | "html" | "attribute";
      attribute?: string;
      all?: boolean;
    };

export async function runWorkflow(
  pool: BrowserPool,
  input: FetchInput,
  steps: WorkflowStep[],
): Promise<{
  finalUrl: string;
  title: string;
  outputs: Record<string, unknown>;
  execution: {
    backendAttempts: string[];
    selectedBackend: string;
    challengeRemaining: boolean;
  };
}> {
  await assertSafeUrl(input.url, input.proxy?.allowedDomains);
  return runChallengeFallback(
    pool,
    input,
    input.browserBackend ?? config.defaultBrowserBackend,
    async (backend, backendOptions) => {
      const value = await pool.withContext(
        input.viewport,
        input.proxy,
        async (_context, page) => {
          page.setDefaultNavigationTimeout(timeout(input.timeoutMs));
          await page.goto(input.url, {
            waitUntil: input.waitUntil ?? "domcontentloaded",
            timeout: timeout(input.timeoutMs),
          });
          const outputs: Record<string, unknown> = {};
          let stepError: unknown;
          try {
            for (const step of steps) {
              const locator = page.locator(step.selector);
              if (step.action === "wait")
                await locator.waitFor({
                  state: "visible",
                  timeout: timeout(input.timeoutMs),
                });
              else if (step.action === "click")
                await locator
                  .nth(step.index ?? 0)
                  .click({ timeout: timeout(input.timeoutMs) });
              else if (step.action === "fill")
                await locator.fill(step.value, {
                  timeout: timeout(input.timeoutMs),
                });
              else if (step.action === "press")
                await locator.press(step.key, {
                  timeout: timeout(input.timeoutMs),
                });
              else {
                const values = await locator.evaluateAll(
                  (nodes, rule) =>
                    nodes.map((node) => {
                      const element = node as unknown as {
                        innerHTML: string;
                        getAttribute(name: string): string | null;
                        textContent: string | null;
                      };
                      if (rule.type === "html") return element.innerHTML;
                      if (rule.type === "attribute")
                        return element.getAttribute(rule.attribute ?? "");
                      return element.textContent?.trim() ?? "";
                    }),
                  step,
                );
                outputs[step.name] = step.all ? values : (values[0] ?? null);
              }
            }
          } catch (error) {
            stepError = error;
          }
          const challengeDetected = hasAccessChallenge(await page.content());
          if (stepError && !challengeDetected) throw stepError;
          return {
            finalUrl: normalizeUrl(page.url()),
            title: await page.title(),
            outputs,
            challengeDetected,
          };
        },
        backend,
        backendOptions,
      );
      return { value, challengeDetected: value.challengeDetected };
    },
  )
    .then((fallback) =>
      assertBoundedJson(
        {
          finalUrl: fallback.value.finalUrl,
          title: fallback.value.title,
          outputs: fallback.value.outputs,
          execution: {
            backendAttempts: fallback.backendAttempts,
            selectedBackend: fallback.selectedBackend,
            challengeRemaining: fallback.challengeRemaining,
          },
        },
        "Workflow output",
      ),
    )
    .catch((error: unknown) => {
      if (error instanceof OpenBrowseError) throw error;
      if (error instanceof Error && /Timeout/i.test(error.message))
        throw new OpenBrowseError(
          "TARGET_TIMEOUT",
          "Workflow step timed out",
          408,
          true,
        );
      throw new OpenBrowseError(
        "RENDER_FAILED",
        "Workflow execution failed",
        422,
        true,
      );
    });
}

export interface DownloadResult {
  body: Buffer;
  filename: string;
  contentType: string;
  sourceUrl: string;
}

/** A typed alternative to Browserless's arbitrary-JS /download API. */
export async function browserDownload(
  pool: BrowserPool,
  input: FetchInput & { selector: string; index?: number },
): Promise<DownloadResult> {
  await assertSafeUrl(input.url, input.proxy?.allowedDomains);
  return pool
    .withContext(input.viewport, input.proxy, async (_context, page) => {
      page.setDefaultNavigationTimeout(timeout(input.timeoutMs));
      await page.goto(input.url, {
        waitUntil: input.waitUntil ?? "domcontentloaded",
        timeout: timeout(input.timeoutMs),
      });
      const [download] = await Promise.all([
        page.waitForEvent("download", { timeout: timeout(input.timeoutMs) }),
        page
          .locator(input.selector)
          .nth(input.index ?? 0)
          .click({ timeout: timeout(input.timeoutMs) }),
      ]);
      const sourceUrl = download.url();
      await assertSafeUrl(sourceUrl, input.proxy?.allowedDomains);
      const stream = await download.createReadStream();
      if (!stream)
        throw new OpenBrowseError(
          "RENDER_FAILED",
          "Browser did not provide a readable download stream",
          422,
          true,
        );
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of stream) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buffer.length;
        if (bytes > config.maxResponseBytes)
          throw new OpenBrowseError(
            "PAYLOAD_TOO_LARGE",
            "Downloaded file exceeds the configured byte limit",
            413,
          );
        chunks.push(buffer);
      }
      const body = Buffer.concat(chunks, bytes);
      const filename =
        download
          .suggestedFilename()
          .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
          .slice(0, 180) || "download";
      const contentType = filename.toLowerCase().endsWith(".csv")
        ? "text/csv; charset=utf-8"
        : filename.toLowerCase().endsWith(".json")
          ? "application/json; charset=utf-8"
          : "application/octet-stream";
      return { body, filename, contentType, sourceUrl };
    })
    .catch((error: unknown) => {
      if (error instanceof OpenBrowseError) throw error;
      if (error instanceof Error && /Timeout/i.test(error.message))
        throw new OpenBrowseError(
          "TARGET_TIMEOUT",
          `Download did not complete within ${timeout(input.timeoutMs)}ms`,
          408,
          true,
        );
      throw new OpenBrowseError(
        "RENDER_FAILED",
        "Browser download failed",
        422,
        true,
      );
    });
}
