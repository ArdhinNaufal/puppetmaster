# ▶ NEXT — the single next action

**Updated 2026-07-08.** Read this first; details live in the referenced files.

## Blocked on the operator (costs money, needs Docker + a live key)

**WP3b.4 `bench.delegate` host acceptance** — the only step that spends real tokens.
Run on a Docker-capable host, per CLI (ADR-008 made it pluggable):

```
docker build -t puppetmaster-workbench:spike -f docker/workbench.Dockerfile .
pnpm --filter "@puppetmaster/kernel..." build
ANTHROPIC_API_KEY=sk-... node scripts/verify-delegate.mjs                       # claude
DELEGATE_CLI=aider DELEGATE_MODEL=openai/gpt-4o OPENAI_API_KEY=sk-... \
  node scripts/verify-delegate.mjs                                              # aider
```

Record the PASS in `todos/backlog/wp3-workbench-connector.md` (RESUME POINT) before
building further on delegate. Keyless parser acceptance already passes:
`node scripts/verify-delegate-parse.mjs`.

## Next keyless build (no Docker/key needed) — do this if not waiting on the host

**WP5 RECORD orchestration** (`todos/active/wp5-workshop-phases.md`): learnings + todo
completion + ADR-on-accept KB mirror + skill-extraction proposal into procedural memory.
It's the one remaining WP5 phase that does NOT depend on the unverified delegate live
path (RECORD works over already-verified artifact/todo/KB tools). The ADR-on-accept
mirror is the concrete deterministic slice: extend `mirrorArtifactToKb` (currently
spec+learning) to mirror an `adr` on acceptance, wire it into `supersedeAdr`/accept, and
pin it with a golden task (accept ADR → mirrored once).

## Blocked on the above

**WP5 EXECUTE templates** (`/next` supervised, `/loop` gated) — build on `bench.delegate`;
hold until at least one delegate adapter is host-green.
