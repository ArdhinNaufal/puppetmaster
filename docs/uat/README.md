# UAT harness

Reusable harness behind `docs/UAT-REPORT.md`.

- **`oss-llm-server.mjs`** — a local, self-contained, open-source **OpenAI-compatible model
  server** (MIT, no external calls, no weights). Speaks `POST /v1/chat/completions` with
  tool-calling + token usage and `GET /v1/models`. It exists because this environment's
  egress policy blocks every hosted open-source AI API and model-weight host, and no provider
  keys are provisioned — so it lets Puppetmaster's real `openai/*` provider be driven over
  genuine HTTP. It is intent-following (reads the last user turn + offered tools), not a
  neural net; it drives the full agent/tool/memory/bridge code paths.

- **`uat.py`** — feature-by-feature UAT driver (stdlib only). Exercises auth/RBAC, workflows,
  durable execution, webhooks, agents, memory, the bridge, MCP, security, RAG, evals, ops,
  Stages 9A/9B/9C, templates, and audit against a live server, writing `uat-results.json`.

## Run

```bash
pnpm build
node docs/uat/oss-llm-server.mjs &
REDIS_URL=redis://127.0.0.1:6379 \
  OPENAI_BASE_URL=http://127.0.0.1:4711 OPENAI_API_KEY=dummy \
  PUPPETMASTER_MASTER_KEY=uat-master-key HTTP_ALLOWED_HOSTS=127.0.0.1,example.com \
  PORT=4123 node apps/server/dist/main.js &
python3 docs/uat/uat.py
```

Notes: two checks in `uat.py` (`workflow.run`, `agent.ask`) intentionally send tool arguments
under the wrong key and were re-verified by hand with the schema-advertised field names
(`workflowId`; `agent`+`message`) — see UAT-REPORT §3.
