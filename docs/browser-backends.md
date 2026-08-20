# Browser backends

Research and implementation review: 2026-08-20.

## Runtime model

OpenBrowse exposes five browser backend IDs through the same planner and pool:

| Backend | Default state | Runtime | License |
| --- | --- | --- | --- |
| `playwright-chromium` | Enabled, default | Stock Playwright driver and pinned Chromium | Apache-2.0 |
| `patchright-chromium` | Enabled | Patchright driver with the same pinned Chromium | Apache-2.0 |
| `cloakbrowser-chromium` | Installed integration, operator-disabled | CloakBrowser launch profile and operator-managed signed binary | MIT wrapper; separate binary terms |
| `camoufox-firefox` | Installed integration, operator-disabled | Camoufox `0.12.0` and its verified Firefox binary | MPL-2.0 |
| `clearcote-chromium` | Adapter only, operator-disabled | Operator-verified Clearcote Chromium binary | BSD-3-Clause source; review binary provenance |

Every backend retains URL interception, isolated BrowserContexts, output
bounds, launch and navigation timeouts, queue admission, worker process IDs,
RSS accounting, and recycling. Chromium backends also retain the configured
sandbox policy. Backend choice is explicit or operator-defaulted; it is never
inferred from a hostname.

```bash
export OPENBROWSE_BROWSER_BACKENDS='playwright-chromium,patchright-chromium,cloakbrowser-chromium'
export OPENBROWSE_DEFAULT_BROWSER_BACKEND='playwright-chromium'
export OPENBROWSE_CLOAKBROWSER_LICENSE_ACCEPTED='true'
export CLOAKBROWSER_LICENSE_KEY='cb_xxxxxxxx'
```

Camoufox is deliberately provisioned separately because its Firefox artifact is
large. The current JavaScript package requires Node 22 and Playwright Core below
1.61, so OpenBrowse isolates its control connection on `playwright-core 1.58.2`
while stock Playwright keeps its own nested 1.62.1 driver.

```bash
npm run prepare:camoufox
export OPENBROWSE_BROWSER_BACKENDS='playwright-chromium,patchright-chromium,camoufox-firefox'
```

Clearcote is binary-path only. OpenBrowse does not install the `clearcote` npm
SDK because its current dependency tree includes the unfixed `extract-zip`
path-traversal advisory. Download and verify an official browser artifact as an
operator, then set `OPENBROWSE_CLEARCOTE_EXECUTABLE_PATH`. The derived profile
encryption key never leaves OpenBrowse and is redacted from launch errors.

Pin `CLOAKBROWSER_VERSION` and disable automatic updates in production. Docker
stores the downloaded binary under `/data/cloakbrowser`.

Verify the configured adapters through the public fetch contract:

```bash
OPENBROWSE_VERIFY_BROWSER_BACKENDS=patchright-chromium \
  npm run verify:browser-backends

OPENBROWSE_BROWSER_BACKENDS=cloakbrowser-chromium \
OPENBROWSE_DEFAULT_BROWSER_BACKEND=cloakbrowser-chromium \
OPENBROWSE_CLOAKBROWSER_LICENSE_ACCEPTED=true \
OPENBROWSE_VERIFY_BROWSER_BACKENDS=cloakbrowser-chromium \
  npm run verify:browser-backends

OPENBROWSE_BROWSER_BACKENDS=camoufox-firefox \
OPENBROWSE_DEFAULT_BROWSER_BACKEND=camoufox-firefox \
OPENBROWSE_VERIFY_BROWSER_BACKENDS=camoufox-firefox \
  npm run verify:browser-backends
```

The CloakBrowser verification request exercises both a raw fingerprint seed and
the `careful` humanization preset.

## Patchright decision

Patchright replaces the previously reviewed `invisible_playwright` path. It is
Node-native, Chromium-only, Apache-2.0, published at a version matching
Playwright, and tested against the Playwright suite after releases. OpenBrowse
uses Patchright `1.62.1` with Playwright Chromium `1.62.1`, avoiding a Python
runtime, patched Firefox distribution, and second browser download.

Primary sources:

- [Patchright repository](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright)
- [Patchright Node package](https://www.npmjs.com/package/patchright)
- [invisible_playwright repository](https://github.com/feder-cr/invisible_playwright)

## CloakBrowser decision

The `cloakbrowser` Node wrapper is an optional dependency. OpenBrowse uses its
`buildLaunchOptions()` API with the managed Playwright server lifecycle. The
adapter therefore retains process PID visibility, browser-tree memory
accounting, pool recycling, and context-level URL interception.

API callers may supply bounded Cloak-specific controls:

- up to 32 `--fingerprint` or `--fingerprint-*` arguments, 256 characters each;
- `humanize: true|false`;
- the `default` or `careful` preset;
- bounded overrides for documented humanization keys.

Humanization defaults to `true` for CloakBrowser and can be explicitly disabled.
CloakBrowser's own stealth argument set remains enabled; raw `--fingerprint*`
values override only their matching generated defaults. Patchright's driver
owns its command-line patch set, including adding
`--disable-blink-features=AutomationControlled` and removing Playwright's
detectable automation flags; OpenBrowse does not re-add those flags.

These options may accompany a Patchright- or stock-first request. They are
ignored by those backends and applied only if the bounded challenge fallback
reaches CloakBrowser.

No other Chromium switch is accepted. Callers cannot disable the sandbox, open
remote debugging, inject an extension, or replace the operator's proxy.

The binary is not redistributed by this repository. CloakHQ's terms state that
exposing it through a browser API requires separate OEM/SaaS licensing unless
the use qualifies as internal operation. OpenBrowse therefore requires
`OPENBROWSE_CLOAKBROWSER_LICENSE_ACCEPTED=true` before enablement. The flag
records operator intent; it does not grant a license.

Primary sources:

- [CloakBrowser repository and Node API](https://github.com/CloakHQ/CloakBrowser)
- [CloakBrowser binary license](https://github.com/CloakHQ/CloakBrowser/blob/main/BINARY-LICENSE.md)

## Challenge escalation

Browser fetches attempt the requested/default backend, Patchright, and
then each enabled operator backend at most once in this order: Clearcote,
Camoufox, CloakBrowser. Backends that cannot satisfy the requested operation
are skipped; for example Camoufox is not used for PDF. BrowserQL repeats its
bounded mutation only when `solve` observes a recognized challenge. Responses
expose `backendAttempts`, `selectedBackend`, and `challengeRemaining`.

This may avoid a challenge by changing browser implementation and fingerprint.
It does not outsource or claim to answer an interactive CAPTCHA. If every
configured backend still sees the challenge, the final result remains marked
instead of entering an unbounded retry loop.

Challenge responses are never stored in the response cache. A later request can
therefore use newly enabled backends, a newer CloakBrowser binary, or different
fingerprint options instead of replaying an earlier challenge page.

The verifier normally fails when a challenge remains. For an authorized target
where the purpose is to record backend behavior rather than assert access, set
`OPENBROWSE_VERIFY_ALLOW_CHALLENGE=true` and inspect the reported result.

Pooled browser execution is headless by default. An operator can set
`OPENBROWSE_BROWSER_HEADLESS=false` on a host with a display or Xvfb to compare
headed behavior. This is an operator setting, not a request field, so callers
cannot open desktop windows or change the deployment's execution policy.

Sessions created with `liveViewer: true` always run headed and now support the
operator-default alternative backend. Supplying `startUrl` creates and
navigates the session atomically. `/v1/sessions/:id/challenge` reports the live
page state, while `/v1/sessions/:id/challenge/wait` polls for at most 60 seconds
without clicking, injecting tokens, or moving clearance cookies between
browsers.

The non-interactive verifier exercises atomic navigation and challenge-state
reporting against an operator-selected public target without attempting to
solve it:

```bash
OPENBROWSE_VERIFY_TARGET=https://example.com \
  npm run verify:challenge-handoff
```

For sites operated by the OpenBrowse deployer, Cloudflare's supported path is
to use dummy Turnstile sitekeys/secrets in automation and configure
pre-clearance for the matching production zone. A `cf_clearance` cookie is tied
to the visitor/device and can be continuously reassessed, so importing a token
or cookie from a different solver/browser is not treated as a reliable backend
feature.

## 2026 candidate review

The 2026-08-20 review also considered Rebrowser Playwright, AntiBrow,
ShardBrowser, BrowseForge, `@aitofy/browser-profiles`, and
`puppeteer-real-browser`.

- Rebrowser is actively maintained and passed a stock navigation control, but
  did not clear the required Cloudflare target. Patchright already covers the
  same driver-patch role in OpenBrowse.
- AntiBrow 2.20.0 uses an online-licensed closed kernel and requires an API key.
  It is not a self-contained OpenBrowse runtime dependency.
- ShardBrowser's closed engine license forbids incorporating it into a
  commercial browser or fingerprint service without separate permission.
- BrowseForge composes Camoufox and CloakBrowser rather than adding a distinct
  engine.
- `@aitofy/browser-profiles` uses script/CDP injection and its own documentation
  says modified Chromium is required for full coverage.
- `puppeteer-real-browser` is not current enough for this pinned Playwright
  architecture and would add a second automation stack.

No browser-only backend guarantees access. Modern challenge systems combine
browser consistency with network reputation, request history, JavaScript
signals, and behavior. OpenBrowse reports the result instead of fabricating a
successful solve.
