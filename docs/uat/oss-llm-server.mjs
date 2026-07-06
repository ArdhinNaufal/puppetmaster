/**
 * Local open-source OpenAI-compatible model server (UAT harness).
 *
 * The session's egress policy blocks every hosted open-source AI API (Groq,
 * OpenRouter, Together, HuggingFace, Ollama) and every model-weight host, and
 * no provider API keys are provisioned. To still drive Puppetmaster's REAL
 * `openai/*` provider over HTTP — exercising the OpenAI wire protocol, the
 * message/tool-schema translation, and the tool-call parsing that the bundled
 * in-process mock provider bypasses — this stands up a local, self-contained
 * OpenAI-compatible endpoint (MIT, no external calls, no weights).
 *
 * It is intent-following, not a neural net: it reads the last user turn and the
 * offered tools and responds with either a plain assistant message or an
 * OpenAI-format tool_call, so agent + tool + memory + bridge flows all run
 * through the genuine provider code path.
 *
 *   POST /v1/chat/completions   OpenAI chat with tools + usage
 *   GET  /v1/models             lists the served model id
 */
import http from "node:http";

const PORT = Number(process.env.OSS_LLM_PORT ?? 4711);
const MODEL_ID = process.env.OSS_LLM_MODEL ?? "oss-instruct-uat";

const approxTokens = (s) => Math.max(1, Math.round((s ?? "").length / 4));

function readJson(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        resolve(JSON.parse(body || "{}"));
      } catch {
        resolve({});
      }
    });
  });
}

/** Decide the assistant turn from the conversation + offered tools. */
function decide(messages, tools) {
  const toolNames = new Set((tools ?? []).map((t) => t.function?.name).filter(Boolean));
  const last = messages[messages.length - 1] ?? {};

  // A tool result just came back → summarize and end the turn (no tool call).
  if (last.role === "tool") {
    let payload = last.content ?? "";
    // Unwrap the untrusted-data envelope so the summary quotes the real value.
    const inner = /<untrusted_data[^>]*>\n?([\s\S]*?)\n?<\/untrusted_data>/.exec(payload);
    if (inner) payload = inner[1];
    return { content: `Done. The tool returned: ${payload}`.slice(0, 600), tool_calls: null };
  }

  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const text = typeof lastUser?.content === "string" ? lastUser.content : "";

  // Explicit tool drive: "use <server.tool> {json-args}"
  const useMatch = text.match(/use\s+([\w.]+)\s*(\{[\s\S]*\})?/i);
  if (useMatch) {
    const [server, tool] = useMatch[1].split(".");
    const fn = `${server}__${tool}`;
    if (toolNames.has(fn)) {
      let args = {};
      try {
        args = useMatch[2] ? JSON.parse(useMatch[2]) : {};
      } catch {
        /* leave empty */
      }
      return { content: "", tool_calls: [tc(fn, args)] };
    }
  }

  // "remember: X" → persist a memory
  const remember = text.match(/remember:\s*([\s\S]+)/i);
  if (remember && toolNames.has("memory__save")) {
    return { content: "", tool_calls: [tc("memory__save", { content: remember[1].trim() })] };
  }

  // "recall X" / "what do you know about X" → search memory
  const recall = text.match(/(?:recall|what do you (?:know|remember)(?:\s+about)?)\s*:?\s*([\s\S]+)/i);
  if (recall && toolNames.has("memory__search")) {
    return { content: "", tool_calls: [tc("memory__search", { query: recall[1].trim().slice(0, 80) })] };
  }

  // Plain assistant reply.
  const sys = messages.find((m) => m.role === "system")?.content ?? "";
  const persona = /You are ([^,\n.]+)/.exec(sys)?.[1] ?? "an assistant";
  return {
    content: `[${MODEL_ID}] As ${persona}, here is my answer to "${text.slice(0, 80)}": acknowledged and handled.`,
    tool_calls: null,
  };
}

let counter = 0;
function tc(name, args) {
  return {
    id: `call_${Date.now()}_${counter++}`,
    type: "function",
    function: { name, arguments: JSON.stringify(args ?? {}) },
  };
}

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/v1/models") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ object: "list", data: [{ id: MODEL_ID, object: "model", owned_by: "oss-uat" }] }));
  }
  if (req.method === "POST" && req.url === "/v1/chat/completions") {
    const body = await readJson(req);
    const { content, tool_calls } = decide(body.messages ?? [], body.tools ?? []);
    const promptTokens = (body.messages ?? []).reduce(
      (n, m) => n + approxTokens(typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "")),
      0,
    );
    const completionTokens = approxTokens(content) + (tool_calls ? tool_calls.length * 8 : 0);
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(
      JSON.stringify({
        id: `chatcmpl-${Date.now()}`,
        object: "chat.completion",
        model: body.model ?? MODEL_ID,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: content || null, ...(tool_calls ? { tool_calls } : {}) },
            finish_reason: tool_calls ? "tool_calls" : "stop",
          },
        ],
        usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens },
      }),
    );
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`oss-llm-server (${MODEL_ID}) on http://127.0.0.1:${PORT}`);
});
