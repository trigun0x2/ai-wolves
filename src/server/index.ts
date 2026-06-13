import "dotenv/config";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import express from "express";
import { WebSocketServer } from "ws";
import type { ClientMessage, GameEvent, LobbyState, PublicPlayer } from "../shared/types";
import { loadConfig, type GameConfig, type LLMConfig, type ProviderName } from "../engine/config";
import { Game } from "../engine/game";
import { shuffle } from "../engine/util";
import { loadPersona, type Persona } from "../agents/personas";
import { buildSystemPrompt } from "../agents/prompts";
import { AgentSession, type LLMCallLog } from "../agents/session";
import { createProvider } from "../llm/provider";
import type { PlayerController } from "../engine/controller";
import { Hub } from "./sockets";
import { HumanController } from "./human";
import { paceFor } from "./pacing";
import { listTranscripts, runReplay, type TranscriptEventEntry } from "./replay";
import { ByoStore } from "./byo";
import { Leaderboard } from "./leaderboard";
import { createStore } from "./store";
import { createBus } from "./bus";
import { createApiProxy } from "./proxy";
import { validateSubmittedPersona, LIMITS } from "./validation";
import { requireOperator, rateLimit, isOperator, withinWindowCount } from "./middleware";
import { looksLikeBillingError } from "../llm/errors";

const PORT = Number(process.env.PORT ?? 3000);
const ROOT = process.cwd();
// Operator auth: when set, start/replay/queue-removal/speed require this token.
// Unset → auth disabled (open) for local dev.
const OPERATOR_TOKEN = process.env.OPERATOR_TOKEN || undefined;

// Role: "primary" runs the game loop + control plane (default). "gateway" serves
// the UI + spectator WebSockets and proxies /api/* to the primary. On Fly the role
// auto-detects from the process group; locally it's the default primary.
const ROLE: "primary" | "gateway" =
  (process.env.ROLE || process.env.FLY_PROCESS_GROUP) === "gateway" ? "gateway" : "primary";
const PRIMARY_URL = process.env.PRIMARY_URL || "http://localhost:3000";
const CONFIG_PATH = path.join(ROOT, "config.yaml");
// Configurable so production can point it at a mounted volume (e.g. /data/transcripts).
const TRANSCRIPTS_DIR = process.env.TRANSCRIPTS_DIR || path.join(ROOT, "transcripts");

// Assigned in the async bootstrap (needs the bus). Used only at runtime.
let hub!: Hub;
let bus!: import("./bus").Bus;
// Current game's events, so a mid-game connection can be caught up (primary only).
let liveEvents: GameEvent[] = [];

// ---------------- Server state ----------------
let running = false;
let replaying = false;
let humanClaim: { name: string; avatar: string } | null = null;
let activeHuman: HumanController | null = null;
let speed = 1; // live pacing multiplier, set from the dashboard

// Persistent global leaderboard (Redis in prod, JSON file in dev). Assigned in
// the async bootstrap below before the server starts listening.
let leaderboard!: Leaderboard;

// Auto-start countdown state.
let autoStartTimer: ReturnType<typeof setTimeout> | null = null;
let countdownEndsAt: number | null = null;

// Start times of host-funded games (rolling 1h window) for the spend cap.
const HOUR_MS = 60 * 60 * 1000;
const hostGameStarts: number[] = [];

// Bring-your-own players (in-memory; keys never persisted or logged).
const byo = new ByoStore();
const MAX_SUBMISSIONS = 10;
setInterval(() => byo.sweep(), 60_000).unref();

function broadcastSubmissions(): void {
  hub.broadcast({ type: "submissions", list: byo.listPublic() });
}

// ---- auto-start countdown ----
// While ≥1 external agent is queued and nothing is running, count down and then
// auto-start a game. Skipped in play_mode (a human seat needs a manual start).

/** Queued agents needed to auto-start: a full BYO table, unless host-fill is opted in. */
function autoStartMinQueue(cfg: GameConfig): number {
  return cfg.auto_start_host_fill ? 1 : cfg.players;
}

function maybeScheduleAutoStart(): void {
  const cfg = safeLoadConfig();
  if (!cfg?.auto_start || cfg.play_mode) return;
  if (running || replaying || autoStartTimer) return;
  if (byo.count() < autoStartMinQueue(cfg)) return;
  const secs = Math.max(5, cfg.auto_start_seconds);
  countdownEndsAt = Date.now() + secs * 1000;
  autoStartTimer = setTimeout(fireAutoStart, secs * 1000);
  console.log(`[auto] game auto-starts in ${secs}s (${byo.count()} queued)`);
  broadcastLobby();
}

function cancelAutoStart(): void {
  if (autoStartTimer) clearTimeout(autoStartTimer);
  autoStartTimer = null;
  if (countdownEndsAt !== null) {
    countdownEndsAt = null;
    broadcastLobby();
  }
}

function fireAutoStart(): void {
  autoStartTimer = null;
  countdownEndsAt = null;
  const cfg = safeLoadConfig();
  // Re-check the queue at fire time (an agent may have been removed during the
  // countdown) so we never auto-start an under-filled, host-funded game.
  if (running || replaying || !cfg || byo.count() < autoStartMinQueue(cfg)) {
    broadcastLobby();
    return;
  }
  startGame({ autoStarted: true }).catch((err) => {
    console.error("[auto] start failed:", err);
    hub.broadcast({ type: "error", message: String(err) });
  });
}

function safeLoadConfig(): GameConfig | null {
  try {
    return loadConfig(CONFIG_PATH);
  } catch (err) {
    console.error(String(err));
    return null;
  }
}

function lobbyState(): LobbyState {
  const cfg = safeLoadConfig();
  return {
    running: running || replaying,
    playMode: cfg?.play_mode ?? false,
    humanClaimed: humanClaim?.name ?? null,
    playerCount: cfg?.players ?? 0,
    spoilerDefault: cfg?.spoiler_panel_default ?? false,
    countdownEndsAt,
    authRequired: !!OPERATOR_TOKEN,
  };
}

function broadcastLobby(): void {
  hub.broadcast({ type: "lobby", lobby: lobbyState() });
}

function broadcastScoreboard(): void {
  hub.broadcast({ type: "scoreboard", entries: leaderboard.list(), games: leaderboard.games() });
}

// ---------------- Game lifecycle ----------------

async function startGame(opts: { autoStarted?: boolean } = {}): Promise<void> {
  cancelAutoStart(); // a game is starting — clear any pending countdown
  const config = loadConfig(CONFIG_PATH);
  if (config.play_mode && !humanClaim) {
    throw new Error("play_mode is on — waiting for the human to claim a seat at /play");
  }

  const agentSeats = config.players - (config.play_mode ? 1 : 0);

  // A random subset of the queued agents is drawn (each with its own model + key);
  // they're removed from the queue. Empty seats may be filled from config personas
  // on the HOST's key — but only for manual (operator) starts, or when host-fill
  // is explicitly enabled. An auto-started game never spends the host key, so an
  // anonymous submitter can't trigger games billed to you.
  const allowHostFill = !opts.autoStarted || config.auto_start_host_fill;
  // A host-funded game seats config personas on the host key (queue can't fill
  // every seat). Cap those per rolling hour so spend is bounded. Checked BEFORE
  // drawing so a refusal doesn't consume the queue.
  const hostFunded = allowHostFill && byo.count() < agentSeats;
  if (hostFunded && withinWindowCount(hostGameStarts, Date.now(), HOUR_MS) >= config.host_game_hourly_cap) {
    throw new Error(
      `hourly host-funded game cap reached (${config.host_game_hourly_cap}/h) — queue bring-your-own agents or wait`,
    );
  }

  type AgentDef = { persona: Persona; llm: LLMConfig };
  const drawn = byo.draw(agentSeats); // removes them from the queue
  const submittedDefs: AgentDef[] = drawn.map((s) => ({ persona: s.persona, llm: s.llm }));
  if (drawn.length) broadcastSubmissions(); // queue shrank — update the dashboard

  const usedNames = new Set(submittedDefs.map((d) => d.persona.name));
  const fillNeeded = allowHostFill ? Math.max(0, agentSeats - submittedDefs.length) : 0;
  const configPool: AgentDef[] = config.agents
    .map((entry, i) => ({
      persona: loadPersona(path.join(ROOT, entry.file), i),
      llm: { ...config.default_llm, ...entry.llm } as LLMConfig,
    }))
    .filter((d) => !usedNames.has(d.persona.name)); // don't double a name a submission took
  const agentDefs = [...submittedDefs, ...configPool.slice(0, fillNeeded)];

  if (agentDefs.length < agentSeats) {
    throw new Error(
      opts.autoStarted
        ? `auto-start needs ${agentSeats} queued agents (have ${agentDefs.length}); host-key fill is disabled`
        : `need ${agentSeats} players but only ${agentDefs.length} available — add submissions or more personas to config.yaml`,
    );
  }
  // Guard against the human reusing an agent name (names are identity).
  if (humanClaim && agentDefs.some((d) => d.persona.name === humanClaim!.name)) {
    throw new Error(`Seat name "${humanClaim.name}" collides with a player name`);
  }

  // Seat order is shuffled so the human isn't always in the same position.
  type SeatDef =
    | { kind: "agent"; persona: Persona; llm: LLMConfig }
    | { kind: "human"; name: string; avatar: string };
  const seatDefs: SeatDef[] = agentDefs.map((d) => ({ kind: "agent" as const, ...d }));
  if (config.play_mode && humanClaim) {
    seatDefs.push({ kind: "human", name: humanClaim.name, avatar: humanClaim.avatar });
  }
  const seated = shuffle(seatDefs, Math.random);

  // Participants for the leaderboard (model label for the "Claude vs GPT" view).
  const participants = seated.map((s) =>
    s.kind === "agent"
      ? { name: s.persona.name, model: `${s.llm.provider}:${s.llm.model}` }
      : { name: s.name },
  );

  const gameId = new Date().toISOString().replace(/[:.]/g, "-");
  const llmLog: LLMCallLog[] = [];
  const events: TranscriptEventEntry[] = [];
  const allNames = seated.map((s) => (s.kind === "agent" ? s.persona.name : s.name));

  // Warn (once per scope, per game) when an agent's API key looks out of credits.
  // Host-funded seats (no per-seat key → host's env key) get an urgent warning.
  const warned = new Set<string>();
  const onAgentLog =
    (agentName: string, hostKey: boolean) => (entry: LLMCallLog) => {
      llmLog.push(entry);
      if (!entry.error || !looksLikeBillingError(entry.error)) return;
      const scope = hostKey ? "host" : `byo:${agentName}`;
      if (warned.has(scope)) return;
      warned.add(scope);
      const text = hostKey
        ? `⚠️ The HOST API key looks out of credits/tokens — agents are failing (e.g. ${agentName}). Top up to keep games running.`
        : `⚠️ ${agentName}'s API key looks out of credits — that seat is passing this game.`;
      console.warn("[billing]", text);
      hub.broadcast({ type: "notice", level: "billing", text });
    };

  const sessions: AgentSession[] = [];
  const controllers: PlayerController[] = seated.map((s, seat) => {
    if (s.kind === "human") {
      const profile: PublicPlayer = {
        name: s.name,
        avatar: s.avatar,
        color: "#facc15",
        seat,
        isHuman: true,
      };
      activeHuman = new HumanController(profile, config.human_turn_timeout_ms, (msg) =>
        hub.toPlayers(msg),
      );
      return activeHuman;
    }
    const profile: PublicPlayer = {
      name: s.persona.name,
      avatar: s.persona.avatar,
      color: s.persona.color,
      seat,
      isHuman: false,
    };
    const others = allNames.filter((n) => n !== s.persona.name);
    const session = new AgentSession(
      profile,
      buildSystemPrompt(s.persona, others, config),
      createProvider(s.llm),
      onAgentLog(s.persona.name, !s.llm.apiKey), // no per-seat key → host's env key
    );
    sessions.push(session);
    return session;
  });

  const emit = async (ev: GameEvent) => {
    events.push({ t: Date.now(), ev });
    if (ev.type === "game_start") liveEvents = []; // fresh game — drop the prior log
    liveEvents.push(ev);
    bus.setSnapshot(liveEvents); // keep the mid-game catch-up current
    hub.broadcastEvent(ev);
    await paceFor(ev, config.pacing.message_delay_ms, speed);
  };

  if (hostFunded) hostGameStarts.push(Date.now()); // count toward the hourly cap
  running = true;
  broadcastLobby();
  console.log(
    `[game] starting ${gameId} with ${controllers.length} players` +
      (hostFunded ? ` (host-funded — ${withinWindowCount(hostGameStarts, Date.now(), HOUR_MS)}/${config.host_game_hourly_cap} this hour)` : ""),
  );
  try {
    const game = new Game({ config, controllers, emit, gameId });
    const reveal = await game.run();

    await leaderboard.record(participants, reveal.winners);
    broadcastScoreboard();

    fs.mkdirSync(TRANSCRIPTS_DIR, { recursive: true });
    const transcript = {
      id: gameId,
      startedAt: events[0]?.t ?? Date.now(),
      config,
      players: controllers.map((c) => c.profile),
      reveal,
      events,
      llmLog,
      conversations: Object.fromEntries(
        sessions.map((s) => [s.name, s.getConversation()]),
      ),
    };
    fs.writeFileSync(
      path.join(TRANSCRIPTS_DIR, `${gameId}.json`),
      JSON.stringify(transcript, null, 2),
    );
    console.log(`[game] finished ${gameId} — winners: ${reveal.winners.join(", ") || "nobody"}`);
  } finally {
    running = false;
    activeHuman = null;
    broadcastLobby();
    maybeScheduleAutoStart(); // agents that joined during the game can trigger the next one
  }
}

// ---------------- HTTP ----------------

const app = express();
// Trust exactly one proxy hop (Fly's edge). `true` would trust a client-supplied
// X-Forwarded-For, letting attackers spoof IPs to evade the rate limiter.
app.set("trust proxy", 1);
app.use(express.json({ limit: "64kb" })); // bound request bodies (personas are small)

// Gateway: forward the whole control plane to the primary. Registered before the
// real /api routes so it shadows them on a gateway; on the primary it's absent
// and the real handlers run. (The primary owns the game loop, queue, and keys.)
if (ROLE === "gateway") {
  app.use("/api", createApiProxy(PRIMARY_URL));
}

// Operator guard for host-only endpoints; rate limiter for the public BYO endpoints.
const op = requireOperator(() => OPERATOR_TOKEN);
const byoLimit = rateLimit({ windowMs: 60_000, max: 20 });

app.get("/api/state", (_req, res) => {
  res.json({ lobby: lobbyState(), leaderboard: leaderboard.list(), games: leaderboard.games() });
});

/** Lightweight endpoint so the dashboard can verify its operator token. */
app.get("/api/operator/check", op, (_req, res) => {
  res.json({ ok: true });
});

app.get("/api/transcripts", (_req, res) => {
  res.json({ files: listTranscripts(TRANSCRIPTS_DIR) });
});

// ---------------- Bring-your-own player ----------------

const PROVIDERS: ProviderName[] = ["anthropic", "openai", "openrouter"];

function popupHtml(message: string): string {
  return `<!doctype html><meta charset="utf-8"><title>OpenRouter</title>
<body style="font-family:system-ui;background:#0b0e14;color:#e8ecf4;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center">
<div><p style="font-size:20px">${message}</p><p style="color:#8b95a8">You can close this window.</p></div>
<script>try{window.close()}catch(e){}</script></body>`;
}

/** Stash a raw pasted key, return an opaque ref (the browser never keeps the key). */
app.post("/api/credential/raw", byoLimit, (req, res) => {
  const provider = String(req.body?.provider ?? "") as ProviderName;
  const key = String(req.body?.key ?? "").trim();
  const model = req.body?.model ? String(req.body.model) : undefined;
  if (!PROVIDERS.includes(provider)) {
    res.status(400).json({ error: "unknown provider" });
    return;
  }
  if (!key) {
    res.status(400).json({ error: "key is required" });
    return;
  }
  res.json({ keyRef: byo.putRawKey(provider, key, model) });
});

/** Begin OpenRouter OAuth: returns the authorize URL + a keyRef to track it. */
app.post("/api/credential/openrouter/start", byoLimit, (req, res) => {
  const { keyRef, challenge } = byo.startOAuth();
  const origin = `${req.protocol}://${req.get("host")}`;
  const callback = `${origin}/api/credential/openrouter/callback/${keyRef}`;
  const authUrl =
    `https://openrouter.ai/auth?callback_url=${encodeURIComponent(callback)}` +
    `&code_challenge=${challenge}&code_challenge_method=S256`;
  res.json({ keyRef, authUrl });
});

/** OAuth redirect target: exchange the code for a user-scoped key, server-side. */
app.get("/api/credential/openrouter/callback/:keyRef", byoLimit, async (req, res) => {
  const keyRef = String(req.params.keyRef);
  const code = String(req.query.code ?? "");
  const verifier = byo.takeVerifier(keyRef); // one-shot — a replayed callback gets null
  if (!code || !verifier) {
    res.status(400).send(popupHtml("❌ Authorization failed."));
    return;
  }
  try {
    const r = await fetch("https://openrouter.ai/api/v1/auth/keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: "S256" }),
    });
    if (!r.ok) throw new Error(`exchange failed (${r.status})`);
    const data = (await r.json()) as { key?: string };
    if (!data.key) throw new Error("no key returned");
    byo.attachKey(keyRef, data.key); // key stays server-side — never sent to the browser
    res.send(popupHtml("✅ OpenRouter connected!"));
  } catch (err) {
    res.status(502).send(popupHtml(`❌ ${String(err instanceof Error ? err.message : err)}`));
  }
});

/** Poll whether a credential ref now holds a key (used after OAuth). */
app.get("/api/credential/status", (req, res) => {
  res.json({ connected: byo.isReady(String(req.query.keyRef ?? "")) });
});

app.get("/api/submissions", (_req, res) => {
  res.json({ list: byo.listPublic(), limits: LIMITS, max: MAX_SUBMISSIONS });
});

/** Submit a bring-your-own player: validated persona + a connected credential ref. */
app.post("/api/submit", byoLimit, (req, res) => {
  if (running) {
    res.status(409).json({ error: "a game is in progress — try again after it ends" });
    return;
  }
  if (byo.count() >= MAX_SUBMISSIONS) {
    res.status(409).json({ error: `submission limit reached (${MAX_SUBMISSIONS})` });
    return;
  }
  const b = req.body ?? {};
  const v = validateSubmittedPersona(b, byo.count());
  if (!v.ok) {
    res.status(400).json({ error: v.error });
    return;
  }
  if (byo.listPublic().some((s) => s.name.toLowerCase() === v.persona.name.toLowerCase())) {
    res.status(409).json({ error: `a player named "${v.persona.name}" is already submitted` });
    return;
  }
  try {
    const sub = byo.addSubmission(
      v.persona,
      String(b.keyRef ?? ""),
      String(b.model ?? ""),
      b.baseURL ? String(b.baseURL) : undefined,
    );
    broadcastSubmissions();
    maybeScheduleAutoStart(); // first external agent in the queue → begin countdown
    res.json({ id: sub.id });
  } catch (err) {
    res.status(400).json({ error: String(err instanceof Error ? err.message : err) });
  }
});

app.delete("/api/submit/:id", op, (req, res) => {
  if (running) {
    res.status(409).json({ error: "a game is in progress" });
    return;
  }
  byo.removeSubmission(String(req.params.id));
  broadcastSubmissions();
  if (byo.count() === 0) cancelAutoStart(); // queue emptied — stop the countdown
  res.json({ ok: true });
});

app.post("/api/start", op, (_req, res) => {
  if (running || replaying) {
    res.status(409).json({ error: "a game is already in progress" });
    return;
  }
  try {
    // Validate config + seat claim synchronously so errors reach the caller…
    const cfg = loadConfig(CONFIG_PATH);
    if (cfg.play_mode && !humanClaim) {
      res.status(409).json({ error: "waiting for the human to claim a seat at /play" });
      return;
    }
    // Surface the host-game cap immediately (a manual start always allows host fill).
    const agentSeats = cfg.players - (cfg.play_mode ? 1 : 0);
    const hostFunded = byo.count() < agentSeats;
    if (hostFunded && withinWindowCount(hostGameStarts, Date.now(), HOUR_MS) >= cfg.host_game_hourly_cap) {
      res.status(429).json({
        error: `hourly host-funded game cap reached (${cfg.host_game_hourly_cap}/h) — queue bring-your-own agents or wait`,
      });
      return;
    }
  } catch (err) {
    res.status(400).json({ error: String(err) });
    return;
  }
  // …then run the game in the background.
  startGame().catch((err) => {
    console.error("[game] failed:", err);
    hub.broadcast({ type: "error", message: String(err) });
  });
  res.status(202).json({ ok: true });
});

app.post("/api/replay", op, (req, res) => {
  if (running || replaying) {
    res.status(409).json({ error: "a game is already in progress" });
    return;
  }
  const file = String(req.body?.file ?? "");
  if (!file) {
    res.status(400).json({ error: "missing file" });
    return;
  }
  replaying = true;
  broadcastLobby();
  const delay = safeLoadConfig()?.pacing.message_delay_ms ?? 2500;
  runReplay(TRANSCRIPTS_DIR, file, hub, delay, () => speed, (evs) => bus.setSnapshot(evs))
    .catch((err) => hub.broadcast({ type: "error", message: String(err) }))
    .finally(() => {
      replaying = false;
      broadcastLobby();
    });
  res.status(202).json({ ok: true });
});

// Serve the built frontend if present (npm run build), else point at Vite.
const dist = path.join(ROOT, "web-dist");
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^\/(?!api|ws).*/, (_req, res) => res.sendFile(path.join(dist, "index.html")));
} else {
  app.get("/", (_req, res) =>
    res
      .status(200)
      .send(
        "Frontend not built. Run `npm run dev` and open http://localhost:5173, or `npm run build` first.",
      ),
  );
}

// ---------------- WebSocket ----------------

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (ws) => {
  const client = hub.add(ws);
  // Prime the new socket with current sticky state (lobby/scoreboard/speed/
  // submissions) from the bus-backed retained cache — works on any instance,
  // re-reading from the bus if this instance booted before the state existed.
  hub.primeAndSend(ws);

  ws.on("message", (data) => {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(String(data));
    } catch {
      return;
    }
    switch (msg.type) {
      case "hello": {
        hub.setChannel(client, msg.channel);
        hub.setOperator(client, isOperator(OPERATOR_TOKEN, msg.token));
        // Catch a mid-game connection up on the current game (channel-filtered).
        void hub.sendSnapshot(ws, msg.channel);
        if (msg.channel === "player" && humanClaim) {
          hub.send(ws, { type: "claimed", name: humanClaim.name });
        }
        break;
      }
      case "claim_seat": {
        const cfg = safeLoadConfig();
        if (!cfg?.play_mode) {
          hub.send(ws, { type: "error", message: "play_mode is off in config.yaml" });
          break;
        }
        if (running) {
          hub.send(ws, { type: "error", message: "a game is already running — wait for the next one" });
          break;
        }
        const name = msg.name.trim().slice(0, 20);
        if (!name) {
          hub.send(ws, { type: "error", message: "pick a name" });
          break;
        }
        humanClaim = { name, avatar: msg.avatar?.trim() || "🧑" };
        hub.setChannel(client, "player");
        hub.send(ws, { type: "claimed", name });
        broadcastLobby();
        break;
      }
      case "input": {
        activeHuman?.handleInput(msg.value);
        break;
      }
      case "set_speed": {
        if (!client.operator) {
          hub.send(ws, { type: "error", message: "operator token required" });
          break;
        }
        const v = Number(msg.speed);
        if (Number.isFinite(v)) {
          speed = Math.min(4, Math.max(0.25, v));
          hub.broadcast({ type: "speed", speed });
        }
        break;
      }
    }
  });
});

// Bootstrap: wire the bus + hub, connect the durable store, then listen.
bus = await createBus(process.env.REDIS_URL);
hub = new Hub(bus);
await hub.prime(); // load retained sticky state (e.g. a gateway joining mid-game)
leaderboard = new Leaderboard(await createStore());
await leaderboard.init();

// The primary owns game state — publish the initial sticky snapshot so the bus's
// retained cache is populated for every instance (and late-booting gateways).
if (ROLE === "primary") {
  broadcastLobby();
  broadcastScoreboard();
  hub.broadcast({ type: "speed", speed });
  broadcastSubmissions();
}

server.listen(PORT, () => {
  console.log(`AI Werewolf Arena [${ROLE}] → http://localhost:${PORT}  (ws: /ws, bus: ${bus.kind})`);
  if (ROLE === "gateway") console.log(`[gateway] proxying /api → ${PRIMARY_URL}`);
  if (OPERATOR_TOKEN) {
    console.log("[auth] operator token required for start/replay/queue-removal/speed");
  } else {
    console.warn("[auth] OPERATOR_TOKEN not set — operator endpoints are OPEN (fine for local dev)");
  }
  if (!fs.existsSync(dist)) {
    console.log("Dev mode: open http://localhost:5173 (run `npm run dev`)");
  }
});
