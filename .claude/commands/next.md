Read todos/active/, learnings.md, and the spec the active todo references. Tell me the
single next undone task and confirm your understanding of it with me before starting.

Once I confirm, do ONLY that one task:
1. Implement it, staying strictly inside what the spec/todo lists. Never add a schema
   field, tool, or feature the spec doesn't name — ask me first.
2. Write automated tests for it and run them: `pnpm test` (plus `pnpm eval` if kernel or
   golden-task behavior changed). Show me the pass/fail output verbatim.
3. Run `pnpm typecheck && pnpm build` and `./scripts/verify-arch.sh`. Show output.
4. Run the spec's verification steps that apply to this task and give me the evidence
   (command output; screenshots for UI work).
5. Update the todo file (move to todos/completed/ if done), add newly discovered work to
   todos/backlog/, and append anything learned the hard way to learnings.md.
6. STOP. Do not start the next task. Present the evidence and wait for me.
