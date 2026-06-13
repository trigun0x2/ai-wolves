// Types shared between the game engine, server, and web UI.

export type Role =
  | "villager"
  | "seer"
  | "robber"
  | "troublemaker"
  | "mason"
  | "drunk"
  | "insomniac"
  | "hunter"
  | "werewolf"
  | "minion"
  | "tanner"
  | "doppelganger";

export type Team = "village" | "werewolf" | "tanner";

export interface PublicPlayer {
  name: string;
  avatar: string;
  color: string;
  seat: number;
  isHuman: boolean;
}

export interface NightLogEntry {
  step: string; // e.g. "werewolf", "doppelganger → seer"
  player: string;
  summary: string;
}

/** A card position on the table. */
export type CardRef = { type: "player"; name: string } | { type: "center"; idx: number };

/** Structured night-action data so the UI can animate the card table. */
export type NightEffect =
  | { kind: "peek"; viewer: string; targets: CardRef[] }
  | { kind: "swap"; a: CardRef; b: CardRef };

export interface VoteRecord {
  voter: string;
  target: string; // player name or "no_one"
}

export interface RevealData {
  originalCards: Record<string, Role>;
  finalCards: Record<string, Role>;
  centerOriginal: Role[];
  centerFinal: Role[];
  doppelCopied: Role | null;
  nightLog: NightLogEntry[];
  votes: VoteRecord[];
  deaths: string[];
  winningTeams: Team[];
  winners: string[]; // player names that won
}

export type GamePhase = "lobby" | "night" | "day" | "vote" | "reveal";

export type GameEvent =
  | { type: "game_start"; gameId: string; players: PublicPlayer[]; roles: Role[] }
  | { type: "phase"; phase: GamePhase; round?: number; totalRounds?: number }
  | { type: "night_step"; role: Role }
  | { type: "typing"; player: string }
  | { type: "chat"; player: string; text: string; round: number }
  // Spoiler events (hidden from the spectator feed unless the GM panel is on):
  | { type: "deal"; cards: Record<string, Role>; center: Role[] }
  | {
      type: "night_action";
      player: string;
      step: string;
      summary: string;
      effect?: NightEffect;
    }
  // Vote sequence:
  | { type: "vote_countdown"; seconds: number }
  | { type: "votes"; votes: VoteRecord[]; deaths: string[] }
  | { type: "reveal"; data: RevealData };

export const SPOILER_EVENTS: ReadonlySet<GameEvent["type"]> = new Set([
  "deal",
  "night_action",
]);

// ---------- UI decision rendering (for the human seat) ----------

export interface UIOption {
  label: string;
  value: unknown; // the exact JSON object/value to submit
}

// ---------- WebSocket protocol ----------

export type Channel = "spectator" | "player";

export type ClientMessage =
  | { type: "hello"; channel: Channel; token?: string }
  | { type: "claim_seat"; name: string; avatar?: string }
  | { type: "input"; value: unknown } // chat text (string) or decision object
  | { type: "set_speed"; speed: number }; // pacing multiplier (1 = normal, 2 = 2× faster)

export interface LobbyState {
  running: boolean;
  playMode: boolean;
  humanClaimed: string | null; // claimed player name
  playerCount: number;
  spoilerDefault: boolean;
  /** When set, a game auto-starts at this epoch-ms (countdown driven by the queue). */
  countdownEndsAt: number | null;
  /** Whether operator endpoints require a token (OPERATOR_TOKEN is configured). */
  authRequired: boolean;
}

/** A bring-your-own agent waiting in the queue. Host-facing — never carries a key. */
export interface SubmissionPublic {
  id: string;
  name: string;
  avatar: string;
  color: string;
  provider: string;
  model: string;
  personaPreview: string;
}

/** One row of the persistent global leaderboard. */
export interface LeaderboardEntry {
  name: string;
  wins: number;
  games: number;
  lastModel?: string;
  lastPlayed: number;
}

export type ServerMessage =
  | { type: "event"; event: GameEvent; spoiler: boolean }
  | { type: "lobby"; lobby: LobbyState }
  | { type: "scoreboard"; entries: LeaderboardEntry[]; games: number }
  | { type: "private_info"; text: string }
  | {
      type: "your_turn";
      kind: "chat" | "decision";
      prompt: string;
      options?: UIOption[];
      timeoutMs: number;
    }
  | { type: "turn_over" }
  | { type: "claimed"; name: string }
  | { type: "speed"; speed: number }
  | { type: "submissions"; list: SubmissionPublic[] }
  | { type: "error"; message: string };
