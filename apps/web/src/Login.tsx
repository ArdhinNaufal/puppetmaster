import { useEffect, useState, type FormEvent } from "react";
import { Decode, Panel } from "@puppetmaster/ui";
import { authApi } from "./api.js";

/**
 * Unauthenticated gate with a cinematic boot sequence (DESIGN-LANGUAGE §5:
 * staged reveal, one-shot, ~1.3s; instant under reduced motion). Every boot
 * readout is real: the gateway link check, the auth mode, SSO availability.
 * First boot shows the founding-owner setup form, afterwards sign-in.
 */
export function Login(props: { onAuthed: () => void }) {
  const [needsSetup, setNeedsSetup] = useState<boolean | null>(null);
  const [gateway, setGateway] = useState<"probing" | "ok" | "fail">("probing");
  const [oidcEnabled, setOidcEnabled] = useState(false);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    authApi
      .status()
      .then((s) => {
        setGateway("ok");
        setNeedsSetup(s.needsSetup);
        setOidcEnabled(s.oidcEnabled);
      })
      .catch(() => {
        setGateway("fail");
        setNeedsSetup(false);
      });
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (needsSetup) await authApi.setup({ email, name, password });
      else await authApi.login(email, password);
      props.onAuthed();
    } catch (err) {
      setError(err instanceof Error ? err.message : "sign-in failed");
    } finally {
      setBusy(false);
    }
  };

  if (needsSetup === null) {
    return (
      <div className="login-screen">
        <div className="login-box boot">
          <BootMark />
          <ul className="boot-checks">
            <li className="boot-check">
              <span>LINK // GATEWAY</span>
              <span className="bc-val">PROBING…</span>
            </li>
          </ul>
        </div>
      </div>
    );
  }

  return (
    <div className="login-screen">
      <div className="login-box boot">
        <BootMark />
        <ul className="boot-checks">
          <li className="boot-check">
            <span>LINK // GATEWAY</span>
            <span className={`bc-val ${gateway === "ok" ? "ok" : "err"}`}>
              {gateway === "ok" ? "ESTABLISHED" : "UNREACHABLE"}
            </span>
          </li>
          <li className="boot-check">
            <span>MODE // ACCESS</span>
            <span className={`bc-val ${needsSetup ? "warn" : ""}`}>
              {needsSetup ? "FIRST RUN — NO OPERATORS" : "OPERATOR SIGN-IN"}
            </span>
          </li>
          <li className="boot-check">
            <span>AUTH // SSO</span>
            <span className="bc-val">{oidcEnabled ? "AVAILABLE" : "—"}</span>
          </li>
        </ul>
        <div className="login-panel">
          <Panel title={needsSetup ? "FIRST RUN · CREATE OWNER" : "OPERATOR SIGN-IN"}>
            <form className="login-form" onSubmit={submit}>
              {needsSetup && (
                <p className="dim">
                  No accounts exist yet. This account becomes the workspace <b>owner</b>.
                </p>
              )}
              {needsSetup && (
                <label className="ins-field">
                  <span>Name</span>
                  <input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />
                </label>
              )}
              <label className="ins-field">
                <span>Email</span>
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  autoComplete="username"
                />
              </label>
              <label className="ins-field">
                <span>Password{needsSetup ? " (8+ characters)" : ""}</span>
                <input
                  type="password"
                  required
                  minLength={needsSetup ? 8 : undefined}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete={needsSetup ? "new-password" : "current-password"}
                />
              </label>
              {error && <p className="login-error">▲ {error}</p>}
              <button className="fui-chip tone-accent login-submit" disabled={busy} type="submit">
                {busy ? "…" : needsSetup ? "INITIALIZE WORKSPACE" : "AUTHENTICATE"}
              </button>
              {oidcEnabled && (
                <>
                  <div className="login-or">— OR —</div>
                  <a className="fui-chip login-sso" href="/api/auth/oidc/login">
                    SIGN IN WITH SSO
                  </a>
                </>
              )}
            </form>
          </Panel>
        </div>
      </div>
    </div>
  );
}

/** Wordmark + segmented ring; the arc draws on during boot (one-shot). */
function BootMark() {
  const size = 76;
  const c = size / 2;
  const r = 30;
  const ticks = Array.from({ length: 12 }, (_, i) => {
    const a = (i * 30 * Math.PI) / 180;
    return (
      <line
        key={i}
        className="ring-tick"
        x1={c + (r - 5) * Math.cos(a)}
        y1={c + (r - 5) * Math.sin(a)}
        x2={c + (r - 8) * Math.cos(a)}
        y2={c + (r - 8) * Math.sin(a)}
      />
    );
  });
  return (
    <div className="boot-mark">
      <svg className="boot-ring" viewBox={`0 0 ${size} ${size}`} width={size} height={size} aria-hidden="true">
        <circle className="ring-track" cx={c} cy={c} r={r} />
        <circle className="ring-arc" cx={c} cy={c} r={r} transform={`rotate(-90 ${c} ${c})`} />
        {ticks}
        <circle className="ring-core" cx={c} cy={c} r={2} />
      </svg>
      <div className="login-brand">
        <Decode text="PUPPETMASTER" />
      </div>
      <span className="boot-sub">AGENT OPERATIONS CONSOLE</span>
    </div>
  );
}
