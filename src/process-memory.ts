import { readdir, readFile } from "node:fs/promises";
import { posix } from "node:path";

export interface ProcessTreeMemory {
  rootPid: number;
  rssMb: number;
  processes: number;
}

export interface BrowserMemoryMeasurement {
  supported: boolean;
  trees: Map<number, ProcessTreeMemory>;
  containerRssMb?: number;
  containerLimitMb?: number;
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

type CgroupMount = { root: string; mountPoint: string; version: 1 | 2; memory: boolean };
type CgroupMemory = { usageMb: number; limitMb: number };

// v1 represents an unlimited controller as a near-int64 maximum. Treat any
// value above one PiB as unbounded: it belongs to a host/parent cgroup rather
// than a practical workload envelope.
const maximumScopedCgroupLimitMb = 1024 * 1024;

function cgroupPathWithinMount(root: string, path: string): string | undefined {
  const normalizedRoot = posix.normalize(root);
  const normalizedPath = posix.normalize(path);
  if (normalizedRoot !== "/" && normalizedPath !== normalizedRoot && !normalizedPath.startsWith(`${normalizedRoot}/`))
    return undefined;
  return normalizedRoot === "/" ? normalizedPath.slice(1) : normalizedPath.slice(normalizedRoot.length).replace(/^\//, "");
}

/** Maps `/proc` cgroup metadata to candidate accounting files across v1/v2. */
export function cgroupMemoryPaths(cgroup: string, mountInfo: string): string[] {
  const groups = cgroup.split("\n").flatMap((line) => {
    const [id, controllers, path] = line.trim().split(":", 3);
    return id !== undefined && controllers !== undefined && path !== undefined
      ? [{ controllers: controllers.split(","), path }]
      : [];
  });
  const mounts = mountInfo.split("\n").flatMap((line): CgroupMount[] => {
    const [before, after] = line.split(" - ", 2);
    if (!before || !after) return [];
    const fields = before.split(" ");
    const filesystem = after.split(" ")[0];
    const root = fields[3];
    const mountPoint = fields[4];
    if (!root || !mountPoint) return [];
    if (filesystem === "cgroup2") return [{ root, mountPoint, version: 2, memory: true }];
    if (filesystem !== "cgroup") return [];
    const options = `${before} ${after}`.split(",");
    return [{ root, mountPoint, version: 1, memory: options.includes("memory") }];
  });
  const paths = new Set<string>();
  for (const group of groups) {
    const version: 1 | 2 = group.controllers.length === 1 && group.controllers[0] === "" ? 2 : 1;
    const needsMemory = version === 1;
    for (const mount of mounts) {
      if (mount.version !== version || (needsMemory && !mount.memory)) continue;
      const relative = cgroupPathWithinMount(mount.root, group.path);
      if (relative === undefined) continue;
      paths.add(posix.join(mount.mountPoint, relative, version === 2 ? "memory.current" : "memory.usage_in_bytes"));
    }
  }
  // Root-layout fallbacks cover minimal containers where /proc is unavailable.
  paths.add("/sys/fs/cgroup/memory.current");
  paths.add("/sys/fs/cgroup/memory/memory.usage_in_bytes");
  return [...paths];
}

async function cgroupRssMb(): Promise<CgroupMemory | undefined> {
  let paths: string[];
  try {
    const [cgroup, mountInfo] = await Promise.all([
      readFile("/proc/self/cgroup", "utf8"),
      readFile("/proc/self/mountinfo", "utf8"),
    ]);
    paths = cgroupMemoryPaths(cgroup, mountInfo);
  } catch {
    paths = cgroupMemoryPaths("", "");
  }
  for (const path of paths) {
    try {
      const value = Number((await readFile(path, "utf8")).trim());
      if (!Number.isFinite(value)) continue;
      const limitPath = path.endsWith("memory.current")
        ? `${path.slice(0, -"memory.current".length)}memory.max`
        : `${path.slice(0, -"memory.usage_in_bytes".length)}memory.limit_in_bytes`;
      const limit = Number((await readFile(limitPath, "utf8")).trim());
      if (!Number.isFinite(limit)) continue;
      const limitMb = mb(limit);
      if (limitMb <= 0 || limitMb >= maximumScopedCgroupLimitMb) continue;
      return { usageMb: mb(value), limitMb };
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
  const [rows, containerMemory] = await Promise.all([linuxProcesses(), cgroupRssMb()]);
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
  return {
    supported: true,
    trees,
    ...(containerMemory === undefined
      ? {}
      : {
          containerRssMb: containerMemory.usageMb,
          containerLimitMb: containerMemory.limitMb,
        }),
  };
}
