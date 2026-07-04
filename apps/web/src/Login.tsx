import { useEffect, useState, type FormEvent } from "react";
import { Panel } from "@puppetmaster/ui";
import { authApi } from "./api.js";

/**
 * Unauthenticated gate: first boot shows the founding-owner setup form,
 * afterwards the sign-in form (ARCHITECTURE.md §6 session auth).
 */
export function Login(props: { onAuthed: () => void }) {
  const [needsSetup, setNeedsSetup] = useState<boolean | null>(null);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    authApi
      .status()
      .then((s) => setNeedsSetup(s.needsSetup))
      .catch(() => setNeedsSetup(false));
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
    return <div className="login-screen"><p className="dim">CONNECTING…</p></div>;
  }

  return (
    <div className="login-screen">
      <div className="login-box">
        <div className="login-brand">PUPPETMASTER</div>
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
            <button className="chip accent login-submit" disabled={busy} type="submit">
              {busy ? "…" : needsSetup ? "INITIALIZE WORKSPACE" : "AUTHENTICATE"}
            </button>
          </form>
        </Panel>
      </div>
    </div>
  );
}
