# Learnings — discovered the hard way (append-only)

Convention (docs/AI-SDLC-INTEGRATION-PLAN.md, WP0): append entries as they are earned;
never rewrite history. Each entry states the gotcha and what to do instead. If an entry
graduates into an enforced rule, note the verifier that now covers it.

## 2026-07-06 — Tool-prefix collisions with core entity names

The Workshop plan v1.0 named workbench tools `ws.*`, which reads as "workspace" — a core
Puppetmaster entity. Renamed to `bench.*` before any code existed. Lesson: before naming a
tool namespace, check it against the PRD §4 glossary (agent, workflow, tool, mission,
approval, workspace). Same reasoning rejected "pipeline" (collides with workflow).

## 2026-07-06 — Number ADRs by creation order; never renumber

The integration plan reserved ADR-001..005 for Workshop decisions before ADR-000 and the
retroactive ADRs existed, so the retros became ADR-006/007 despite documenting older
decisions. Lesson: ADR numbers are creation-ordered identifiers, not a chronology of the
decisions themselves — mark retroactive ADRs as such and never renumber to "fix" ordering
(links break silently).

## 2026-07-06 — The SDLC corpus references two absent companions

`ai-sdlc-workflow-guide.md` cites `ai-sdlc-worked-examples.md` and `ai-sdlc-pipelines.md`;
neither exists in `docs/software-engineering-development-ai-workflow/`. Do not cite them
as sources. Only the B-track (unified) pipeline is present.

## 2026-07-06 — pnpm add -w does not link workspace packages

`pnpm add -D -w <pkg>` installed only the root importer; `packages/*/node_modules` stayed
missing, which breaks anything resolving `@puppetmaster/*` (dependency-cruiser included).
Run a full `pnpm install` after fresh clones before running tooling that resolves
workspace imports. Also: `@puppetmaster/*` resolve to `dist/` (`main: dist/index.js`), so
`pnpm build` must precede cross-package resolution checks on a fresh clone.

## 2026-07-06 — Workflow node input = upstream OUTPUT, not the mission payload

A non-trigger node's `{{input.*}}` templates resolve against the immediately upstream
node's output — only entry nodes see the mission payload. A chain `trigger → A → B`
gives B the output of A, so B's args can't reference payload fields. Idiom: add a direct
`trigger → B` edge declared BEFORE the `A → B` edge — input resolution takes the first
satisfied edge's upstream output (the payload), while the second edge still enforces
ordering. Verifier: pinned by the `workshop-artifact-lifecycle` golden task.

## 2026-07-06 — Undefined CSS custom properties fail silently

`var(--line)` compiled and rendered without any error — the design system's border token
is `--stroke` (see fui.css `:root`). Neither tsc nor Vite validates CSS variable names.
Check new rules against the tokens actually defined in fui.css; an invalid var() just
computes to nothing at runtime.

## 2026-07-06 — Eval predicates go through repo functions, not raw tables

Importing `drizzle-orm` in apps/server (for eval DB-state predicates) fails: the server
doesn't depend on drizzle directly and must not — table access belongs to
@puppetmaster/db. The fix that keeps the dependency direction honest: add the tiny query
helper (`listChildMissions`) to the db package and call it from the eval.
