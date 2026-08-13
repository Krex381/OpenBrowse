import lighthouse from "lighthouse";
import { launchCdpBrowser } from "../cdp.js";
import { config } from "../config.js";
import { OpenBrowseError } from "../errors.js";
import { assertSafeUrl, normalizeUrl } from "../security.js";
import type { PerformanceReport } from "./performance.js";

const maxAudits = 200;

export type LighthouseResult = {
  report: PerformanceReport & { lighthouseVersion: string; fetchTime: string };
  rawJson: Buffer;
};

/** Runs Lighthouse in a short-lived Chromium worker, never in the pooled browsers. */
export async function fullLighthouse(
  url: string,
  options: { timeoutMs?: number; categories?: string[]; audits?: string[] } = {},
): Promise<LighthouseResult> {
  await assertSafeUrl(url);
  const chrome = await launchCdpBrowser(
    Math.max(options.timeoutMs ?? config.jobTimeoutMs, 30000),
  );
  try {
    const result = await lighthouse(
      url,
      {
        port: Number(new URL(chrome.endpoint).port), output: "json", logLevel: "silent",
        maxWaitForLoad: options.timeoutMs ?? config.jobTimeoutMs,
        disableStorageReset: true,
        onlyCategories: options.categories?.length ? options.categories : undefined,
        onlyAudits: options.audits?.length ? options.audits : undefined,
      },
      { extends: "lighthouse:default", settings: { formFactor: "desktop", screenEmulation: { disabled: true } } },
    );
    if (!result?.lhr)
      throw new OpenBrowseError("RENDER_FAILED", "Lighthouse produced no report", 422, true);
    const lhr = result.lhr;
    const finalUrl = normalizeUrl(lhr.finalDisplayedUrl || lhr.finalUrl || url);
    await assertSafeUrl(finalUrl);
    const audits = Object.fromEntries(
      Object.entries(lhr.audits).slice(0, maxAudits).map(([id, audit]) => [id, {
        title: audit.title, score: audit.score,
        ...(typeof audit.numericValue === "number" ? { numericValue: audit.numericValue } : {}),
        ...(audit.displayValue ? { displayValue: audit.displayValue } : {}),
        ...(audit.description ? { details: audit.description.slice(0, 512) } : {}),
      }]),
    );
    return {
      report: {
        requestedUrl: url, finalUrl, generatedAt: new Date().toISOString(),
        fetchTime: lhr.fetchTime, lighthouseVersion: lhr.lighthouseVersion,
        categories: Object.fromEntries(Object.entries(lhr.categories).map(([id, category]) => [id, { title: category.title, score: category.score ?? 0 }])),
        audits,
      },
      rawJson: Buffer.from(JSON.stringify(lhr)),
    };
  } catch (error) {
    if (error instanceof OpenBrowseError) throw error;
    if (error instanceof Error && /timeout|waiting/i.test(error.message))
      throw new OpenBrowseError("TARGET_TIMEOUT", "Lighthouse audit timed out", 408, true);
    throw new OpenBrowseError("RENDER_FAILED", "Lighthouse audit failed", 422, true);
  } finally {
    await chrome.stop();
  }
}
