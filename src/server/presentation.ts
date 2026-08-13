import { config } from "../config.js";

export function sendBinary(
  reply: {
    header(name: string, value: string): unknown;
    type(value: string): unknown;
    send(value: Buffer): unknown;
  },
  body: Buffer,
  contentType: string,
  requestId: string,
): unknown {
  reply.header("X-OpenBrowse-Strategy", "browser");
  reply.header("X-Request-Id", requestId);
  reply.type(contentType);
  return reply.send(body);
}

export function sessionConnectUrl(
  request: { headers: { host?: string } },
  sessionId: string,
): string {
  if (config.externalUrl) {
    const base = new URL(config.externalUrl);
    base.protocol = base.protocol === "https:" ? "wss:" : "ws:";
    base.pathname = `${base.pathname.replace(/\/$/, "")}/v1/sessions/${sessionId}/cdp`;
    return base.toString();
  }
  return `ws://${request.headers.host ?? `localhost:${config.port}`}/v1/sessions/${sessionId}/cdp`;
}

export function statusCard(
  width: number,
  height: number,
  theme: "light" | "dark",
  data: Record<string, string>,
): string {
  const escape = (value: string) =>
    value.replace(
      /[&<>"']/g,
      (char) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&apos;",
        })[char] ?? char,
    );
  const dark = theme === "dark";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escape(data.title ?? "OpenBrowse status")}"><rect width="100%" height="100%" rx="16" fill="${dark ? "#111827" : "#f8fafc"}"/><circle cx="40" cy="40" r="10" fill="${(data.status ?? "").toLowerCase() === "healthy" ? "#22c55e" : "#f59e0b"}"/><text x="64" y="47" fill="${dark ? "#f8fafc" : "#111827"}" font-family="system-ui,sans-serif" font-size="24" font-weight="700">${escape(data.title ?? "OpenBrowse")}</text><text x="32" y="${height - 32}" fill="${dark ? "#cbd5e1" : "#475569"}" font-family="system-ui,sans-serif" font-size="18">${escape(data.latency ?? data.status ?? "unknown")}</text></svg>`;
}
