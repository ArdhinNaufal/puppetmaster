import { useCallback, useEffect, useRef, useState } from "react";
import { agentApi, type Agent, type AgentMessage } from "./api.js";

/**
 * Command view (PRD §6): chat-first interaction with an agent. Messages are
 * persisted server-side; the parent triggers `refreshKey` bumps when live
 * `agent.message` bus events arrive for the selected agent.
 */
export function Command(props: {
  agent: Agent | null;
  refreshKey: number;
  onRan: (missionId: string) => void;
}) {
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const load = useCallback(() => {
    if (!props.agent) return;
    agentApi.messages(props.agent.id).then(setMessages).catch(() => {});
  }, [props.agent]);

  useEffect(load, [load, props.refreshKey]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages]);

  const send = async () => {
    if (!props.agent || !draft.trim() || busy) return;
    setBusy(true);
    try {
      const { missionId } = await agentApi.chat(props.agent.id, draft.trim());
      props.onRan(missionId);
      setDraft("");
      setTimeout(load, 300);
    } finally {
      setBusy(false);
    }
  };

  if (!props.agent) {
    return <div className="canvas-empty">Select or create an agent to open a channel.</div>;
  }

  return (
    <div className="cmd-wrap">
      <div className="cmd-head">
        <span className="cmd-agent">◉ {props.agent.name}</span>
        <span className="tag-lo">
          {props.agent.model.toUpperCase()} · {props.agent.autonomy.replace("_", " ").toUpperCase()}
        </span>
      </div>
      <div className="cmd-scroll" ref={scrollRef}>
        {messages.length === 0 && <p className="muted pad">Channel open. Say something.</p>}
        {messages.map((m) => (
          <MessageRow key={m.id} msg={m} />
        ))}
      </div>
      <div className="cmd-input-row">
        <input
          className="cmd-input"
          placeholder={`Message ${props.agent.name}…`}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void send();
          }}
        />
        <button className="chip accent" onClick={send} disabled={busy || !draft.trim()}>
          {busy ? "…" : "SEND ⏎"}
        </button>
      </div>
    </div>
  );
}

function MessageRow({ msg }: { msg: AgentMessage }) {
  if (msg.role === "tool") {
    const results = msg.content.toolResults ?? [];
    return (
      <div className="msg tool">
        {results.map((r, i) => (
          <span key={i} className={`msg-toolres ${r.isError ? "err" : ""}`}>
            ⮑ {r.isError ? "ERROR " : ""}
            {JSON.stringify(r.result)}
          </span>
        ))}
      </div>
    );
  }
  const calls = msg.content.toolCalls ?? [];
  return (
    <div className={`msg ${msg.role}`}>
      <span className="msg-role">{msg.role === "user" ? "YOU" : "AGENT"}</span>
      <div className="msg-body">
        {msg.content.text && <p>{msg.content.text}</p>}
        {calls.map((c) => (
          <span key={c.id} className="msg-toolcall">
            ⚙ {c.name.replace("__", ".")}({JSON.stringify(c.args)})
          </span>
        ))}
      </div>
    </div>
  );
}
