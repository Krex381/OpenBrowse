import { describe, expect, it } from "vitest";
import {
  browserBackendCatalog,
  selectBrowserBackend,
} from "../../src/execution/backends.js";
import {
  browserProfileKey,
  redactBrowserLaunchError,
} from "../../src/execution/browser-launchers.js";

describe("browser backends", () => {
  it("selects the maintained Patchright backend explicitly", () => {
    expect(
      selectBrowserBackend({
        url: "https://example.com",
        browserBackend: "patchright-chromium",
      }),
    ).toMatchObject({
      preferred: "playwright-chromium",
      selected: "patchright-chromium",
      reason: "requested-supported-backend",
      estimatedMemoryMb: 256,
    });
  });

  it("publishes CloakBrowser while preserving the operator license gate", () => {
    expect(
      browserBackendCatalog().find(
        (entry) => entry.id === "cloakbrowser-chromium",
      ),
    ).toMatchObject({
      enabled: false,
      operatorLicenseRequired: true,
      acceptsFingerprintOptions: true,
      acceptsHumanizationOptions: true,
    });
    expect(() =>
      selectBrowserBackend({
        url: "https://example.com",
        browserBackend: "cloakbrowser-chromium",
      }),
    ).toThrow(/disabled by the operator/i);
  });

  it("isolates CloakBrowser workers by fingerprint and humanization profile", () => {
    const first = browserProfileKey("cloakbrowser-chromium", {
      fingerprintArgs: ["--fingerprint=1234"],
      humanize: true,
      humanPreset: "careful",
      humanConfig: { typing_delay: 90, idle_between_actions: true },
    });
    const reordered = browserProfileKey("cloakbrowser-chromium", {
      fingerprintArgs: ["--fingerprint=1234"],
      humanize: true,
      humanPreset: "careful",
      humanConfig: { idle_between_actions: true, typing_delay: 90 },
    });
    const different = browserProfileKey("cloakbrowser-chromium", {
      fingerprintArgs: ["--fingerprint=9999"],
      humanize: true,
    });
    expect(first).toBe(reordered);
    expect(first).not.toBe(different);
  });

  it("publishes operator-gated Camoufox and Clearcote capabilities", () => {
    const catalog = browserBackendCatalog();
    expect(
      catalog.find((entry) => entry.id === "camoufox-firefox"),
    ).toMatchObject({
      enabled: false,
      engine: "firefox",
      screenshots: true,
      pdf: false,
    });
    expect(
      catalog.find((entry) => entry.id === "clearcote-chromium"),
    ).toMatchObject({
      enabled: false,
      engine: "chromium",
      acceptsFingerprintOptions: true,
    });
  });

  it("isolates Camoufox and Clearcote worker profiles", () => {
    expect(
      browserProfileKey("camoufox-firefox", {
        camoufox: { os: "linux", locale: ["en-US", "en"] },
      }),
    ).not.toBe(
      browserProfileKey("camoufox-firefox", {
        camoufox: { os: "linux", locale: "de-DE" },
      }),
    );
    expect(
      browserProfileKey("clearcote-chromium", {
        fingerprintArgs: ["--fingerprint=first"],
      }),
    ).not.toBe(
      browserProfileKey("clearcote-chromium", {
        fingerprintArgs: ["--fingerprint=second"],
      }),
    );
  });

  it("redacts launch credentials from operator diagnostics", () => {
    const redacted = redactBrowserLaunchError(
      new Error(
        "chrome --profile-encryption-key=secret https://user:password@proxy.example:443",
      ),
    );
    expect(redacted).not.toContain("secret");
    expect(redacted).not.toContain("user:password");
    expect(redacted).toContain("[REDACTED]");
  });
});
