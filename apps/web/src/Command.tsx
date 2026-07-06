import { useCallback, useEffect, useRef, useState } from "react";
import { Decode } from "@puppetmaster/ui";
import { agentApi, type Agent, type AgentMessage } from "./api.js";

/**
 * Command view (PRD §6): chat-first interaction with an agent, styled as a
 * secure channel — timestamped transmissions, tool telemetry inline, a live
 * cursor while the agent streams. Messages are persisted server-side; the
 * parent bumps `refreshKey` when live `agent.message` bus events arrive.
 */
export function Command(props: {
  agent: Agent | null;
  refreshKey: number;
  onRan: (missionId: string) => void;
  /** Live streaming text (agent.message.delta) not yet persisted. */
  streaming?: string;
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
  }, [messages, props.streaming]);

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
        <span className="cmd-agent">
          ◉ <Decode text={props.agent.name.toUpperCase()} />
        </span>
        <span className="tag-lo">
          {props.agent.model.toUpperCase()} · {props.agent.autonomy.replace(/_/g, " ").toUpperCase()} · {messages.length} TX
        </span>
      </div>
      <div className="cmd-scroll" ref={scrollRef}>
        {messages.length === 0 && <p className="muted pad">Channel open. Transmit when ready.</p>}
        {messages.map((m) => (
          <MessageRow key={m.id} msg={m} />
        ))}
        {props.streaming && (
          <div className="msg assistant">
            <span className="msg-side">
              <span className="msg-role">AGENT</span>
              <span className="msg-time">LIVE</span>
            </span>
            <div className="msg-body">
              <p>
                {props.streaming}
                <span className="stream-cursor">▌</span>
              </p>
            </div>
          </div>
        )}
      </div>
      <div className="cmd-input-row">
        <span className="cmd-prompt">▸</span>
        <input
          className="cmd-input"
          placeholder={`Message ${props.agent.name}…`}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void send();
          }}
        />
        <button className="fui-chip tone-accent" onClick={send} disabled={busy || !draft.trim()}>
          {busy ? "…" : "TRANSMIT ⏎"}
        </button>
      </div>
    </div>
  );
}

const fmtClock = (iso: string) => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t).toISOString().slice(11, 19) : "";
};

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
      <span className="msg-side">
        <span className="msg-role">{msg.role === "user" ? "YOU" : "AGENT"}</span>
        <span className="msg-time">{fmtClock(msg.createdAt)}</span>
      </span>
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
