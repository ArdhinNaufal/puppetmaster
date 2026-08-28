# Science real-browser release evidence

This retained Playwright/axe harness exercises the Science Operations UI in an
installed Chrome, Edge, or Chromium browser. It does not download a browser and
does not reuse developer data: every invocation gets a new PGlite database,
filesystem artifact root, and quarantine root below ignored `test-results/`.

## What the gate proves

The single-worker suite covers:

- UI login and reasoned workspace pilot admission;
- admin creation of a digest-pinned deterministic compute profile;
- study creation and immutable notebook upload from the small checked-in fixture;
- explicit units/seeds/resources, compute submission, and NEXUS authorization;
- succeeded run plus complete manifest;
- manifest re-run and provenance comparison;
- exact selection of a ready run-linked PNG output and a static render request
  bound to that artifact-version ID;
- a same-origin render gateway redirect followed by a successful `image/png`
  response and a loaded 32 × 32 fixture image;
- displayed render source name, full artifact-version ID, full SHA-256, size,
  media type, run ID, mode, provider, and state matching the selected run output;
- successful render close plus a second same-origin `DELETE` returning the same
  revoked tombstone, proving the close replay is idempotent;
- owner/admin authoring of one standalone, explicitly synthetic domain review;
- immutable review summary/detail rendering with the exact candidate manifest
  hash and every bound output artifact-version ID/checksum/size;
- independent recomputation of the returned validation record hash from its
  canonical source fields, retained as JSON with `valid: true`;
- keyboard tab/listbox behavior;
- WCAG 2 A/AA axe analysis with zero confirmed serious or critical violations;
- a 1280 × 720 desktop journey where the center and dossier controls remain
  pointer-reachable through the vertically scrollable Science surface;
- a 390 × 844 viewport with no document-level horizontal overflow and no visible
  Science interaction target below 24 × 24 CSS pixels;
- reduced-motion duration collapse; and
- event-bus disconnect, reconnect, and observed `REST RESYNC` transition.

The gate retains line output, an HTML report, a trace for every test, screenshots,
and full axe JSON under ignored `test-results/` and
`playwright-report/` directories. A failure is evidence of a release blocker; the
suite has no expected-failure or blanket skip that can turn a missing capability
into a pass.

Axe `incomplete` results are not silently converted into passes or violations.
Serious/critical incomplete rule and node counts are annotated in the HTML report,
and their full evidence remains in `axe-results.json` for manual review. This is
especially relevant when gradients or pseudo-elements prevent automated contrast
calculation. A zero-violation result does not close those manual checks.

## Latest retained local result

On 2026-08-22, `pnpm run verify:science:browser` rebuilt all seven buildable
workspace projects and passed all 4 browser cases. The measured Playwright
phase completed in 46.9 seconds. The run used the default 1280 × 720 desktop
viewport for the lifecycle, exact-source render/review, and reconnect cases,
then changed the accessibility case to 390 × 844 for its retained mobile
assertions.

The retained axe result contains 0 violations and 0 violation nodes, with 31
passing rules. One serious-impact `color-contrast` rule remains `incomplete`
for 43 gradient- or pseudo-element-backed nodes whose effective background axe
could not calculate. Those nodes are explicitly annotated in the HTML report
and require measured/manual review; they are not represented as certified by
the zero-violation count.

The deterministic FUI source verifier also passed its 12 workspace-admission
and 10 local-release assertions, including the desktop scroll/minimum-workspace
layout contract and exact static source/replay contract.

Retained evidence is under `test-results/science/` and the HTML report is under
`playwright-report/science/`. The exact-source case directory is
`test-results/science/science-release-Science-Op-6352b-xact-succeeded-run-evidence/`
and retains:

- `exact-static-render.png`;
- `exact-static-render-source.png`;
- `immutable-domain-validation-detail.png`;
- `domain-validation-source-verification.json`; and
- `trace.zip`.

The JSON record contains the candidate manifest hash, every snapshotted output
checksum, the persisted record hash, the independently computed record hash,
and `valid: true`. Test result directories are generated/ignored evidence, not
source-controlled fixtures.

## Run it

Build and run only this release gate:

```powershell
pnpm run verify:science:browser
```

To see the discovered cases without launching the services:

```powershell
pnpm run verify:science:browser:list
```

The default isolated ports are web `3100` and API `4100`. Override them when
needed:

```powershell
$env:SCIENCE_E2E_WEB_PORT = "3110"
$env:SCIENCE_E2E_API_PORT = "4110"
pnpm run verify:science:browser
```

Browser discovery checks normal Chrome/Edge/Chromium install locations. Set an
explicit executable if needed:

```powershell
$env:SCIENCE_E2E_BROWSER_PATH = "C:\Program Files\Microsoft\Edge\Application\msedge.exe"
pnpm run verify:science:browser
```

## Deliberate boundary

This suite uses the development-only deterministic provider and embedded PGlite
to make UI behavior repeatable. Its static PNG is labelled fixture evidence,
and its review values explicitly say they are synthetic/non-release. It is
real-browser evidence, but it is not proof of isolated OCI/Jupyter execution,
live PostgreSQL/Redis/S3 behavior, remote rendering, trame, OCCT/vtk.js fidelity,
production load targets, disaster recovery, or scientific domain correctness.
Those remain separate live and human-review release gates.
