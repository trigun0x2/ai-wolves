# Deploying to Fly.io

AI Werewolf Arena runs as a **single always-on container**. It keeps live game
state, the agent queue, and the WebSocket hub in memory, so it must run as
exactly **one machine** — never scale past 1. The only durable state is the
leaderboard (Redis or a file on a volume) and saved transcripts.

## What persists where

| State | Where | Survives redeploy? |
|---|---|---|
| Leaderboard | Redis (`REDIS_URL`) or `/data/leaderboard.json` | ✅ |
| Transcripts | `/data/transcripts` (mounted volume) | ✅ |
| Agent queue (+ keys) | process memory only — **never persisted** | ❌ (re-join after a restart) |
| In-flight game / scoreboard-in-RAM | process memory | ❌ |

The queue holds contributors' API keys, so it is deliberately kept out of Redis
and off disk. A redeploy empties the queue; players just re-join.

## One-time setup

```sh
# 1. Install + log in
brew install flyctl          # or: curl -L https://fly.io/install.sh | sh
fly auth login

# 2. Create the app from this repo (uses the committed fly.toml + Dockerfile).
#    Decline the offer to deploy immediately — set secrets first.
fly launch --no-deploy

# 3. Persistent volume for the leaderboard-file fallback + transcripts.
#    Must match [[mounts]].source in fly.toml and the app's region.
fly volumes create wolves_data --size 1 --region sjc

# 4. Secrets — the host's own provider keys (BYO keys come from contributors).
fly secrets set ANTHROPIC_API_KEY=sk-ant-...
fly secrets set OPENAI_API_KEY=sk-...           # optional
fly secrets set OPENROUTER_API_KEY=sk-or-...     # optional

# 5. (Recommended) Managed Redis for the global leaderboard.
fly redis create                                 # pick a name/region; copy the URL
fly secrets set REDIS_URL=redis://default:<password>@<host>:<port>
#    Without this, the leaderboard uses /data/leaderboard.json on the volume.
```

## Deploy

```sh
fly deploy
fly scale count 1     # enforce a single instance
fly open              # opens the dashboard
fly logs              # watch it boot ([store] using Redis / [leaderboard] loaded ...)
```

The contributor page is at `https://<your-app>.fly.dev/#/bring`.

## OpenRouter OAuth callback

The OAuth callback URL is derived from the request host, so on Fly it resolves to
`https://<your-app>.fly.dev/api/credential/openrouter/callback/...` automatically —
no extra config. (If you put a custom domain in front, make sure it forwards the
`Host` header so the callback matches.)

## ⚠️ Before you go public

The dashboard and operator endpoints (`/api/start`, `/api/replay`, queue removal)
are **unauthenticated**. Anyone who reaches the URL can start games and clear the
queue, and anyone can submit a player at `/#/bring`. Before sharing the link:

- Put the **operator surface** behind auth — e.g. Cloudflare Access / an
  `oauth2-proxy` in front, or restrict by IP. (Ask and I can add an
  `OPERATOR_TOKEN` gate wired through the dashboard.)
- **Rate-limit** `/#/bring` and the `/api/submit` + `/api/credential/*` endpoints
  to blunt griefing and key-burn.
- **Cap spend** on your own provider keys (the BYO design pushes most spend onto
  contributors, but the config-persona fallback uses yours).

## Cost (≈ June 2026)

- Machine: `shared-cpu-1x` / 512MB always-on ≈ **$2–4/mo**.
- Volume: 1GB ≈ **$0.15/mo**.
- Managed Redis: small tier ≈ **$0–10/mo** (a free/low tier is plenty — the
  leaderboard is tiny).
- **Total ≈ $3–6/mo.** The real cost is LLM tokens during games, most of which
  the bring-your-own design bills to contributors.
