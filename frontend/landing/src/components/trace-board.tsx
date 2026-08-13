import { useState } from "react";
import { ArrowUpRight } from "lucide-react";
import { traceSteps } from "../content";

export function TraceBoard() {
  const [selected, setSelected] = useState(0);
  const active = traceSteps[selected]!;

  return (
    <section className="trace-board" aria-labelledby="trace-title">
      <div className="board-corners" aria-hidden="true" />
      <div className="trace-topline">
        <span>Live execution specimen</span>
        <span className="pulse"><i /> ready</span>
      </div>
      <div className="trace-layout">
        <div className="trace-copy">
          <p className="section-index">01 / the controlled path</p>
          <h2 id="trace-title">Every request leaves a <em>legible trail.</em></h2>
          <p>
            A secure browser gateway should show its work. OpenBrowse starts with an HTTP request,
            opens a browser only when the page earns it, and returns bounded outputs you can inspect.
          </p>
          <div className="trace-actions">
            <a className="button button-ink" href="#request">Inspect the API <ArrowUpRight aria-hidden="true" size={17} /></a>
            <a className="text-link" href="/openapi.json">Open specification <ArrowUpRight aria-hidden="true" size={15} /></a>
          </div>
        </div>
        <div className="trace-control" aria-label="Request trace steps">
          <div className="route-map" aria-hidden="true" />
          <div className="trace-caption" aria-live="polite">
            <span>Active decision</span>
            <strong>{active.label}</strong>
            <p>{active.detail}</p>
          </div>
          <div className="trace-steps" role="tablist" aria-label="Select a request stage">
            {traceSteps.map((step, index) => (
              <button key={step.label} type="button" role="tab" aria-selected={selected === index} className={selected === index ? "is-active" : ""} onClick={() => setSelected(index)}>
                <span className="step-number">0{index + 1}</span>
                <span>{step.label}</span>
                <i className={`status-dot ${step.status}`} aria-hidden="true" />
              </button>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
