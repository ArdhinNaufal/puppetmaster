import { useEffect, useState } from "react";

type Health = { ok: boolean; service: string; version: string };

export function App() {
  const [health, setHealth] = useState<Health | null>(null);

  useEffect(() => {
    fetch("/api/health")
      .then((r) => r.json())
      .then(setHealth)
      .catch(() => setHealth(null));
  }, []);

  return (
    <main className="shell">
      <header className="rail">
        <span className="brand">PUPPETMASTER</span>
        <span className={`status ${health?.ok ? "ok" : "down"}`}>
          {health?.ok ? `KERNEL ONLINE · v${health.version}` : "KERNEL OFFLINE"}
        </span>
      </header>
      <section className="panel">
        <h1>COMMAND</h1>
        <p>
          M0 skeleton. Command view, canvas, and mission feed land in M1–M4 —
          see <code>docs/ARCHITECTURE.md</code>.
        </p>
      </section>
    </main>
  );
}
