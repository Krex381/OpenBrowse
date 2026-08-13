import { describe, expect, it } from "vitest";
import { admissionMemory } from "../../src/process-memory.js";

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
});
