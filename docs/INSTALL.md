# Installing Puppetmaster locally

Two paths: **Docker Compose** (fastest, runs the API + its dependencies in containers) or
**manual dev setup** (runs Postgres/Redis in Docker but the server and web app on your
machine with hot reload — this is how the project is actually developed).

## Prerequisites

- **Node.js 22+**
- **pnpm 10+** (`corepack enable` will pick up the version pinned in `package.json`)
- **Docker** and **Docker Compose** (for Postgres + Redis; not required if you only want to
  poke at the code with the embedded PGlite database and no queue — see the note at the end)

## Option A — Docker Compose (API only)

This brings up Postgres (with pgvector), Redis, and the built server container.

```bash
git clone <this-repo-url> puppetmaster
cd puppetmaster
docker compose -f docker/docker-compose.yml up --build
```

- API: http://localhost:4000/api/health
- Postgres: `localhost:5432` (user/db `puppetmaster`, password `puppetmaster` unless you set
  `POSTGRES_PASSWORD` in your shell before running `up`)
- Redis: `localhost:6379`

The web app is **not** built into this compose stack yet — run it separately per Option B's
web step, pointed at this API (it proxies `/api` to `localhost:4000` by default, so no config
is needed if you leave the API on its default port).

To stop: `docker compose -f docker/docker-compose.yml down` (add `-v` to also drop the
Postgres volume).

## Option B — Manual dev setup (recommended for development)

### 1. Install dependencies

```bash
git clone <this-repo-url> puppetmaster
cd puppetmaster
corepack enable
pnpm install
```

### 2. Start Postgres + Redis

Use just the two dependency services from the compose file (skip building the server image):

```bash
docker compose -f docker/docker-compose.yml up postgres redis
```

Or point at any Postgres 14+ / Redis 6+ you already have running — pgvector isn't required
for M1, but the server will try to enable it (`CREATE EXTENSION vector`) and silently skips
that step if it's unavailable.

### 3. Configure environment

The server reads plain environment variables — no `.env` loader is wired up yet, so export
them in your shell or prefix the run command:

| Variable       | Default                | Notes                                                   |
|----------------|-------------------------|----------------------------------------------------------|
| `DATABASE_URL` | *(unset → PGlite)*      | `postgres://puppetmaster:puppetmaster@localhost:5432/puppetmaster` |
| `REDIS_URL`    | *(unset → in-memory bus)* | `redis://127.0.0.1:6379`                                |
| `PORT`         | `4000`                  | server HTTP port                                        |
| `HOST`         | `0.0.0.0`               |                                                          |

If you omit `DATABASE_URL` and `REDIS_URL`, the server falls back to an in-memory event bus
and an embedded PGlite database — handy for a quick look, but state doesn't persist across
restarts and cron triggers won't run (see the note at the end).

### 4. Build and run the server

```bash
pnpm build
DATABASE_URL=postgres://puppetmaster:puppetmaster@localhost:5432/puppetmaster \
REDIS_URL=redis://127.0.0.1:6379 \
node apps/server/dist/main.js
```

Or for hot reload during development:

```bash
DATABASE_URL=postgres://puppetmaster:puppetmaster@localhost:5432/puppetmaster \
REDIS_URL=redis://127.0.0.1:6379 \
pnpm --filter @puppetmaster/server dev
```

Check it's up: `curl localhost:4000/api/health` and `curl localhost:4000/api/bootstrap`.

### 5. Run the web app

In a second terminal:

```bash
pnpm --filter @puppetmaster/web dev
```

Open http://localhost:3000 — it proxies `/api` and the `/api/events` WebSocket to
`localhost:4000`.

## Verifying the install

1. Open the web app, click **SAMPLE** to create the bundled example workflow.
2. Click **▶ RUN** — the mission trace panel (right) should show each node turning green in
   order and then pause on the amber approval gate.
3. Click **APPROVE** in the Approvals panel (left) — the mission should finish
   `SUCCEEDED` with an output value.

## Notes

- **No `DATABASE_URL`/`REDIS_URL` set:** the server still runs, using an in-process PGlite
  database (data is lost on restart) and an in-memory event bus (single-process only, no
  cron scheduling). Fine for a quick local trial; not for anything you want to keep.
- **pgvector** is used for agent long-term memory starting in M2; it's already enabled in the
  schema migration but nothing reads/writes vectors yet.
- **Ports:** server `4000`, web dev server `3000`, Postgres `5432`, Redis `6379`. Change via
  the environment variables above (server) or `apps/web/vite.config.ts` (web dev server / proxy
  target).
