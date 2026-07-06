# UAT harness

Reusable harness behind `docs/UAT-REPORT.md`. Two AI backends both drive Puppetmaster's real
`openai/*` provider over HTTP (the environment's egress policy blocks every hosted
open-source AI API and weight host, and no provider keys are provisioned).

- **`real-llm-server.mjs`** — **Tier A: a real open-source neural model.** Serves
  **SmolLM2-135M-Instruct** (Apache-2.0) on llama.cpp (`node-llama-cpp`, prebuilt binary from
  npm) behind `POST /v1/chat/completions`. The weights come through an allowed channel: the
  [`llm-smollm2`](https://pypi.org/project/llm-smollm2/) PyPI wheel bundles the GGUF, so
  `pip download llm-smollm2` fetches it from `files.pythonhosted.org` with no blocked host.
  Genuine CPU neural inference; too small for reliable tool-calling (see report §5).

- **`oss-llm-server.mjs`** — **Tier B: a local, self-contained OpenAI-compatible protocol
  server** (MIT, no external calls, no weights). Intent-following, not a neural net; it drives
  the full agent/tool/memory/bridge code paths incl. structured tool-calling deterministically
  over the same real provider HTTP path.

- **`uat.py`** — feature-by-feature UAT driver (stdlib only). Exercises auth/RBAC, workflows,
  durable execution, webhooks, agents, memory, the bridge, MCP, security, RAG, evals, ops,
  Stages 9A/9B/9C, templates, and audit against a live server, writing `uat-results.json`.

## Run

```bash
pnpm build

# Tier A — real neural model
pip download llm-smollm2 --no-deps -d /tmp/m
python3 -c "import zipfile,glob;zipfile.ZipFile(glob.glob('/tmp/m/*.whl')[0]).extractall('/tmp/m')"
# point real-llm-server.mjs's MODEL_PATH at /tmp/m/llm_smollm2/SmolLM2-135M-Instruct.Q4_1.gguf
npm i node-llama-cpp@3 && node docs/uat/real-llm-server.mjs &
REDIS_URL=redis://127.0.0.1:6379 OPENAI_BASE_URL=http://127.0.0.1:4712 OPENAI_API_KEY=dummy \
  COPILOT_MODEL=openai/smollm2-135m-instruct PORT=4124 node apps/server/dist/main.js &

# Tier B — full feature coverage
node docs/uat/oss-llm-server.mjs &
REDIS_URL=redis://127.0.0.1:6379 OPENAI_BASE_URL=http://127.0.0.1:4711 OPENAI_API_KEY=dummy \
  PUPPETMASTER_MASTER_KEY=uat-master-key HTTP_ALLOWED_HOSTS=127.0.0.1,example.com \
  PORT=4123 node apps/server/dist/main.js &
python3 docs/uat/uat.py
```

Notes: two checks in `uat.py` (`workflow.run`, `agent.ask`) intentionally send tool arguments
under the wrong key and were re-verified by hand with the schema-advertised field names
(`workflowId`; `agent`+`message`) — see UAT-REPORT §4.
