import { load } from "cheerio";
import { htmlToMarkdown, readableContentHtml } from "./markdown.js";
import type {
  ArticleAccess,
  ArticleMetadata,
  ArticleResult,
  BrowserBackendId,
  ProvenanceRecord,
} from "./types.js";

const restrictedPatterns: Array<[string, RegExp]> = [
  ["schema-paywall", /"isAccessibleForFree"\s*:\s*(?:false|"false")/i],
  ["subscription-required", /subscribe\s+to\s+(?:continue|read)|subscription\s+required/i],
  ["sign-in-required", /sign\s+in\s+to\s+continue/i],
  ["paywall-marker", /paywall|meteredContent|premium-content/i],
  ["german-access-marker", /weiterlesen\s+mit\s+(?:ihrem\s+)?digitalen\s+zugang/i],
];

function clean(value: string | undefined): string | undefined {
  const result = value?.replace(/\s+/g, " ").trim();
  return result || undefined;
}

function absolute(value: string | undefined, base: string): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value, base);
    return /^https?:$/.test(url.protocol) ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && clean(value)) return clean(value);
    if (Array.isArray(value)) {
      const nested = firstString(...value);
      if (nested) return nested;
    }
    if (value && typeof value === "object") {
      const record = value as Record<string, unknown>;
      const nested = firstString(record.name, record.url);
      if (nested) return nested;
    }
  }
  return undefined;
}

function articleJsonLd(html: string): Record<string, unknown> | undefined {
  const $ = load(html);
  for (const element of $("script[type='application/ld+json']").toArray()) {
    try {
      const parsed = JSON.parse($(element).text()) as unknown;
      const candidates = Array.isArray(parsed)
        ? parsed
        : parsed && typeof parsed === "object" && Array.isArray((parsed as Record<string, unknown>)["@graph"])
          ? ((parsed as Record<string, unknown>)["@graph"] as unknown[])
          : [parsed];
      const article = candidates.find((candidate) => {
        if (!candidate || typeof candidate !== "object") return false;
        const type = (candidate as Record<string, unknown>)["@type"];
        const values = Array.isArray(type) ? type : [type];
        return values.some((value) =>
          typeof value === "string" && /(?:News)?Article|BlogPosting|Reportage/i.test(value),
        );
      });
      if (article && typeof article === "object") return article as Record<string, unknown>;
    } catch {
      // Invalid publisher JSON-LD is ignored; meta tags remain available.
    }
  }
  return undefined;
}

export function extractArticle(
  html: string,
  sourceUrl: string,
  finalUrl: string,
  strategy: "http" | "browser",
  browserBackend?: BrowserBackendId,
): ArticleResult {
  const $ = load(html);
  const jsonLd = articleJsonLd(html);
  const meta = (name: string) =>
    clean(
      $(`meta[property='${name}'],meta[name='${name}']`).first().attr("content"),
    );
  const canonical = absolute(
    $("link[rel='canonical']").first().attr("href") ?? meta("og:url"),
    finalUrl,
  );
  const metadata: ArticleMetadata = {
    ...(firstString(jsonLd?.headline, meta("og:title"), $("h1").first().text(), $("title").text())
      ? { title: firstString(jsonLd?.headline, meta("og:title"), $("h1").first().text(), $("title").text()) }
      : {}),
    ...(firstString(jsonLd?.description, meta("description"), meta("og:description"))
      ? { description: firstString(jsonLd?.description, meta("description"), meta("og:description")) }
      : {}),
    ...(firstString(jsonLd?.author, meta("author"), meta("article:author"))
      ? { author: firstString(jsonLd?.author, meta("author"), meta("article:author")) }
      : {}),
    ...(firstString(jsonLd?.datePublished, meta("article:published_time"))
      ? { publishedAt: firstString(jsonLd?.datePublished, meta("article:published_time")) }
      : {}),
    ...(firstString(jsonLd?.dateModified, meta("article:modified_time"))
      ? { modifiedAt: firstString(jsonLd?.dateModified, meta("article:modified_time")) }
      : {}),
    ...(clean($("html").attr("lang")) ? { language: clean($("html").attr("lang")) } : {}),
    ...(canonical ? { canonicalUrl: canonical } : {}),
    ...(absolute(firstString(jsonLd?.image, meta("og:image")), finalUrl)
      ? { image: absolute(firstString(jsonLd?.image, meta("og:image")), finalUrl) }
      : {}),
    ...(firstString(jsonLd?.publisher, meta("og:site_name"))
      ? { siteName: firstString(jsonLd?.publisher, meta("og:site_name")) }
      : {}),
  };
  const readable = readableContentHtml(html);
  const readableDom = load(readable.html);
  const text = readableDom.root().text().replace(/\s+/g, " ").trim();
  const signals = restrictedPatterns
    .filter(([, pattern]) => pattern.test(html))
    .map(([name]) => name);
  if (readable.paywallDetected && !signals.includes("content-truncated"))
    signals.push("content-truncated");
  const paywallDetected = readable.paywallDetected || signals.length > 0;
  const wordCount = text ? text.split(/\s+/u).length : 0;
  const access: ArticleAccess = {
    status: paywallDetected ? (wordCount > 40 ? "partial" : "restricted") : "open",
    restricted: paywallDetected,
    ...(paywallDetected ? { type: "paywall" as const } : {}),
    contentScope: paywallDetected ? "public-teaser" : "full",
    paywallDetected,
    signals,
  };
  const source = {
    method: strategy,
    ...(browserBackend ? { backend: browserBackend } : {}),
    url: finalUrl,
  } as const;
  const evidence: ProvenanceRecord[] = [];
  if (metadata.title)
    evidence.push({
      claim: `title:${metadata.title}`,
      source: { ...source, view: "metadata", selector: "JSON-LD headline, og:title, h1, title" },
      evidence: jsonLd?.headline ? "METADATA" : "DIRECT",
    });
  if (metadata.author)
    evidence.push({
      claim: `author:${metadata.author}`,
      source: { ...source, view: "metadata", selector: "JSON-LD author, meta author" },
      evidence: "METADATA",
    });
  if (text)
    evidence.push({
      claim: `primary-content:${wordCount}-words`,
      source: { ...source, view: "main-content", selector: "scored semantic content region" },
      evidence: "DIRECT",
    });
  if (paywallDetected)
    evidence.push({
      claim: "access:paywall",
      source: { ...source, view: "document", selector: signals.join(",") },
      evidence: signals.includes("schema-paywall") ? "METADATA" : "DIRECT",
    });
  return {
    text,
    markdown: htmlToMarkdown(html, finalUrl),
    wordCount,
    metadata,
    access,
    provenance: {
      sourceUrl,
      finalUrl,
      extractedAt: new Date().toISOString(),
      strategy,
      ...(browserBackend ? { browserBackend } : {}),
    },
    evidence,
  };
}
