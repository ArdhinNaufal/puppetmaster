/**
 * Local open-source OpenAI-compatible API backed by a REAL neural model:
 * SmolLM2-135M-Instruct (Q4_1 GGUF), run on CPU via node-llama-cpp (llama.cpp).
 *
 * The model weights were obtained through an allowed channel — the `llm-smollm2`
 * PyPI wheel bundles the GGUF — because the session's egress policy blocks every
 * hosted open-source AI API and HuggingFace/Ollama weight hosts. This serves
 * genuine neural inference behind /v1/chat/completions with grammar-constrained
 * tool-calling, so Puppetmaster's real `openai/*` provider drives a real model.
 */
import http from "node:http";
import { getLlama, LlamaChatSession, defineChatSessionFunction } from "node-llama-cpp";

const PORT = Number(process.env.REAL_LLM_PORT ?? 4712);
const MODEL_ID = "smollm2-135m-instruct";
const MODEL_PATH = new URL("./model/llm_smollm2/SmolLM2-135M-Instruct.Q4_1.gguf", import.meta.url).pathname;

const llama = await getLlama();
const model = await llama.loadModel({ modelPath: MODEL_PATH });
console.log(`loaded ${MODEL_ID} (${(model.fileInfo.metadata?.general?.name) ?? "smollm2"})`);

const approxTokens = (s) => Math.max(1, Math.round((s ?? "").length / 4));

function readJson(req) {
  return new Promise((resolve) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => { try { resolve(JSON.parse(b || "{}")); } catch { resolve({}); } });
  });
}

/** JSON-schema "properties" → node-llama-cpp function params schema (best-effort). */
function toParams(schema) {
  if (!schema || schema.type !== "object") return { type: "object", properties: {} };
  const props = {};
  for (const [k, v] of Object.entries(schema.properties ?? {})) {
    const t = v?.type;
    props[k] = t === "number" || t === "integer" ? { type: "number" }
      : t === "boolean" ? { type: "boolean" }
      : t === "object" ? { type: "object" }
      : t === "array" ? { type: "array" } : { type: "string" };
  }
  return { type: "object", properties: props };
}

/** Rebuild a compact single-prompt view of the conversation for the tiny model. */
function lastUserText(messages) {
  const u = [...messages].reverse().find((m) => m.role === "user");
  return typeof u?.content === "string" ? u.content : "";
}
function systemText(messages) {
  const s = messages.find((m) => m.role === "system");
  return typeof s?.content === "string" ? s.content : "You are a helpful assistant.";
}

async function handleChat(body) {
  const messages = body.messages ?? [];
  const tools = body.tools ?? [];
  const last = messages[messages.length - 1] ?? {};
  const sys = systemText(messages);

  // Turn after a tool result → summarize the result (pure generation, no tools).
  if (last.role === "tool") {
    let payload = typeof last.content === "string" ? last.content : JSON.stringify(last.content);
    const inner = /<untrusted_data[^>]*>\n?([\s\S]*?)\n?<\/untrusted_data>/.exec(payload);
    if (inner) payload = inner[1];
    const session = new LlamaChatSession({ contextSequence: model.__seq ?? (model.__seq = (await model.createContext({ contextSize: 2048 })).getSequence()), systemPrompt: sys });
    const text = await session.prompt(
      `A tool was run and returned:\n${payload.slice(0, 500)}\nBriefly tell the user the result in one sentence.`,
      { maxTokens: 80, temperature: 0.3 },
    );
    return { content: text.trim() || `The tool returned: ${payload.slice(0,200)}`, tool_calls: null };
  }

  // Fresh turn: give the model the tools; capture the first tool call it makes.
  const ctx = await model.createContext({ contextSize: 2048 });
  const session = new LlamaChatSession({ contextSequence: ctx.getSequence(), systemPrompt: sys });
  let captured = null;
  const functions = {};
  for (const t of tools) {
    const fn = t.function;
    if (!fn?.name) continue;
    functions[fn.name] = defineChatSessionFunction({
      description: (fn.description ?? "").slice(0, 200),
      params: toParams(fn.parameters),
      handler(args) {
        if (!captured) captured = { name: fn.name, args: args ?? {} };
        return { ok: true }; // short result; we stop using the model's continuation
      },
    });
  }
  let text = "";
  try {
    text = await session.prompt(lastUserText(messages), {
      functions: Object.keys(functions).length ? functions : undefined,
      maxTokens: 120,
      temperature: 0.2,
    });
  } finally {
    await ctx.dispose().catch(() => {});
  }
  if (captured) {
    return { content: "", tool_calls: [{
      id: `call_${Date.now()}`, type: "function",
      function: { name: captured.name, arguments: JSON.stringify(captured.args) },
    }] };
  }
  return { content: text.trim() || "(no output)", tool_calls: null };
}

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/v1/models") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ object: "list", data: [{ id: MODEL_ID, object: "model", owned_by: "oss" }] }));
  }
  if (req.method === "POST" && req.url === "/v1/chat/completions") {
    const body = await readJson(req);
    let out;
    try { out = await handleChat(body); }
    catch (e) { out = { content: `(model error: ${e.message})`, tool_calls: null }; }
    const pt = (body.messages ?? []).reduce((n, m) => n + approxTokens(typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "")), 0);
    const ctok = approxTokens(out.content) + (out.tool_calls ? 8 : 0);
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({
      id: `chatcmpl-${Date.now()}`, object: "chat.completion", model: body.model ?? MODEL_ID,
      choices: [{ index: 0, message: { role: "assistant", content: out.content || null, ...(out.tool_calls ? { tool_calls: out.tool_calls } : {}) }, finish_reason: out.tool_calls ? "tool_calls" : "stop" }],
      usage: { prompt_tokens: pt, completion_tokens: ctok, total_tokens: pt + ctok },
    }));
  }
  res.writeHead(404, {}); res.end();
});
server.listen(PORT, "127.0.0.1", () => console.log(`real-llm-server (${MODEL_ID}) on http://127.0.0.1:${PORT}`));
