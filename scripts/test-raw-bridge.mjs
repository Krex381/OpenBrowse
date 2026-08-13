import { spawn } from "node:child_process";

const child = spawn(
  process.execPath,
  [
    "--env-file=.env.test",
    "./node_modules/vitest/vitest.mjs",
    "run",
    "tests/integration/cdp-bridge.test.ts",
    "--maxWorkers=1",
    "--no-file-parallelism",
  ],
  {
    env: { ...process.env, OPENBROWSE_RAW_BROWSER_PROTOCOL_BRIDGES: "true" },
    stdio: "inherit",
  },
);

child.once("exit", (code, signal) => {
  if (signal) {
    console.error(`Raw bridge test stopped by ${signal}`);
    process.exitCode = 1;
    return;
  }
  process.exitCode = code ?? 1;
});
