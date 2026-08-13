import { readFile } from "node:fs/promises";

const file = process.argv[2] ?? "benchmark-smoke.json";
const report = JSON.parse(await readFile(file, "utf8"));
const errors = [];

if (report.schemaVersion !== 1) errors.push("unexpected benchmark schema version");
if (report.failures?.length) errors.push("benchmark reported request or sampling failures");
if (!Array.isArray(report.memory?.samples) || report.memory.samples.length < 2)
  errors.push("benchmark did not retain start and end memory samples");
if (!Array.isArray(report.memory?.admissionAuthorities) || !report.memory.admissionAuthorities.includes("cgroup"))
  errors.push("Docker benchmark did not use cgroup memory as its admission authority");
if (!(report.memory?.peakContainerRssMb > 0))
  errors.push("Docker benchmark did not report a container memory charge");
if (!(report.memory?.peakAdmissionRssMb > 0))
  errors.push("benchmark did not report peak admission RSS");

if (errors.length) throw new Error(`${file}: ${errors.join("; ")}`);
console.log(JSON.stringify({
  cgroupAdmission: true,
  peakAdmissionRssMb: report.memory.peakAdmissionRssMb,
  peakContainerRssMb: report.memory.peakContainerRssMb,
  workerTransitions: report.workerTransitions,
}));
