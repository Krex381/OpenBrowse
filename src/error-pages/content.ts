import { STATUS_CODES } from "node:http";

export type ErrorPageContent = {
  actionLabel: string;
  actionPath: string;
  detail: string;
  eyebrow: string;
  title: string;
};
const httpCatCodes = new Set([
  400, 401, 402, 403, 404, 405, 406, 407, 408, 409, 410, 411, 412, 413, 414,
  415, 416, 417, 418, 419, 420, 421, 422, 423, 424, 425, 426, 428, 429, 431,
  444, 450, 451, 495, 496, 497, 498, 499, 500, 501, 502, 503, 504, 506, 507,
  508, 509, 510, 511, 521, 522, 523, 525, 530, 599,
]);
const pageCopy: Partial<Record<number, ErrorPageContent>> = {
  401: {
    eyebrow: "Authentication required",
    title: "This request needs a key.",
    detail: "Add a valid Bearer API key, then make the request again.",
    actionLabel: "Read authentication",
    actionPath: "/openapi.json",
  },
  403: {
    eyebrow: "Permission boundary",
    title: "That route is outside this key's scope.",
    detail:
      "Use an API key authorized for this route or ask the operator to update its policy.",
    actionLabel: "Read the API contract",
    actionPath: "/openapi.json",
  },
  404: {
    eyebrow: "Route not found",
    title: "Nothing is running at this address.",
    detail:
      "The route may have moved, expired, or never existed. Start again from the service surface.",
    actionLabel: "Return to landing",
    actionPath: "/landing",
  },
  423: {
    eyebrow: "Safety boundary engaged",
    title: "OpenBrowse stopped this request.",
    detail:
      "Configured browser backends were attempted, but the protected surface remained. Review backend availability, licensing, and target authorization.",
    actionLabel: "Review safe-use policy",
    actionPath: "/landing#method",
  },
  429: {
    eyebrow: "Rate limit reached",
    title: "This key needs a breather.",
    detail:
      "The request limit has been reached. Wait for the window to reset, then retry with the same request.",
    actionLabel: "Return to OpenBrowse",
    actionPath: "/landing#request",
  },
  500: {
    eyebrow: "Service fault",
    title: "The workbench hit a fault.",
    detail:
      "The request did not complete. Retry once; if it continues, inspect the service logs with the request ID.",
    actionLabel: "Return to OpenBrowse",
    actionPath: "/landing#request",
  },
  502: {
    eyebrow: "Upstream did not answer",
    title: "The next hop sent back noise.",
    detail:
      "The destination returned an invalid gateway response. Check the target and retry shortly.",
    actionLabel: "Return to OpenBrowse",
    actionPath: "/landing",
  },
  503: {
    eyebrow: "Capacity reached",
    title: "The browser pool is occupied.",
    detail:
      "OpenBrowse is not admitting more work right now. Wait for capacity, then retry the request.",
    actionLabel: "Return to OpenBrowse",
    actionPath: "/landing#request",
  },
  504: {
    eyebrow: "Execution timed out",
    title: "The destination took too long.",
    detail:
      "No usable response arrived before the execution limit. Try again or lower the amount of work requested.",
    actionLabel: "Return to OpenBrowse",
    actionPath: "/landing",
  },
};
export function contentForStatus(statusCode: number): ErrorPageContent {
  const explicit = pageCopy[statusCode];
  if (explicit) return explicit;
  const statusText = STATUS_CODES[statusCode] ?? "Unexpected response";
  const clientError = statusCode < 500;
  return {
    eyebrow: clientError
      ? "Request needs attention"
      : "Service needs attention",
    title: clientError
      ? `The request returned ${statusText}.`
      : `The service returned ${statusText}.`,
    detail: clientError
      ? "Check the request path, method, and credentials before trying again."
      : "The request could not complete. Retry once, then inspect the service health if it continues.",
    actionLabel: clientError ? "Read the API contract" : "Check readiness",
    actionPath: clientError ? "/openapi.json" : "/readyz",
  };
}
export function catStatusFor(statusCode: number): number {
  return httpCatCodes.has(statusCode)
    ? statusCode
    : statusCode >= 500
      ? 500
      : 400;
}
export function escapeHtml(value: string): string {
  return value.replace(
    /[&<>'"]/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[
        character
      ] ?? character,
  );
}
