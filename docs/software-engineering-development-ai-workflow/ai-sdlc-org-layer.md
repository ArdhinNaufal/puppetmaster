# Org Layer — Deploying the Three Pipelines Across People
 
**Version 1.0 — June 2026.** Companion to `ai-sdlc-pipelines.md`. The pipelines are individual-practice machines. This is the layer *above* them: how an org of mixed people runs all three at once and trusts the output. It is not a fourth pipeline you run instead — it's the connective tissue between people.
 
> **Evidence honesty up front.** The *thesis* in §0 (the bottleneck migrates from coding to verification) is the best-corroborated claim in the source corpus — independently triple-sourced (E2/E3). The *rollout playbook* in §5 is a **single vendor account at ~40 engineers (E3)** — the weakest-evidenced thing in this doc. Adopt the thesis with confidence; adopt the playbook as a starting hypothesis and right-size it to your headcount.
 
---
 
## 0. What an org changes — and the misread to avoid
 
**An org does not pick a pipeline.** The three tracks sort by *what a person can verify* (guide §1), not by job title and not by org membership. Your org is a population:
 
| A person who can verify… | Runs | Typical roles |
|---|---|---|
| Behavior only (uses the product, reads a screenshot) | Pipeline A | PMs, domain experts, designers, founders without an engineering background |
| Code (reads a diff, writes/reads tests) | Pipeline B | Developers, individual contributors who ship |
| Systems (accountable for CI, security, others' code, maintenance) | Pipeline C + **owns this org layer** | Tech leads, staff/principal engineers, eng managers |
 
Membership in the org moves no one up a track; verification ability does. A person can sit on different tracks for different work — the sort is per-task-ability, not per-identity. **The org's first job is this sort, plus handing each person the matching pipeline doc.** Misassignment is the failure mode: an Operator handed Pipeline C ships an unverifiable liability; a developer throttled onto Pipeline A is held below their ability.
 
**The thesis the org layer exists to serve** (E2/E3, triple-corroborated — the AI-native-org frame): once agents make coding throughput cheap, *throughput stops being the constraint.* The bottleneck migrates to **verification capacity, review process, security validation, and ownership norms.** Optimizing prompt quality while review is the constraint is solving the wrong problem.
 
---
 
## 1. The load-bearing mechanism: evidence-on-PR (build this first)
 
This is the highest-value, most durable org practice, and the reasoning — not just the assertion — is why I'd build it before anything else: **cross-person trust does not scale by re-deriving it** (re-reviewing every line another person's agent wrote). It scales by reviewing the *evidence the agent produced.* So make it policy that **every AI-produced PR carries machine-checkable evidence**, not a claim:
 
- the exact test command and its output
- the verification script's run — the one that asserts on resulting **state** (DB rows, files), never on a status code
- screenshots or a recording of the flow being exercised, wherever behavior is the deliverable
- for anything touching untrusted input: proof the quarantine constraints held (no network, no out-of-scope writes)
The reviewer's job becomes *judging evidence* (fast, scales) instead of *reconstructing trust* (slow, doesn't). A PR without its evidence artifact is not "trust me" — it is "not ready for review." This is the guide's "evidence, not assertions" (§3) promoted from a personal habit to org policy, and it is the concrete answer to the bottleneck in §0: it makes review capacity keep up with throughput.
 
---
 
## 2. Shared context is a commons — govern it by curation
 
Skills, CLAUDE.md fragments, and saved workflow templates are shared context. Every shared skill costs context for *everyone* who loads it (Invariant 1, guide §3). So promotion to the shared collection is not a convenience — it is curation, and it must have a bar.
 
The evidenced model (E2/E3): a skill lives in one person's or team's **sandbox folder** → earns **traction** through real use → gets **promoted** to the shared marketplace on demonstrated value, not on request. Organic, no central committee — but with a cost to entry. Measure actual usage with a tool-logging hook, **not** self-report; promote what's used, prune what isn't. A shared collection that only grows is a context tax that only rises, and it eventually makes everyone's agent worse (bloated context → real instructions ignored, guide §3).
 
---
 
## 3. Answer the ownership question in writing — before the incident
 
"Who owns code no human wrote?" gets a written answer *before* the first production incident, not improvised during the postmortem. This one is not evidenced as a measured practice — no case study quantifies it — and it's included anyway for a specific reason: the *absence* of an answer is a known failure shape, and writing one down costs an afternoon. It is the cheapest item in this doc and the only one worth doing pre-emptively (see §6).
 
---
 
## 4. Rollout — right-size to headcount (E3, single source — treat as hypothesis)
 
The only structured rollout in the corpus is one vendor's, at roughly 40 engineers. Here it is, with the scaling honestly bracketed:
 
**The evidenced arc (~10–50 people):** pilot with 20–50 genuine enthusiasts whose deliverables are *artifacts* — CLAUDE.md files, skills, an automation inventory, a support channel → launch wide with a **hackathon** → sustain via **internal champions** over external training. The pilot's output *is* the org's starter context layer, not a slide deck.
 
| Headcount | What to actually do |
|---|---|
| **Under ~10** | Skip the pilot machinery — a 20–50-person pilot in an 8-person company is theater. The most able person builds the shared context layer and the evidence-on-PR norm; everyone adopts directly. Governance overhead before you have the headcount to need it is paying rent for nothing. |
| **~10–50** | The playbook as written. This is its evidence range; use it close to verbatim. |
| **50+ / enterprise** | Unevidenced extrapolation. The arc probably holds, but security review, compliance, and formal ownership get heavier than the case describes. Use the playbook as a skeleton, expect governance the mid-size case never needed, and don't assume the vendor's numbers transfer. |
 
---
 
## 5. Measure outcomes, not activity
 
Track: task-completion time, migration velocity, onboarding duration, cross-functional dependency reduction. Do **not** steer by lines of code — the vendor that publishes the metric admits it "captures activity, not necessarily value" (E3). The metric that matters in an org is the one §0 names made visible: **is review capacity keeping up with throughput?** If PRs queue at review, that backlog *is* your bottleneck — and the fix is evidence-on-PR (§1) and fresh-context review agents, not more coding speed.
 
---
 
## 6. Sequencing warning — don't build this layer before you feel the pain
 
The bottleneck-migration thesis is **conditional**: the constraint moves to review only *after* throughput actually rises. If your org hasn't genuinely adopted agentic coding yet, the bottleneck hasn't migrated, and building governance, marketplaces, and dashboards now is solving a problem you don't have. Run the pilot, let throughput climb, and build each piece of this layer *in response to the specific friction that appears* — the escalation rule from guide §5 (automate a behavior only after you've hit its failure manually), applied at org scale.
 
The single exception: the ownership answer (§3). Its failure mode is an incident, not friction, so it's the one thing you write down before the pain rather than after.
 
---
 
## Close
 
The pipelines make individuals productive. This layer makes the org *trust* that productivity without re-reviewing every line. Stripped down, the whole thing is one move repeated at organizational scale: **replace re-derived trust with produced evidence.** Build §1 first; let §4–§6 follow the actual pain. And keep the evidence marks visible — the thesis you can bank on; the playbook you're running as an experiment until your own org's numbers confirm or refute it.