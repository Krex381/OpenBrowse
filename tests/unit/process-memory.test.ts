import { describe, expect, it } from "vitest";
import { admissionMemory, cgroupMemoryPaths } from "../../src/process-memory.js";

describe("admission memory authority", () => {
  it("uses the cgroup charge instead of overcounted process RSS", () => {
    expect(
      admissionMemory({
        nodeRssMb: 250,
        browserTreeRssMb: 1_100,
        containerRssMb: 740,
        processTreesSupported: true,
      }),
    ).toEqual({ authority: "cgroup", rssMb: 740, processTreeRssMb: 1_350 });
  });

  it("falls back to process trees, then Node RSS, outside cgroups", () => {
    expect(
      admissionMemory({
        nodeRssMb: 120,
        browserTreeRssMb: 280,
        processTreesSupported: true,
      }),
    ).toEqual({ authority: "process-tree", rssMb: 400, processTreeRssMb: 400 });
    expect(
      admissionMemory({
        nodeRssMb: 120,
        browserTreeRssMb: 280,
        processTreesSupported: false,
      }),
    ).toEqual({ authority: "node", rssMb: 120, processTreeRssMb: 400 });
  });

  it("resolves cgroup v1 and v2 accounting paths from the process namespace", () => {
    const v2 = cgroupMemoryPaths(
      "0::/docker/abc\n",
      "31 24 0:28 / /sys/fs/cgroup rw - cgroup2 cgroup rw\n",
    );
    expect(v2).toContain("/sys/fs/cgroup/docker/abc/memory.current");

    const v1 = cgroupMemoryPaths(
      "11:memory:/docker/abc\n",
      "31 24 0:28 / /sys/fs/cgroup/memory rw - cgroup cgroup rw,memory\n",
    );
    expect(v1).toContain("/sys/fs/cgroup/memory/docker/abc/memory.usage_in_bytes");
  });
});
