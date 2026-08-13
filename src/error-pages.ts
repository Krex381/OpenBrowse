import { renderErrorDocument } from "./error-pages/template.js";

export function errorPageCsp(): string {
  return "default-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; style-src 'self' 'unsafe-inline'; script-src 'none'; img-src 'self' https://http.cat data:; connect-src 'self'; object-src 'none'";
}

export function renderErrorPage(statusCode: number): string {
  return renderErrorDocument(statusCode);
}
