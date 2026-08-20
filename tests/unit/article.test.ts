import { describe, expect, it } from "vitest";
import { extractArticle } from "../../src/execution/article.js";

describe("structured article extraction", () => {
  it("combines JSON-LD, Open Graph, readable text, access, and provenance", () => {
    const article = extractArticle(
      `<!doctype html><html lang="en"><head>
        <link rel="canonical" href="/canonical">
        <meta property="og:site_name" content="Example News">
        <script type="application/ld+json">{
          "@type":"NewsArticle","headline":"Verified title",
          "author":{"@type":"Person","name":"Alex Writer"},
          "datePublished":"2026-08-14T08:00:00Z",
          "image":{"url":"/lead.jpg"},"isAccessibleForFree":false
        }</script></head><body><article>
          <h1>Fallback title</h1><p>This public introduction has enough words to be useful for a concise article extraction result.</p>
          <div>Subscribe to continue</div><p>Hidden subscriber text.</p>
        </article></body></html>`,
      "https://example.com/story",
      "https://example.com/story?ref=home",
      "http",
    );
    expect(article.metadata).toMatchObject({
      title: "Verified title",
      author: "Alex Writer",
      language: "en",
      canonicalUrl: "https://example.com/canonical",
      image: "https://example.com/lead.jpg",
      siteName: "Example News",
    });
    expect(article.access.paywallDetected).toBe(true);
    expect(article.access.signals).toContain("schema-paywall");
    expect(article.markdown).toContain("Paywall notice");
    expect(article.provenance).toMatchObject({
      sourceUrl: "https://example.com/story",
      finalUrl: "https://example.com/story?ref=home",
      strategy: "http",
    });
  });

  it("reports open access when no restriction signal is present", () => {
    const article = extractArticle(
      "<article><h1>Open</h1><p>Freely readable reporting.</p></article>",
      "https://example.com/open",
      "https://example.com/open",
      "browser",
      "playwright-chromium",
    );
    expect(article.access).toEqual({
      status: "open",
      restricted: false,
      contentScope: "full",
      paywallDetected: false,
      signals: [],
    });
    expect(article.provenance.browserBackend).toBe("playwright-chromium");
    expect(article.evidence).toContainEqual(
      expect.objectContaining({ evidence: "DIRECT" }),
    );
  });
});
