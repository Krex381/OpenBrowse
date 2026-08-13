import { readFile } from "node:fs/promises";

const file = process.argv[2] ?? "benchmark-smoke.json";
const raw = await readFile(file, "utf8");
// `npm run … > file` includes npm's human-readable command preamble before
// the runner's JSON. Keep the verifier usable both through npm and when the
// benchmark script is invoked directly.
const jsonStart = raw.indexOf("{");
if (jsonStart < 0) throw new Error(`${file}: benchmark output did not contain a JSON report`);
const report = JSON.parse(raw.slice(jsonStart));
const errors = [];

if (report.schemaVersion !== 1) errors.push("unexpected benchmark schema version");
if (report.failures?.length) errors.push("benchmark reported request or sampling failures");
if (!Array.isArray(report.memory?.samples) || report.memory.samples.length < 2)
  errors.push("benchmark did not retain start and end memory samples");
const authorities = report.memory?.admissionAuthorities;
if (!Array.isArray(authorities) || authorities.length === 0)
  errors.push("benchmark did not report a memory admission authority");
if (!authorities?.every((authority) => ["cgroup", "process-tree", "node"].includes(authority)))
  errors.push("benchmark reported an unknown memory admission authority");
if (authorities?.includes("cgroup") && !(report.memory?.peakContainerRssMb > 0))
  errors.push("cgroup admission was selected without a container memory charge");
if (!authorities?.includes("cgroup") && !(report.memory?.peakProcessTreeRssMb > 0))
  errors.push("fallback admission was selected without process-tree diagnostics");
if (!(report.memory?.peakAdmissionRssMb > 0))
  errors.push("benchmark did not report peak admission RSS");

if (errors.length) throw new Error(`${file}: ${errors.join("; ")}`);
console.log(JSON.stringify({
  admissionAuthorities: authorities,
  peakAdmissionRssMb: report.memory.peakAdmissionRssMb,
  peakContainerRssMb: report.memory.peakContainerRssMb,
  workerTransitions: report.workerTransitions,
}));
