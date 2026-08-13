import { BrowserPool, type FetchInput } from "../execution.js";
import { OpenBrowseError } from "../errors.js";
import { assertSafeUrl, normalizeUrl } from "../security.js";

export interface PerformanceReport {
  requestedUrl: string;
  finalUrl: string;
  generatedAt: string;
  categories: Record<string, { score: number; title: string }>;
  audits: Record<
    string,
    {
      title: string;
      score: number | null;
      numericValue?: number;
      displayValue?: string;
      details?: string;
    }
  >;
}

type PageMetrics = {
  domContentLoaded: number;
  load: number;
  responseStart: number;
  firstContentfulPaint: number;
  resourceTransfer: number;
  resourceCount: number;
  title: string;
  hasViewport: boolean;
  imageCount: number;
  imagesWithoutAlt: number;
  hasLang: boolean;
};

export async function basicPerformance(
  pool: BrowserPool,
  input: FetchInput,
  options: { categories?: string[]; audits?: string[] } = {},
): Promise<PerformanceReport> {
  await assertSafeUrl(input.url, input.proxy?.allowedDomains);
  const wanted = new Set(options.audits ?? []);
  const keep = (id: string): boolean => wanted.size === 0 || wanted.has(id);
  return pool
    .withContext(input.viewport, input.proxy, async (_context, page) => {
      const start = Date.now();
      let transferBytes = 0;
      let requestCount = 0;
      page.on("response", (response) => {
        requestCount++;
        const length = Number(response.headers()["content-length"] ?? 0);
        if (Number.isFinite(length) && length > 0) transferBytes += length;
      });
      await page.goto(input.url, {
        waitUntil: input.waitUntil ?? "networkidle",
        timeout: input.timeoutMs ?? 30000,
      });
      const metrics = await page.evaluate((): PageMetrics => {
        const browserPerformance = performance as unknown as {
          getEntriesByType(
            type: string,
          ): Array<{
            name: string;
            startTime: number;
            domContentLoadedEventEnd?: number;
            loadEventEnd?: number;
            responseStart?: number;
            transferSize?: number;
          }>;
        };
        const navigation = browserPerformance.getEntriesByType("navigation")[0];
        const paint = browserPerformance.getEntriesByType("paint");
        const fcp = paint.find(
          (entry) => entry.name === "first-contentful-paint",
        )?.startTime;
        const resources = browserPerformance.getEntriesByType("resource");
        const totalTransfer = resources.reduce(
          (total, entry) => total + (entry.transferSize || 0),
          0,
        );
        const pageDocument = (
          globalThis as unknown as {
            document: {
              querySelector(
                value: string,
              ): { getAttribute(value: string): string | null } | null;
              images: Array<{ hasAttribute(value: string): boolean }>;
              title: string;
              documentElement: { getAttribute(value: string): string | null };
            };
          }
        ).document;
        const viewport =
          pageDocument
            .querySelector('meta[name="viewport"]')
            ?.getAttribute("content") ?? "";
        const images = [...pageDocument.images];
        return {
          domContentLoaded: navigation?.domContentLoadedEventEnd ?? 0,
          load: navigation?.loadEventEnd ?? 0,
          responseStart: navigation?.responseStart ?? 0,
          firstContentfulPaint: fcp ?? 0,
          resourceTransfer: totalTransfer,
          resourceCount: resources.length,
          title: pageDocument.title,
          hasViewport: /width|initial-scale/i.test(viewport),
          imageCount: images.length,
          imagesWithoutAlt: images.filter((image) => !image.hasAttribute("alt"))
            .length,
          hasLang: Boolean(pageDocument.documentElement.getAttribute("lang")),
        };
      });
      const finalUrl = normalizeUrl(page.url());
      const navigationMs = Math.max(0, Date.now() - start);
      const performanceScore = Math.max(
        0,
        Math.min(
          1,
          1 - Math.max(metrics.load || navigationMs, navigationMs) / 10000,
        ),
      );
      const accessibilityScore =
        metrics.imageCount === 0
          ? 1
          : Math.max(0, 1 - metrics.imagesWithoutAlt / metrics.imageCount);
      const seoScore =
        [
          finalUrl.startsWith("https://"),
          metrics.hasViewport,
          metrics.hasLang,
        ].filter(Boolean).length / 3;
      const auditEntries: PerformanceReport["audits"] = {};
      const add = (
        id: string,
        audit: PerformanceReport["audits"][string],
      ): void => {
        if (keep(id)) auditEntries[id] = audit;
      };
      add("is-on-https", {
        title: "Uses HTTPS",
        score: finalUrl.startsWith("https://") ? 1 : 0,
      });
      add("viewport", {
        title: "Has a responsive viewport meta tag",
        score: metrics.hasViewport ? 1 : 0,
      });
      add("html-has-lang", {
        title: "Document has an HTML language",
        score: metrics.hasLang ? 1 : 0,
      });
      add("image-alt", {
        title: "Image elements have alternative text",
        score: accessibilityScore,
        details: `${metrics.imagesWithoutAlt} of ${metrics.imageCount} images lack alt text`,
      });
      add("first-contentful-paint", {
        title: "First Contentful Paint",
        score: metrics.firstContentfulPaint
          ? Math.max(0, 1 - metrics.firstContentfulPaint / 4000)
          : null,
        numericValue: metrics.firstContentfulPaint,
        displayValue: `${Math.round(metrics.firstContentfulPaint)} ms`,
      });
      add("dom-content-loaded", {
        title: "DOM Content Loaded",
        score: Math.max(0, 1 - metrics.domContentLoaded / 5000),
        numericValue: metrics.domContentLoaded,
        displayValue: `${Math.round(metrics.domContentLoaded)} ms`,
      });
      add("load-time", {
        title: "Page Load",
        score: Math.max(0, 1 - (metrics.load || navigationMs) / 10000),
        numericValue: metrics.load || navigationMs,
        displayValue: `${Math.round(metrics.load || navigationMs)} ms`,
      });
      add("total-byte-weight", {
        title: "Total network transfer",
        score: Math.max(
          0,
          1 - (metrics.resourceTransfer || transferBytes) / 5_000_000,
        ),
        numericValue: metrics.resourceTransfer || transferBytes,
        displayValue: `${metrics.resourceTransfer || transferBytes} bytes across ${metrics.resourceCount || requestCount} resources`,
      });
      const categories: PerformanceReport["categories"] = {
        performance: { title: "Performance", score: performanceScore },
        accessibility: { title: "Accessibility", score: accessibilityScore },
        "best-practices": {
          title: "Best Practices",
          score: finalUrl.startsWith("https://") ? 1 : 0.5,
        },
        seo: { title: "SEO", score: seoScore },
      };
      const selectedCategories = options.categories?.length
        ? Object.fromEntries(
            Object.entries(categories).filter(([key]) =>
              options.categories?.includes(key),
            ),
          )
        : categories;
      return {
        requestedUrl: input.url,
        finalUrl,
        generatedAt: new Date().toISOString(),
        categories: selectedCategories,
        audits: auditEntries,
      };
    })
    .catch((error: unknown) => {
      if (error instanceof OpenBrowseError) throw error;
      if (error instanceof Error && /Timeout/i.test(error.message))
        throw new OpenBrowseError(
          "TARGET_TIMEOUT",
          "Performance audit timed out",
          408,
          true,
        );
      throw new OpenBrowseError(
        "RENDER_FAILED",
        "Performance audit failed",
        422,
        true,
      );
    });
}
