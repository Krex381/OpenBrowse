import { useState } from "react";
import { ArrowUpRight, Check, Copy, FileText, LockKeyhole, Network, Radar, ShieldCheck, TerminalSquare } from "lucide-react";
import { requestExample } from "../content";

function Mark({ children }: { children: React.ReactNode }) {
  return <span className="mark">{children}</span>;
}

export function ProofBand() {
  const marks = ["HTTP-first", "Tenant-bound", "Self-hosted", "Auditable", "No stealth"];
  return <div className="proof-band" aria-label="OpenBrowse operating principles">{marks.map((mark) => <span key={mark}><Mark>×</Mark>{mark}</span>)}</div>;
}

export function MethodSection() {
  return (
    <section className="method-section" id="method" aria-labelledby="method-title">
      <div className="method-intro"><p className="section-index">02 / a browser only when needed</p><h2 id="method-title">The browser is the <em>exception path.</em></h2></div>
      <div className="method-grid">
        <article className="method-card card-http"><span className="card-number">A</span><Network aria-hidden="true" size={28} strokeWidth={1.6} /><h3>Ask the web first.</h3><p>Fetch public pages directly for fast content, extraction, mapping, and exports.</p><ul><li>redirect re-validation</li><li>response size limits</li><li>cached where safe</li></ul></article>
        <article className="method-card card-browser"><span className="card-number">B</span><Radar aria-hidden="true" size={28} strokeWidth={1.6} /><h3>Escalate with intent.</h3><p>Bring up Chromium only for scripts, rendering, screenshots, PDFs, and downloads.</p><ul><li>warm bounded pool</li><li>queue admission</li><li>browser recycling</li></ul></article>
        <article className="method-card card-policy"><span className="card-number">C</span><ShieldCheck aria-hidden="true" size={28} strokeWidth={1.6} /><h3>Keep the boundary sharp.</h3><p>Never route private networks, upload arbitrary code, or solve a challenge for someone.</p><ul><li>SSRF control</li><li>API-key scopes</li><li>safe failures</li></ul></article>
      </div>
    </section>
  );
}

export function SurfaceSection() {
  return (
    <section className="surface-section" id="surface" aria-labelledby="surface-title">
      <div className="surface-title"><p className="section-index">03 / the useful surface</p><h2 id="surface-title">One service.<br /><em>Several clear ways in.</em></h2></div>
      <div className="surface-list">
        <article><span>01</span><div><h3>REST operations</h3><p>Content, scrape, screenshot, PDF, map, crawl, export, download.</p></div><FileText aria-hidden="true" size={23} strokeWidth={1.5} /></article>
        <article><span>02</span><div><h3>Browser sockets</h3><p>Native Playwright servers for Chromium and WebKit, with session inspection.</p></div><TerminalSquare aria-hidden="true" size={23} strokeWidth={1.5} /></article>
        <article><span>03</span><div><h3>Operator controls</h3><p>Webhooks, encrypted proxies, quotas, safe extension preload, and metrics.</p></div><LockKeyhole aria-hidden="true" size={23} strokeWidth={1.5} /></article>
      </div>
    </section>
  );
}

export function RequestSection() {
  const [copied, setCopied] = useState(false);
  const copyExample = async () => {
    try { await navigator.clipboard.writeText(requestExample); setCopied(true); window.setTimeout(() => setCopied(false), 1800); }
    catch { setCopied(false); }
  };
  return (
    <section className="request-section" id="request" aria-labelledby="request-title">
      <div className="request-copy"><p className="section-index">04 / bring your own keys</p><h2 id="request-title">Run the browser<br />on <em>your</em> terms.</h2><p>Deploy it beside the systems that need it. Start with the API contract, then make the request explicit.</p><a className="button button-paper" href="/openapi.json">Read OpenAPI <ArrowUpRight aria-hidden="true" size={17} /></a></div>
      <div className="request-code"><div className="code-header"><span>request.sh</span><span>POST /v1/fetch</span></div><pre><code>{requestExample}</code></pre><button type="button" className="copy-button" onClick={copyExample} aria-live="polite">{copied ? <Check aria-hidden="true" size={16} /> : <Copy aria-hidden="true" size={16} />}{copied ? "Copied" : "Copy request"}</button></div>
    </section>
  );
}
