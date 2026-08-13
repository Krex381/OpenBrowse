import { describe, expect, it } from "vitest";
import { htmlToMarkdown, readableContentHtml } from "../../src/execution/markdown.js";

describe("HTML to Markdown extraction", () => {
  it("keeps semantic headings, links, lists, code, and tables", () => {
    const markdown = htmlToMarkdown(
      `<!doctype html><html><body>
        <nav>Ignore navigation</nav>
        <article>
          <h1>OpenBrowse guide</h1>
          <p>Read <a href="/docs">the docs</a> and <strong>stay safe</strong>.</p>
          <ul><li>HTTP first</li><li>Browser fallback</li></ul>
          <pre><code class="language-ts">const value = 1;</code></pre>
          <table><tr><th>Name</th><th>State</th></tr><tr><td>pool</td><td>healthy</td></tr></table>
        </article>
        <footer>Ignore footer</footer>
      </body></html>`,
      "https://openbrowse.example/guide",
    );
    expect(markdown).toContain("# OpenBrowse guide");
    expect(markdown).toContain("[the docs](https://openbrowse.example/docs)");
    expect(markdown).toContain("**stay safe**");
    expect(markdown).toContain("- HTTP first");
    expect(markdown).toContain("```ts\nconst value = 1;\n```");
    expect(markdown).toContain("| Name | State |");
    expect(markdown).not.toContain("Ignore navigation");
    expect(markdown).not.toContain("Ignore footer");
  });

  it("uses the body when no readable main-content element exists", () => {
    expect(
      htmlToMarkdown("<body><h2>Status</h2><p>Everything is ready.</p></body>", "https://example.com"),
    ).toBe("## Status\n\nEverything is ready.");
  });

  it("isolates article content, removes chrome, and stops at an access boundary", () => {
    const html = `<!doctype html><body>
      <nav><a href="/news">Latest news</a></nav>
      <div class="container">
        <div class="kmm-article-box">
          <h1>Public investigation</h1>
          <p>The accessible introduction explains the allegations.</p>
          <div class="audio-player">Previous ten seconds</div>
          <a href="https://google.com/preferences">Add as preferred Google source</a>
          <div>Weiterlesen mit Ihrem digitalen Zugang</div>
          <section class="related-stories"><a href="/other">Related story</a></section>
        </div>
        <aside class="sidebar"><a href="/popular">Most read</a></aside>
      </div>
      <footer><a href="/privacy">Privacy</a></footer>
    </body>`;
    const readable = readableContentHtml(html);
    expect(readable.paywallDetected).toBe(true);
    expect(readable.html).toContain("Public investigation");
    expect(readable.html).not.toContain("Related story");
    expect(readable.html).not.toContain("Most read");
    expect(readable.html).not.toContain("Privacy");
    expect(readable.html).not.toContain("Previous ten seconds");
    expect(readable.html).not.toContain("preferred Google source");

    const markdown = htmlToMarkdown(html, "https://example.com/article");
    expect(markdown).toContain("# Public investigation");
    expect(markdown).toContain("accessible introduction");
    expect(markdown).toContain("Paywall notice");
    expect(markdown).not.toContain("Related story");
  });
});
