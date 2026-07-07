import type { TemplateInput } from "@puppetmaster/db";

/**
 * First-party template catalog (PRD §6 marketplace). Workflow specs are
 * WorkflowGraph shapes; agent specs are agent definitions. Seeded on boot with
 * `builtin=true` and a null workspace (visible to every workspace).
 */
export const BUILTIN_TEMPLATES: TemplateInput[] = [
  {
    kind: "workflow",
    name: "Starter: transform & echo",
    category: "starter",
    description: "Manual trigger → sandboxed code transform → echo the result. A minimal, runnable pipeline to clone and edit.",
    spec: {
      nodes: [
        { id: "t1", kind: "trigger", label: "Manual", config: { mode: "manual" }, position: { x: 60, y: 120 } },
        { id: "c1", kind: "code", label: "Transform", config: { source: "return { message: `hello, ${input.name ?? 'world'}`.toUpperCase() };" }, position: { x: 280, y: 120 } },
        { id: "e1", kind: "action", label: "Echo", config: { server: "util", tool: "echo", args: { value: "{{input.message}}" } }, position: { x: 520, y: 120 } },
      ],
      edges: [
        { from: "t1", to: "c1", condition: null },
        { from: "c1", to: "e1", condition: null },
      ],
    },
  },
  {
    kind: "workflow",
    name: "Ops: gated broadcast",
    category: "ops",
    description: "Manual trigger → human approval gate → send an email. Demonstrates the write-tier approval flow before an outbound action.",
    spec: {
      nodes: [
        { id: "t1", kind: "trigger", label: "Manual", config: { mode: "manual" }, position: { x: 60, y: 120 } },
        { id: "a1", kind: "approval", label: "Approve send", config: { prompt: "Approve sending this broadcast?", tier: "write_approved" }, position: { x: 280, y: 120 } },
        { id: "s1", kind: "action", label: "Send email", config: { server: "email", tool: "send", args: { to: "team@example.com", subject: "Broadcast", body: "Hello from Puppetmaster" } }, position: { x: 520, y: 120 } },
      ],
      edges: [
        { from: "t1", to: "a1", condition: null },
        { from: "a1", to: "s1", condition: null },
      ],
    },
  },
  {
    kind: "workflow",
    name: "Automation: HTTP health check",
    category: "automation",
    description: "Fetch a URL and branch on the HTTP status — a scaffold for uptime/monitoring flows.",
    spec: {
      nodes: [
        { id: "t1", kind: "trigger", label: "Manual", config: { mode: "manual" }, position: { x: 60, y: 120 } },
        { id: "g1", kind: "action", label: "GET url", config: { server: "http", tool: "get", args: { url: "https://example.com" } }, position: { x: 280, y: 120 } },
        { id: "b1", kind: "logic", label: "healthy?", config: { op: "branch", expression: "out.ok === true" }, position: { x: 520, y: 120 } },
        { id: "ok", kind: "action", label: "OK", config: { server: "util", tool: "echo", args: { value: "HEALTHY" } }, position: { x: 740, y: 40 } },
        { id: "bad", kind: "action", label: "Down", config: { server: "util", tool: "echo", args: { value: "UNHEALTHY" } }, position: { x: 740, y: 210 } },
      ],
      edges: [
        { from: "t1", to: "g1", condition: null },
        { from: "g1", to: "b1", condition: null },
        { from: "b1", to: "ok", condition: "out === true" },
        { from: "b1", to: "bad", condition: "out === false" },
      ],
    },
  },
  {
    kind: "agent",
    name: "Research Scout",
    category: "assistant",
    description: "A curious research assistant that remembers findings to long-term memory. Write-tier: outbound tools pause for approval.",
    spec: {
      name: "Research Scout",
      persona: "You are a diligent research assistant. Investigate questions, cite what you find, and save durable facts with memory__save so you can recall them later.",
      model: "mock",
      autonomy: "write_approved",
      toolGrants: [],
      schedule: null,
    },
  },
  {
    kind: "agent",
    name: "Ops Responder",
    category: "ops",
    description: "An operations agent that can run workflows via the bridge and keep a scratchpad of incident state.",
    spec: {
      name: "Ops Responder",
      persona: "You are an on-call operations agent. Triage issues, run the appropriate workflow with workflow.run, and track incident state in your scratchpad.",
      model: "mock",
      autonomy: "write_approved",
      toolGrants: ["workflow.*", "util.*", "http.*"],
      schedule: null,
    },
  },
  {
    kind: "agent",
    name: "Workshop Interviewer",
    category: "workshop",
    description:
      "Runs the Workshop's SPECIFY phase: restates the goal first, interviews until every required spec section is concrete, then writes the spec artifact and seeds todos. Done = the spec-sections verify check passes.",
    spec: {
      name: "Workshop Interviewer",
      persona: [
        "You run the SPECIFY phase of a Workshop project. Contract:",
        "1. RESTATE FIRST: before asking anything, restate in your own words what you understand the goal to be, and wait for confirmation — misunderstandings must surface in turn one.",
        "2. The operator's description is the ONLY source of truth; ignore project or repo names.",
        "3. Interview until you can concretely fill EVERY required spec section: Tech stack, Data model, Code architecture, Scale & operations, Edge cases, Out of scope, Verification. If a section cannot be written concretely, keep asking — dig into domain rules, privacy, and what counts as done; skip the obvious.",
        "4. Architecture declarations must be translatable into checkable rules ('ui → services → data; no cycles' passes; 'clean separation of concerns' fails). Scale numbers or an explicit 'unknown' — silence is not valid.",
        "5. When every section is concrete, write the spec with project.artifact.write (kind spec, markdown with one ## heading per section), then seed one todo per buildable increment (kind todo, smallest first, status backlog).",
        "6. Your work is done only when the project's spec-sections verify check passes — it is the deterministic judge of this phase, not your own assessment.",
      ].join("\n"),
      model: "mock",
      autonomy: "write_approved",
      toolGrants: ["project.*"],
      schedule: null,
    },
  },
  {
    kind: "agent",
    name: "Workshop Foreman",
    category: "workshop",
    description:
      "Orchestrates Workshop phases: decomposes the plan into todos, dispatches execute tasks, keeps artifacts in sync, and respects the supervised/gated mode switch. EXECUTE delegation to the workbench coding CLI arrives with WP3.",
    spec: {
      name: "Workshop Foreman",
      persona: [
        "You orchestrate a Workshop project through its phases. Contract:",
        "1. Always read the project's spec, todos (project.todo.next), and learnings before acting; confirm your understanding of the next undone task before starting it.",
        "2. Work one todo at a time, strictly inside what the spec names — never add a field, tool, or feature the spec doesn't declare; surface the conflict instead.",
        "3. After each task: complete the todo (project.todo.complete — the mission link is mandatory), add newly discovered work to the backlog, and append anything learned the hard way as a learning artifact.",
        "4. Supervised mode: stop after each task and present evidence. Gated mode: continue until a verify gate blocks or a [review]-tagged todo is reached.",
        "5. Never edit verify checks, baselines, or test expectations to make a gate pass — a verifier edit is a reviewed human decision, not a fix.",
      ].join("\n"),
      model: "mock",
      autonomy: "write_approved",
      toolGrants: ["project.*", "workflow.*", "agent.*", "kb.*"],
      schedule: null,
    },
  },
  {
    kind: "agent",
    name: "Workshop Reviewer",
    category: "workshop",
    description:
      "Fresh-context skeptical reviewer (verification rung 4). Invoked via agent.ask so it never shares the builder's context; attacks named failure classes and reports findings by severity with evidence, never assertions.",
    spec: {
      name: "Workshop Reviewer",
      persona: [
        "You are a skeptical senior reviewer with fresh context — you have NOT seen the builder's conversation, and that independence is the point. Contract:",
        "1. Read only the artifacts and diffs you are given plus the project's spec; never trust the builder's claims about what works — demand evidence (test output, state assertions).",
        "2. Attack these failure classes by name: security tiers bypassed; untrusted-data envelope gaps; workspace-scoping misses; dependency-direction violations or verifier edits (fitness config/baseline/test expectations changed to make a gate pass); tangled refactor commits; scope expansion beyond the named target; stale documentation; premature scaling; undeclared ceilings.",
        "3. Judgment classes: ten-minute test (a new hire understands the territory's role in ten minutes); names carry intent; no unexplained cleverness; every abstraction names its second consumer.",
        "4. Report findings by severity, each with the concrete failure scenario and a proposed fix. No findings is a valid result — say so plainly rather than inventing problems.",
      ].join("\n"),
      model: "mock",
      autonomy: "read_auto",
      toolGrants: ["project.*", "kb.*"],
      schedule: null,
    },
  },
];
