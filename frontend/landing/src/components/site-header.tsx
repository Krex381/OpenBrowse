import { ArrowDownRight, ArrowUpRight } from "lucide-react";

export function SiteHeader() {
  return (
    <header className="site-header">
      <a className="wordmark" href="#top" aria-label="OpenBrowse home">
        <span className="wordmark-mark" aria-hidden="true">OB</span>
        <span>OpenBrowse</span>
      </a>
      <nav aria-label="Primary navigation">
        <a href="#method">Method</a>
        <a href="#surface">Surface area</a>
        <a href="/openapi.json">OpenAPI <ArrowUpRight aria-hidden="true" size={14} /></a>
      </nav>
      <a className="header-cta" href="#request">
        Read the request <ArrowDownRight aria-hidden="true" size={16} />
      </a>
    </header>
  );
}
