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
];
