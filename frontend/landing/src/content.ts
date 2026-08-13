export type TraceStep = {
  label: string;
  detail: string;
  status: "verified" | "queued" | "bounded";
};

export const traceSteps: TraceStep[] = [
  { label: "Public target", detail: "https://catalog.example", status: "verified" },
  { label: "Route decision", detail: "HTTP-first / browser if needed", status: "queued" },
  { label: "Output policy", detail: "markdown + links / 2 MiB cap", status: "bounded" },
];

export const requestExample = `curl -X POST https://openbrowse.local/v1/fetch \\
  -H "Authorization: Bearer $OPENBROWSE_KEY" \\
  -d '{"url":"https://catalog.example","output":["markdown","links"]}'`;
