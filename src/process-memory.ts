import { readdir, readFile } from "node:fs/promises";

export interface ProcessTreeMemory {
  rootPid: number;
  rssMb: number;
  processes: number;
}

export interface BrowserMemoryMeasurement {
  supported: boolean;
  trees: Map<number, ProcessTreeMemory>;
  containerRssMb?: number;
}

export type MemoryAdmissionAuthority = "cgroup" | "process-tree" | "node";

export interface AdmissionMemory {
  authority: MemoryAdmissionAuthority;
  rssMb: number;
  processTreeRssMb: number;
}

type ProcessRow = { pid: number; ppid: number };

function mb(bytes: number): number {
  return bytes / 1024 / 1024;
}

/**
 * Selects the memory value used to admit more work. Per-process RSS sums are
 * intentionally retained for worker recycling, but they can count shared
 * Chromium pages more than once. A cgroup's `memory.current` is the physical
 * container charge and therefore wins whenever the runtime exposes it.
 */
export function admissionMemory(input: {
  nodeRssMb: number;
  browserTreeRssMb: number;
  containerRssMb?: number;
  processTreesSupported: boolean;
}): AdmissionMemory {
  const processTreeRssMb = input.nodeRssMb + input.browserTreeRssMb;
  if (input.containerRssMb !== undefined)
    return {
      authority: "cgroup",
      rssMb: input.containerRssMb,
      processTreeRssMb,
    };
  return {
    authority: input.processTreesSupported ? "process-tree" : "node",
    rssMb: input.processTreesSupported ? processTreeRssMb : input.nodeRssMb,
    processTreeRssMb,
  };
}

async function linuxProcesses(): Promise<ProcessRow[]> {
  const entries = await readdir("/proc", { withFileTypes: true });
  const rows = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
      .map(async (entry) => {
        try {
          const stat = await readFile(`/proc/${entry.name}/stat`, "utf8");
          const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
          const ppid = Number(fields[1]);
          const pid = Number(entry.name);
          return Number.isInteger(pid) && Number.isInteger(ppid)
            ? { pid, ppid }
            : undefined;
        } catch {
          return undefined;
        }
      }),
  );
  return rows.filter((row): row is ProcessRow => Boolean(row));
}

async function linuxRssMb(pid: number): Promise<number> {
  try {
    const status = await readFile(`/proc/${pid}/status`, "utf8");
    const value = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status)?.[1];
    return value ? Number(value) / 1024 : 0;
  } catch {
    return 0;
  }
}

async function cgroupRssMb(): Promise<number | undefined> {
  for (const path of [
    // cgroup v2
    "/sys/fs/cgroup/memory.current",
    // cgroup v1, still common on hosted Linux runners and older kernels.
    "/sys/fs/cgroup/memory/memory.usage_in_bytes",
  ]) {
    try {
      const value = Number((await readFile(path, "utf8")).trim());
      if (Number.isFinite(value)) return mb(value);
    } catch {
      // Try the other hierarchy before falling back to process-tree RSS.
    }
  }
  return undefined;
}

/**
 * Measures Chromium roots and all descendants on Linux. Docker production
 * deployments use Linux, where /proc makes this independent of Chromium's
 * process names and includes renderers, GPU, and utility processes.
 */
export async function measureBrowserProcessTrees(
  rootPids: readonly number[],
): Promise<BrowserMemoryMeasurement> {
  if (process.platform !== "linux")
    return { supported: false, trees: new Map() };
  const roots = [...new Set(rootPids.filter((pid) => Number.isInteger(pid) && pid > 0))];
  const [rows, containerRssMb] = await Promise.all([linuxProcesses(), cgroupRssMb()]);
  const children = new Map<number, number[]>();
  for (const row of rows) {
    const sibling = children.get(row.ppid) ?? [];
    sibling.push(row.pid);
    children.set(row.ppid, sibling);
  }
  const trees = new Map<number, ProcessTreeMemory>();
  await Promise.all(
    roots.map(async (rootPid) => {
      const descendants = new Set<number>([rootPid]);
      const pending = [rootPid];
      while (pending.length) {
        const parent = pending.pop();
        if (parent === undefined) continue;
        for (const child of children.get(parent) ?? []) {
          if (!descendants.has(child)) {
            descendants.add(child);
            pending.push(child);
          }
        }
      }
      const rss = await Promise.all([...descendants].map(linuxRssMb));
      trees.set(rootPid, {
        rootPid,
        rssMb: rss.reduce((total, value) => total + value, 0),
        processes: descendants.size,
      });
    }),
  );
  return { supported: true, trees, ...(containerRssMb === undefined ? {} : { containerRssMb }) };
}
