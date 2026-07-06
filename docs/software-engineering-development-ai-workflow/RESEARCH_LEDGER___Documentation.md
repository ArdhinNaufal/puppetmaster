# RESEARCH LEDGER — Phase: Documentation (Extension Session 3)
 
**Session date:** July 2026. Tracks extension plan v1.0, guide v1.3, unified pipeline v1.2.
 
---
 
## 1. Source inventory
 
| # | Source | Evidence class | Retrieval | Status |
|---|--------|---------------|-----------|--------|
| S1 | Diátaxis framework (diataxis.fr) — Daniele Procida | E2c | Fetched (diataxis.fr/start-here, /compass) | Read, dispositioned |
| S2 | Nygard, "Documenting Architecture Decisions" (2011) + adr.github.io | E2c | Fetched (adr.github.io, adr-templates, GitHub template repo) | Read, dispositioned |
| S3 | Google developer documentation style guide (developers.google.com/style) | E2c | Fetched (highlights page, about page) | Read, dispositioned |
| S4 | Write the Docs community material (writethedocs.org) | E2c-borderline / E4 | Fetched (docs-principles, docs-as-code) | Read, dispositioned |
| S5 | Konishi, "ADR Templates and Operational Patterns" (2026) | E4 | Fetched (hidekazu-konishi.com) | Read — failure modes useful |
| S6 | Catio, "ADRs: The 2026 Guide" | E4 | Fetched (catio.tech/blog) | Read — anti-patterns useful |
| S7 | Zimmermann, "How to create ADRs — and how not to" (ozimmer.ch, 2023) | E2c-borderline | Fetched (ozimmer.ch) | Read — anti-pattern taxonomy useful |
| S8 | Google, "Documentation Best Practices" (styleguide/docguide) | E2c | Fetched (google.github.io/styleguide) | Read, dispositioned |
| S9 | arxiv: "Context Rot in AI-Assisted Development" (2606.09090) | E4 | Search snippet only | Used for framing only |
| S10 | driftdev.sh — docs-drift detection tooling (TypeScript-specific) | E4 | Search snippet only | Mechanism noted, not adopted |
 
---
 
## 2. Per-source findings
 
### S1 — Diátaxis (E2c fetched)
 
**Core mechanism.** Four documentation quadrants defined by two axes:
 
| Axis 1: Action vs. Cognition | Axis 2: Acquisition vs. Application | Quadrant |
|---|---|---|
| Action | Acquisition (study) | **Tutorial** — a lesson; the instructor is responsible for learner's success |
| Action | Application (work) | **How-to guide** — addresses a real-world goal; assumes competence |
| Cognition | Application (work) | **Reference** — technical description; neutral, mirrors code structure |
| Cognition | Acquisition (study) | **Explanation** — context, background, "why"; can take perspectives |
 
**The compass** (the actionable tool, not the map). Two questions: "action or cognition?" and "acquisition or application?" These yield the quadrant. The compass is the decision tool; the map is the mnemonic.
 
**Key constraints for this project:**
- Quadrants must be kept separate — blurring boundaries is "at the heart of a vast number of problems in documentation" (S1, fetched).
- Tutorials overloaded with explanation is the most common mixing error.
- The framework prescribes content, architecture, and form — but imposes no implementation constraints.
- Adopted by Python docs community, Canonical, Cloudflare, Gatsby, Vonage — breadth supports E2c classification.
**Disposition:** Adopted as the organizing framework per the plan. The four quadrants become the structure the spec interview forces the project to allocate docs into. The compass becomes the skill's classification tool. Scope guard honored: we take the consensus core (four quadrants + compass); everything beyond (workflow methodology, complex hierarchies) is org taste and stays out.
 
### S2 — Nygard ADR (E2c fetched)
 
**Core mechanism.** Five sections: Title, Status, Context, Decision, Consequences. Lightweight by design — Nygard created it explicitly as a reaction against large architecture documents nobody reads.
 
**The Nygard template (canonical):**
- **Status**: proposed / accepted / rejected / deprecated / superseded
- **Context**: the forces at play, the motivating issue
- **Decision**: the change being made
- **Consequences**: what becomes easier or more difficult
**Key constraints for this project:**
- ADRs are immutable once accepted — status changes to "superseded" with a pointer to the new ADR, never edited.
- ADRs capture decisions, not designs — a common failure mode is using ADRs as design documents (S5, S6, S7 all confirm).
- The template is deliberately minimal; MADR and Y-Statement variants add fields but the Nygard core is the consensus minimum.
**Failure modes from research (S5, S6, S7):**
1. **Retroactive ADRs** — written months after the decision; context reconstructed, alternatives forgotten, consequences described as outcomes not forecasts (S5, S6). Fix: ADR is part of the decision, not an artifact of it.
2. **ADRs as universal documentation** — capturing operations, design, and notes as "ADRs" until the actual decisions are lost in noise (S6). Fix: be picky about scope.
3. **Orphaned ownership** — author leaves, ADRs remain "Accepted" forever even after the codebase moves on (S6).
4. **Missing alternatives** — only the chosen option is documented, so future teams don't understand why obvious alternatives weren't chosen; old debates repeat (S5, S7).
5. **Mega-ADR** — detailed design crammed into ADRs; multi-page documents with code snippets and diagrams (S7, anti-pattern "Blueprint or Policy in Disguise").
6. **Sprint / Rush** — only one option considered, only short-term effects discussed (S7).
7. **No expiry trigger** — the strongest ADRs name the trigger for reconsideration: "Reconsider if X changes" (S6). Without this, ADRs never expire.
**Disposition:** Adopted as the RECORD mechanism for architecture decisions. Nygard template used as the base. Two modifications for this project's AI-assisted context: (a) a "Reconsider-when" field added per the expiry-trigger research finding, and (b) integration with session 1's forcing sections as the decision trigger. The skill design must prevent the mega-ADR and retroactive-ADR failure modes.
 
### S3 — Google developer documentation style guide (E2c fetched)
 
**Core highlights (fetched, highlights page):**
- Conversational, friendly tone without being frivolous
- Second person ("you"), active voice, present tense
- Sentence case for headings
- Serial commas
- Code in code font, UI elements in bold
- Descriptive link text (not "click here")
- Write for accessibility; write for a global audience
- Guidelines, not rules — "Depart from it when doing so improves your content"
**History and scale:** Originally internal-only (2005), made public 2017. Used by hundreds of Google technical writers plus external contributors to Kubernetes, AMP, Dart. Actively maintained with regular updates.
 
**Key constraint for this project:** The guide is enormous (dozens of pages covering word lists, punctuation, formatting, procedures, code samples, UI elements, etc.). The whole thing cannot be loaded as a skill — it must be distilled to the highest-signal subset for on-demand use. The mechanism from Google's own advice (S8): "Do not write your own editorial style guide" — adopt one, don't reinvent. So the skill points to the guide, doesn't reproduce it.
 
**Disposition:** Adopted as the style baseline, delivered as an on-demand skill that references the guide's highlights and key principles. The skill's value is in the gotchas (what the model gets wrong without the guide), not in reproducing the guide's content. The Google guide itself advises treating its rules as guidelines, which aligns with our [judgment — review gate] classification.
 
### S4 — Write the Docs (E2c-borderline / E4, fetched)
 
**Useful mechanisms extracted:**
- "ARID" — not DRY, not WET. Documentation inherently repeats some code logic; aim to minimize but accept the moisture. Practical framing.
- "Consider incorrect documentation to be worse than missing documentation." This is the documentation-drift principle in one sentence.
- "Docs as Code" — documentation in the codebase, reviewed in PRs, blocking merges if missing. The mechanism we need for the drift hook.
- "Begin documenting before you begin developing" — consistent with our spec-first workflow (the spec IS the first documentation).
**Disposition:** E2c-borderline because Write the Docs is a community, not a singular canonical source with multi-decade convergence. Mechanisms used where they reinforce E2c sources (Diátaxis, Google guide). "Incorrect docs worse than missing docs" and "docs as code" are the two mechanisms that enter the companion doc. Outcome claims about community benefits are E4 and discarded.
 
### S5, S6, S7 — ADR failure mode sources (E4)
 
Already integrated into S2 findings above. These sources are valuable for their failure-mode catalogs, not for their recommendations on template choice or process design. Treated as E4: mechanisms inspectable, outcome claims discarded.
 
### S8 — Google Documentation Best Practices (E2c fetched)
 
**Key mechanism:** "Change your documentation in the same CL as the code change." This is the docs-as-code principle made concrete and is the conceptual basis for our drift hook.
 
**Other useful principles:**
- "Dead docs are bad. They misinform, they slow down, they incite despair in engineers and laziness in team leads."
- "Write short and useful documents. Cut out everything unnecessary."
- Documentation spectrum: meaningful names → comments → docstrings → README → docs/ → design docs
- Design docs should serve as archives of decisions post-implementation, not as maintained docs (they're "often misused").
**Disposition:** The "same CL" principle is the strongest practical mechanism for preventing drift. In the AI-assisted workflow, this translates to: the docs-drift hook checks whether code changes in documented areas came with doc changes. The documentation spectrum maps onto Diátaxis quadrants.
 
### S9 — Context Rot paper (E4, snippet only)
 
**One relevant finding:** "Code changes are continuously exercised by compilers, automated tests, and CI, so drift is caught quickly. Documentation changes are not, so documentation is updated manually, opportunistically, and often incompletely." This frames the structural asymmetry our hook addresses.
 
**Disposition:** Framing only. The asymmetry is already implicit in guide §4.6 (artifact drift); this paper names the mechanism.
 
### S10 — driftdev.sh (E4, snippet only)
 
**Design philosophy noted:** "Detection is the tool's job. Mutation is the agent's job." Clean separation relevant to our hook design (the hook detects; the agent or human fixes).
 
**Disposition:** Mechanism noted. The tool itself is TypeScript-specific and not adopted.
 
---
 
## 3. Cross-cutting synthesis
 
### 3.1 The verification ceiling is real and must be stated
 
Every source confirms the same thing from different angles: documentation quality is fundamentally a judgment problem, not a mechanical one.
 
- Diátaxis can tell you which quadrant a doc belongs to (compass = classifier), but not whether the doc in that quadrant is any good.
- The Google style guide explicitly says its rules are guidelines; depart when doing so improves content.
- ADR quality depends on whether the context was faithfully captured and the alternatives genuinely considered — no lint check catches a shallow ADR.
- Drift detection can catch presence/absence (code changed, docs didn't), but not correctness (docs changed and are wrong).
**Conclusion:** The companion doc must state this upfront. Presence and drift are gateable; quality is [judgment — review gate]. The session cannot promise more than this without being dishonest by the E-framework.
 
### 3.2 The Diátaxis-ADR integration point
 
Diátaxis is about organizing documentation by user need. ADRs are about preserving decision rationale. These are complementary, not competing. In Diátaxis terms, an ADR is firmly in the **Explanation** quadrant: it serves cognition and acquisition (understanding why something is the way it is). The spec interview forces the decision; the ADR records it; the Diátaxis quadrant tells you where it lives.
 
### 3.3 The generation mapping (scope item 6)
 
The workflow already produces artifacts that map to Diátaxis quadrants:
 
| Existing artifact | Diátaxis quadrant | Generated non-technical doc |
|---|---|---|
| SPEC.md | Reference (what is being built) | README / product overview |
| ADRs | Explanation (why decisions were made) | Decision history for stakeholders |
| learnings.md | Explanation (gotchas, context) | Onboarding guide (what to watch out for) |
| todos/ | — (not documentation) | — |
| PLAN.md | — (ephemeral, not documentation) | — |
| Skills | How-to (how to accomplish a task) | — (agent-internal, not user-facing) |
 
The non-technical doc generation skill takes SPEC, ADRs, and learnings as inputs and produces user-facing documentation mapped to the appropriate quadrant.
 
### 3.4 No E2c conflicts found
 
Unlike sessions 1 and 2, which each surfaced genuine E2c conflicts (ceremony-vs-simplicity, commit-per-step vs. batch-tidyings), this session's sources are complementary rather than contradictory. Diátaxis, Nygard, and the Google guide occupy different concerns (organization, decision recording, style) and don't disagree on any load-bearing mechanism.
 
**One tension noted but not an E2c conflict:** Write the Docs' "docs as code" implies documentation lives in the codebase (markdown files reviewed in PRs). The Google guide doesn't take a position on where docs live. Diátaxis is implementation-agnostic. This is a per-project decision, not a framework-level conflict, and belongs in the spec interview (where does this project's documentation live?). This is a decision hook, not a tradeoff table.
 
---
 
## 4. Dispositions summary
 
| Source | What enters the companion doc | What is excluded |
|---|---|---|
| S1 (Diátaxis) | Four quadrants as spec-interview forcing structure; compass as classification tool in the skill | Workflow methodology, complex hierarchies, adoption strategy |
| S2 (Nygard ADR) | Nygard template + "Reconsider-when" field; trigger integration with session 1's forcing sections | MADR, Y-Statement, and other template variants |
| S3 (Google style guide) | On-demand skill pointing to guide highlights; gotchas the model gets wrong | Full guide content (too large; the skill is a pointer, not a reproduction) |
| S4 (Write the Docs) | "Incorrect docs worse than missing docs" principle; docs-as-code mechanism for drift hook | Community outcome claims, detailed contribution workflows |
| S5–S7 (ADR failure modes) | Seven failure modes seeded in the companion doc | Template comparison matrices, process recommendations |
| S8 (Google best practices) | "Same CL" principle as drift-hook rationale; documentation spectrum | Full internal practices |
| S9 (Context Rot paper) | Framing: structural asymmetry between code verification and doc verification | — |
| S10 (driftdev.sh) | "Detection is the tool's job, mutation is the agent's job" design principle | TypeScript-specific tooling |
 