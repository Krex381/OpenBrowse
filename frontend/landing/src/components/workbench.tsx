import { type FormEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";

type ApiState = { baseUrl: string; apiKey: string; sessionId: string };
const initial: ApiState = { baseUrl: window.location.origin, apiKey: "", sessionId: "" };
const starterQuery = `mutation Inspect {
  goto(url: "https://example.com") { status finalUrl }
  title { title }
  network { responses { url status } }
}`;

async function apiRequest(state: ApiState, path: string, init?: RequestInit) {
  const response = await fetch(`${state.baseUrl.replace(/\/$/, "")}${path}`, {
    ...init,
    headers: { ...(init?.headers ?? {}), Authorization: `Bearer ${state.apiKey}`, "Content-Type": "application/json" },
  });
  const type = response.headers.get("content-type") ?? "";
  const payload = type.includes("application/json") ? await response.json() : await response.text();
  if (!response.ok) throw new Error(typeof payload === "string" ? payload : payload.error?.message ?? `Request failed (${response.status})`);
  return payload;
}

function ConnectionForm({ value, onChange, session }: { value: ApiState; onChange(value: ApiState): void; session?: boolean }) {
  return <div className="workbench-connection">
    <label>Gateway<input value={value.baseUrl} onChange={(event) => onChange({ ...value, baseUrl: event.target.value })} inputMode="url" aria-label="Gateway URL" /></label>
    <label>API key<input value={value.apiKey} onChange={(event) => onChange({ ...value, apiKey: event.target.value })} type="password" autoComplete="off" aria-label="API key" /></label>
    {session && <label>Session ID<input value={value.sessionId} onChange={(event) => onChange({ ...value, sessionId: event.target.value })} placeholder="ses_…" aria-label="Session ID" /></label>}
  </div>;
}

export function BrowserQlWorkbench() {
  const [connection, setConnection] = useState(initial);
  const [query, setQuery] = useState(starterQuery);
  const [result, setResult] = useState("Run a mutation to inspect its response.");
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true);
    try { setResult(JSON.stringify(await apiRequest(connection, "/chromium/bql", { method: "POST", body: JSON.stringify({ query }) }), null, 2)); }
    catch (error) { setResult(`Error: ${error instanceof Error ? error.message : "Request failed"}`); }
    finally { setBusy(false); }
  }
  return <WorkbenchFrame eyebrow="BrowserQL / safe mutation studio" title="Run the browser with a clear paper trail.">
    <p className="workbench-deck">A small local client for the authenticated BrowserQL endpoint. Your key stays in this tab; it is never stored by this page.</p>
    <form className="studio-grid" onSubmit={submit}>
      <ConnectionForm value={connection} onChange={setConnection} />
      <label className="editor-label">Mutation<textarea value={query} onChange={(event) => setQuery(event.target.value)} spellCheck={false} aria-label="BrowserQL mutation" /></label>
      <button className="workbench-button" disabled={busy}>{busy ? "Running…" : "Run mutation"}</button>
      <pre className="workbench-output" aria-live="polite">{result}</pre>
    </form>
  </WorkbenchFrame>;
}

export function LiveViewer() {
  const [connection, setConnection] = useState(initial);
  const [url, setUrl] = useState("");
  const [selector, setSelector] = useState("");
  const [status, setStatus] = useState("Connect a session to start the live frame.");
  const [frame, setFrame] = useState("");
  const vncTarget = useRef<HTMLDivElement>(null);
  const rfb = useRef<{ disconnect(): void } | undefined>(undefined);
  const canPoll = useMemo(() => Boolean(connection.apiKey && /^ses_[a-z0-9]+$/.test(connection.sessionId)), [connection]);
  useEffect(() => {
    if (!canPoll) return;
    let cancelled = false;
    let timer: number | undefined;
    const capture = async () => {
      try {
        const response = await fetch(`${connection.baseUrl.replace(/\/$/, "")}/v1/sessions/${connection.sessionId}/inspect/screenshot`, { headers: { Authorization: `Bearer ${connection.apiKey}` } });
        if (!response.ok) throw new Error(`Frame unavailable (${response.status})`);
        const image = URL.createObjectURL(await response.blob());
        if (!cancelled) { setFrame((prior) => { if (prior) URL.revokeObjectURL(prior); return image; }); setStatus("Live · refreshing every 1.2 s"); }
        else URL.revokeObjectURL(image);
      } catch (error) { if (!cancelled) setStatus(error instanceof Error ? error.message : "Frame unavailable"); }
      if (!cancelled) timer = window.setTimeout(capture, 1200);
    };
    void capture();
    return () => { cancelled = true; if (timer) window.clearTimeout(timer); };
  }, [canPoll, connection]);
  async function navigate(event: FormEvent) {
    event.preventDefault();
    try { await apiRequest(connection, `/v1/sessions/${connection.sessionId}/navigate`, { method: "POST", body: JSON.stringify({ url }) }); setStatus("Navigated. Capturing the next frame…"); }
    catch (error) { setStatus(error instanceof Error ? error.message : "Navigation failed"); }
  }
  async function click() {
    try { await apiRequest(connection, `/v1/sessions/${connection.sessionId}/commands`, { method: "POST", body: JSON.stringify({ commands: [{ method: "click", params: { selector } }] }) }); setStatus("Click sent. Capturing the next frame…"); }
    catch (error) { setStatus(error instanceof Error ? error.message : "Click failed"); }
  }
  async function connectVnc() {
    if (!vncTarget.current || !canPoll) return;
    try {
      const { default: RFB } = await import("@novnc/novnc");
      rfb.current?.disconnect();
      const socket = new URL(connection.baseUrl);
      socket.protocol = socket.protocol === "https:" ? "wss:" : "ws:";
      socket.pathname = `/v1/sessions/${connection.sessionId}/vnc`;
      socket.search = "";
      socket.searchParams.set("token", connection.apiKey);
      const client = new RFB(vncTarget.current, socket.toString());
      client.scaleViewport = true;
      client.resizeSession = true;
      client.addEventListener("connect", () => setStatus("VNC connected - direct keyboard and pointer control enabled"));
      client.addEventListener("disconnect", (event) => setStatus(event.detail.clean ? "VNC disconnected" : "VNC disconnected unexpectedly"));
      rfb.current = client;
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not load the VNC viewer");
    }
  }
  return <WorkbenchFrame eyebrow="Live viewer / session-scoped" title="See it. Then steer it deliberately.">
    <p className="workbench-deck">Snapshot mode works for every session. VNC direct control is available for sessions created with <code>liveViewer: true</code> on a Docker host that enables the bundled bridge.</p>
    <ConnectionForm value={connection} onChange={setConnection} session />
    <div className="viewer-grid"><div className="viewer-screen">{frame ? <img src={frame} alt="Current browser session" /> : <div className="viewer-empty">{status}</div>}<div ref={vncTarget} className="vnc-target" aria-label="Interactive VNC desktop" /></div>
      <div className="viewer-controls"><p aria-live="polite">{status}</p><form onSubmit={navigate}><label>Navigate<input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://example.com" inputMode="url" /></label><button className="workbench-button">Go</button></form><label>Click selector<input value={selector} onChange={(event) => setSelector(event.target.value)} placeholder="button[type=submit]" /></label><button className="workbench-button secondary" onClick={click} type="button">Send click</button></div></div>
    <button className="workbench-button vnc-connect" type="button" onClick={connectVnc} disabled={!canPoll}>Connect VNC desktop</button>
  </WorkbenchFrame>;
}

function WorkbenchFrame({ eyebrow, title, children }: { eyebrow: string; title: string; children: ReactNode }) {
  return <div className="workbench-shell"><a className="skip-link" href="#workbench">Skip to workspace</a><header className="workbench-header"><a href="/landing" className="wordmark"><span className="wordmark-mark">OB</span>OpenBrowse</a><a href="/landing" className="return-link">Marketing site ↗</a></header><main id="workbench" className="workbench-main"><p className="workbench-eyebrow">{eyebrow}</p><h1>{title}</h1>{children}</main></div>;
}
