import { MethodSection, ProofBand, RequestSection, SurfaceSection } from "./components/landing-sections";
import { SiteHeader } from "./components/site-header";
import { TraceBoard } from "./components/trace-board";
import { BrowserQlWorkbench, LiveViewer } from "./components/workbench";

function Hero() {
  return (
    <section className="hero" aria-labelledby="hero-title">
      <p className="hero-kicker"><span /> Self-hosted browser execution</p>
      <h1 id="hero-title">Web work, <em>without</em><br />losing the plot.</h1>
      <p className="hero-deck">OpenBrowse is a secure, HTTP-first gateway for teams that need browser capability without surrendering control.</p>
      <div className="hero-meta"><span>REV. 0.1</span><span>SAFETY-LED</span><span>OPEN SOURCE</span></div>
    </section>
  );
}

export function App() {
  if (window.location.pathname === "/browserql") return <BrowserQlWorkbench />;
  if (window.location.pathname === "/viewer") return <LiveViewer />;
  return (
    <div className="site-shell" id="top">
      <a className="skip-link" href="#main-content">Skip to main content</a>
      <SiteHeader />
      <main id="main-content"><Hero /><TraceBoard /><ProofBand /><MethodSection /><SurfaceSection /><RequestSection /></main>
      <footer><span>OPENBROWSE / SELF-HOSTED</span><span>BUILT FOR EXPLICIT WORK</span><a href="#top">Return to top ↑</a></footer>
    </div>
  );
}
