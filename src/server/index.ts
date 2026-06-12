import "dotenv/config";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import express from "express";
import { WebSocketServer } from "ws";
import type { ClientMessage, GameEvent, LobbyState, PublicPlayer } from "../shared/types";
import { loadConfig, type GameConfig } from "../engine/config";
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

const PORT = Number(process.env.PORT ?? 3000);
const ROOT = process.cwd();
const CONFIG_PATH = path.join(ROOT, "config.yaml");
const TRANSCRIPTS_DIR = path.join(ROOT, "transcripts");

const hub = new Hub();

// ---------------- Server state ----------------
let running = false;
let replaying = false;
let humanClaim: { name: string; avatar: string } | null = null;
let activeHuman: HumanController | null = null;
let speed = 1; // live pacing multiplier, set from the dashboard
const scoreboard: Record<string, number> = {};
let gamesPlayed = 0;

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
  };
}

function broadcastLobby(): void {
  hub.broadcast({ type: "lobby", lobby: lobbyState() });
}

function broadcastScoreboard(): void {
  hub.broadcast({ type: "scoreboard", tally: scoreboard, games: gamesPlayed });
}

// ---------------- Game lifecycle ----------------

async function startGame(): Promise<void> {
  const config = loadConfig(CONFIG_PATH);
  if (config.play_mode && !humanClaim) {
    throw new Error("play_mode is on — waiting for the human to claim a seat at /play");
  }

  const agentSeats = config.players - (config.play_mode ? 1 : 0);
  const personaEntries = config.agents.slice(0, agentSeats).map((entry, i) => ({
    entry,
    persona: loadPersona(path.join(ROOT, entry.file), i),
  }));

  // Guard against the human reusing an agent name (names are identity).
  if (humanClaim && personaEntries.some((p) => p.persona.name === humanClaim!.name)) {
    throw new Error(`Seat name "${humanClaim.name}" collides with an agent persona`);
  }

  // Seat order is shuffled so the human isn't always in the same position.
  type SeatDef =
    | { kind: "agent"; persona: Persona; llm: GameConfig["default_llm"] }
    | { kind: "human"; name: string; avatar: string };
  const seatDefs: SeatDef[] = personaEntries.map(({ entry, persona }) => ({
    kind: "agent" as const,
    persona,
    llm: { ...config.default_llm, ...entry.llm },
  }));
  if (config.play_mode && humanClaim) {
    seatDefs.push({ kind: "human", name: humanClaim.name, avatar: humanClaim.avatar });
  }
  const seated = shuffle(seatDefs, Math.random);

  const gameId = new Date().toISOString().replace(/[:.]/g, "-");
  const llmLog: LLMCallLog[] = [];
  const events: TranscriptEventEntry[] = [];
  const allNames = seated.map((s) => (s.kind === "agent" ? s.persona.name : s.name));

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
      (entry) => llmLog.push(entry),
    );
    sessions.push(session);
    return session;
  });

  const emit = async (ev: GameEvent) => {
    events.push({ t: Date.now(), ev });
    hub.broadcastEvent(ev);
    await paceFor(ev, config.pacing.message_delay_ms, speed);
  };

  running = true;
  broadcastLobby();
  console.log(`[game] starting ${gameId} with ${controllers.length} players`);
  try {
    const game = new Game({ config, controllers, emit, gameId });
    const reveal = await game.run();

    for (const w of reveal.winners) scoreboard[w] = (scoreboard[w] ?? 0) + 1;
    for (const c of controllers) scoreboard[c.name] ??= 0;
    gamesPlayed++;
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
  }
}

// ---------------- HTTP ----------------

const app = express();
app.use(express.json());

app.get("/api/state", (_req, res) => {
  res.json({ lobby: lobbyState(), scoreboard, games: gamesPlayed });
});

app.get("/api/transcripts", (_req, res) => {
  res.json({ files: listTranscripts(TRANSCRIPTS_DIR) });
});

app.post("/api/start", (_req, res) => {
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

app.post("/api/replay", (req, res) => {
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
  runReplay(TRANSCRIPTS_DIR, file, hub, delay, () => speed)
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
  hub.send(ws, { type: "lobby", lobby: lobbyState() });
  hub.send(ws, { type: "scoreboard", tally: scoreboard, games: gamesPlayed });
  hub.send(ws, { type: "speed", speed });

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

server.listen(PORT, () => {
  console.log(`AI Werewolf Arena → http://localhost:${PORT}  (ws: /ws)`);
  if (!fs.existsSync(dist)) {
    console.log("Dev mode: open http://localhost:5173 (run `npm run dev`)");
  }
});
