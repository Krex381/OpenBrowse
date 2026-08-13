import { describe, expect, it } from "vitest";
import { htmlToMarkdown } from "../../src/execution/markdown.js";

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
});
