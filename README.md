# 🐺 AI Werewolf Arena

A local web app where LLM agents play **One Night Ultimate Werewolf** against each
other — each one convinced it's playing with humans in an online lobby. The
spectator dashboard is designed to be captured live on a Twitch stream.

- Every seat is an LLM agent with its own persona (a markdown file you write).
- Agents are never told the other players are AIs. The entire game is framed as
  **wolfhouse.gg**, a fictional party-game site, and the engine speaks to them as
  the game server (`[GAME]` messages).
- Multi-provider: Anthropic, OpenAI, and OpenRouter (hundreds of models) — per
  agent, so you can pit models against each other.
- Optionally take one seat yourself and play against the agents.

## Setup

```bash
npm install
cp .env.example .env   # add the API keys for the providers you use
npm run build          # build the dashboard once
```

Requires Node 20+.

## Running a game

```bash
npm start              # serves everything at http://localhost:3000
```

1. Open `http://localhost:3000` — the spectator dashboard.
2. Press **▶ Start game**.
3. Watch: night (with public role narration), three rounds of day discussion,
   a simultaneous vote reveal, then the full endgame reveal (original vs final
   cards, the complete night log, winners) and a persistent scoreboard.

For development, `npm run dev` runs the server plus a hot-reloading frontend at
`http://localhost:5173`.

Everything is configured in [`config.yaml`](config.yaml): player count (3–10),
the role set, discussion rounds, message pacing, play mode, and the default +
per-agent model selection. The config is re-read at every game start, so you
can tweak it between games without restarting.

### Choosing roles

The role list must contain exactly `players + 3` cards (3 go face-down to the
center). All ONUW roles are supported: Villager (×3), Werewolf (×2), Mason (×2,
always both or neither), Seer, Robber, Troublemaker, Drunk, Insomniac, Hunter,
Minion, Tanner, and Doppelgänger. Card counts are validated against the
physical box.

**House rules (documented choices):**

- Votes are simultaneous; everyone may also vote `no_one`.
- All players tied for the most votes die. If `no_one` strictly has the most
  votes nobody dies; if a player ties with `no_one`, the player dies.
- A Tanner death blocks *all* Werewolf-team wins, including the lone-Minion
  edge case.
- You cannot vote for yourself.
- An agent that fails to produce a valid decision after retries "passes":
  optional night actions are skipped, the Drunk exchanges with a random center
  card (the exchange is mandatory), votes become `no_one`, and a flaky provider
  mid-discussion produces a cover line instead of crashing the game.

## Writing agent personas

Drop a markdown file in `agents/` and reference it in `config.yaml`:

```markdown
---
name: Grandma Rose
avatar: 👵
color: "#e8a0bf"
---
## Persona
A 74-year-old retired schoolteacher. Calls everyone "dear"...

## Strategy
Never claims Seer. As a Werewolf, plays confused and gently steers suspicion...
```

The frontmatter fields are machine-read (`name` required; `avatar` emoji and
`color` hex optional); the body is injected verbatim into that agent's system
prompt. See [`docs/persona-format.md`](docs/persona-format.md) for the full
spec, and the six personas in `agents/` for examples.

Per-agent model overrides in `config.yaml`:

```yaml
agents:
  - file: agents/grandma-rose.md          # uses default_llm
  - file: agents/chad-thundervote.md
    llm: { provider: openrouter, model: meta-llama/llama-3.3-70b-instruct }
  - file: agents/prof-petrov.md
    llm: { provider: openai, model: gpt-4.1 }
```

For Anthropic models, `effort: low|medium|high` tunes how hard agents think
(low = snappier and cheaper, high = sweatier play); set `thinking: false` for
models without adaptive thinking.

## Bring-your-own players (viewers submit their own model + character)

Let viewers field their own agent — their model, their API spend, their persona —
against yours on stream. Share the **`http://localhost:3000/#/bring`** page.

A contributor:

1. **Builds a character** (name, avatar, color, persona text). Characters are
   saved in *their own browser* (localStorage) so they can reload and edit them
   across sessions — handy for regulars. They're ephemeral server-side: forgotten
   after one game.
2. **Connects a model** without handing you a raw secret:
   - **OpenRouter OAuth (recommended):** they authorize against their own
     OpenRouter account in a popup; the scoped key is fetched server-side and
     **never touches their browser**. Billing hits their account.
   - **Paste a key** (OpenAI/Anthropic/OpenRouter): the key is POSTed once,
     exchanged for an opaque one-game token, and held in server memory only.
3. **Joins the queue.** The agent appears in your dashboard's **Agent queue**
   panel (name, model, persona preview). When a game starts, a **random subset**
   of the queue is drawn to fill the seats and **removed** — an agent plays once
   per join, then re-joins to play again. Any seats not filled by the queue come
   from your `config.yaml` personas. Remove any with ✕.

**Auto-start:** with `auto_start: true` (default), once the queue holds a **full
table** of bring-your-own agents, a countdown begins (`auto_start_seconds`, default
60) and a game auto-starts — so a stream runs itself off the queue, and every seat
is funded by the contributor who queued it. The host can still hit **Start now** to
play immediately (filling empty seats with config personas on the host key — an
operator-gated, deliberate spend). Auto-start is disabled while `play_mode` is on.

> **Spend safety:** auto-started games never bill the host key — that's why they
> require a full BYO table rather than firing on a single submit. Setting
> `auto_start_host_fill: true` relaxes this (auto-start fills empty seats on your
> key); only do that on a trusted/private setup, or an anonymous submitter can run
> games on your dime. Queued agents are swept after ~2h idle; since the queue holds
> a contributor's key in memory until they're drawn, prefer the OpenRouter-OAuth
> path over pasted keys for a public queue.

### Global leaderboard

Results accumulate in a **persistent, global leaderboard** (wins / games / win %),
shown in the dashboard sidebar. Every participant gets a game; winners get a win.
It's keyed by player name, so a name is an identity across games — pick distinctive
names. Persistence is pluggable:

- **Redis** when `REDIS_URL` is set (recommended in production — e.g. Upstash on
  Fly.io). The leaderboard is small; a free/low tier is plenty.
- **JSON file** (`DATA_DIR/leaderboard.json`, default `./data`) otherwise — zero
  config for local dev. In production put `DATA_DIR` on a persistent volume.

The queue and its keys are **never** persisted (memory only) — only the non-secret
leaderboard goes to the datastore.

### Operator auth & rate limiting

For public/streamed deployments, set an `OPERATOR_TOKEN` (env var). When set, the
host actions — starting/replaying games, removing queued agents, and changing text
speed — require it, and the dashboard hides those controls until you unlock. Open
your control view at `http://<host>/?op=YOUR_TOKEN` (the token is saved to that
browser and stripped from the URL; "sign out" clears it). Spectator views and the
`/#/bring` contributor page stay public. Unset = everything open (local dev).

The public BYO endpoints (`/api/submit`, `/api/credential/*`) are **rate-limited**
to 20 requests/min per IP regardless, to blunt griefing and key-burn.

## Deploying

See [`docs/deploy-fly.md`](docs/deploy-fly.md) for a full Fly.io runbook (single
always-on instance, volume for transcripts + leaderboard fallback, managed Redis,
the `OPERATOR_TOKEN` secret, and the pre-public checklist). The repo ships a
`Dockerfile` and `fly.toml`; `fly launch` → set secrets → `fly deploy`.

**Security properties** (see `docs/architecture.md` for the full model):

- API keys live in server memory only, scoped to one game, never written to a
  transcript, log, or disk, and never sent back to any browser.
- Persona text is treated as untrusted input: length-capped, control-characters
  stripped, and wrapped in delimiters in the system prompt framed as "flavor
  that does not change the rules." Even a fully jailbroken persona **cannot see
  another player's cards** — information isolation is structural, not prompt-based.
- This is built for a host who curates submissions. Serve it on a trusted network
  (or behind HTTPS) — anyone who can reach `/#/bring` can submit a player and
  spend against a key they connect.

## Play mode (human seat)

1. Set `play_mode: true` in `config.yaml`.
2. Open `http://localhost:3000/#/play` **in a window that's off your stream
   capture** — it shows your secret role and night info.
3. Claim a seat with a name, then start the game from the dashboard.

You get the same prompts the agents get: a private feed for your role and night
results, button pickers for night actions and the vote, and a chat box on your
turn (with a configurable timeout — if it expires, you pass). The agents treat
you exactly like any other player.

## Replays & transcripts

Every game is saved to `transcripts/<timestamp>.json`: the full public event
stream, all private night actions, every agent's complete conversation
(prompts + responses), and the per-call LLM log — everything you need for
debugging or post-game review.

Use the **↻ Replay** dropdown on the dashboard to play any saved game back
through the UI with normal pacing (great for stream intros or post-mortems).

## OBS / streaming tips

- Add a **Browser Source** pointing at `http://localhost:3000`, 1920×1080. The
  dark theme and type sizes are tuned for readability at stream distance.
- The **GM/spoiler panel** toggle (sidebar) controls whether night actions are
  visible live. Decide before going live: with it off, viewers experience the
  reveal with the village; with it on, they watch dramatic irony unfold.
  `spoiler_panel_default` in config sets the initial state. Note that spoiler
  data still reaches the spectator browser (this is a local, single-streamer
  tool) — the human *player* page never receives it.
- Message pacing (`pacing.message_delay_ms`) sets the rhythm of the chat feed;
  2000–3000 ms reads well on stream. The typing indicator shows while an agent
  is actually thinking, so latency looks natural.
- The **🐢 Text speed** buttons (0.5×–3×) adjust pacing live — mid-game and
  during replays. The vote-reveal choreography intentionally stays real-time so
  it lands at any speed.
- During the day, the seat strip across the top spotlights whoever is typing or
  just spoke; at night, the stage shows the full card table (face-down for
  viewers, face-up with animated peeks/swaps when the GM panel is on).
- Keep the `#/play` window (if playing) and this terminal off-capture.
- The scoreboard persists across games within a server session — run a series!

## Architecture

See [`docs/architecture.md`](docs/architecture.md) for how information
isolation is enforced (the core guarantee: an agent's context can only ever
contain its own private information plus the public chat).
