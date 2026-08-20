import { describe, expect, it } from "vitest";
import { analyzeClientRendering, hasAccessChallenge } from "../../src/execution/shared.js";

describe("client-rendered shell analysis", () => {
  it("recognizes a Vite/React shell without escalating ordinary scripted pages", () => {
    const shell = analyzeClientRendering({
      status: 200,
      contentType: "text/html; charset=utf-8",
      html: `<!doctype html><html><body><div id="root"></div><script type="module" src="/assets/index-Ab12.js"></script></body></html>`,
    });
    expect(shell).toMatchObject({
      browserRecommended: true,
      reason: "client-rendered-shell",
    });
    expect(shell.signals).toContain("empty-app-root:#root");
    expect(shell.signals).toContain("module-script");

    const article = analyzeClientRendering({
      status: 200,
      contentType: "text/html",
      html: `<article><h1>Server rendered</h1><p>${"Useful prose ".repeat(80)}</p></article><script src="/analytics.js"></script>`,
    });
    expect(article.browserRecommended).toBe(false);
    expect(article.reason).toBe("http-content-sufficient");
  });

  it("does not use another browser for authentication, server errors, or non-HTML", () => {
    expect(analyzeClientRendering({ status: 401, contentType: "text/html", html: "<div id='root'></div>" })).toMatchObject({
      browserRecommended: false,
      reason: "http-status-terminal",
    });
    expect(analyzeClientRendering({ status: 200, contentType: "application/json", html: undefined })).toMatchObject({
      browserRecommended: false,
      reason: "non-html-response",
    });
  });

  it("recognizes challenge shells without flagging ordinary prose", () => {
    expect(hasAccessChallenge("<title>Just a moment...</title><div id='cf-chl-widget'></div>"))
      .toBe(true);
    expect(hasAccessChallenge("<article><p>This report discusses CAPTCHA accessibility.</p></article>"))
      .toBe(false);
  });
});
