import { useEffect, useReducer, useRef, useCallback } from "react";
import type {
  CardRef,
  Channel,
  ClientMessage,
  GameEvent,
  GamePhase,
  LobbyState,
  NightEffect,
  LeaderboardEntry,
  PublicPlayer,
  RevealData,
  Role,
  ServerMessage,
  SubmissionPublic,
  UIOption,
  VoteRecord,
} from "../shared/types";

/** Live card layout, maintained from spoiler events (display gated by the GM toggle). */
export interface TableModel {
  players: Record<string, Role | null>;
  center: (Role | null)[];
}

export interface TurnRequest {
  kind: "chat" | "decision";
  prompt: string;
  options?: UIOption[];
  timeoutMs: number;
  startedAt: number;
}

export interface UiState {
  connected: boolean;
  lobby: LobbyState | null;
  leaderboard: LeaderboardEntry[];
  games: number;
  players: PublicPlayer[];
  roles: Role[];
  phase: GamePhase;
  dayRound: number;
  totalRounds: number;
  nightStep: Role | null;
  typing: string | null;
  chat: { id: number; player: string; text: string; round: number }[];
  spoilers: { id: number; text: string }[];
  countdownAt: number | null; // timestamp when countdown started
  countdownSeconds: number;
  votes: VoteRecord[] | null;
  deaths: string[];
  reveal: RevealData | null;
  speed: number;
  table: TableModel;
  effect: (NightEffect & { id: number }) | null; // current night animation
  submissions: SubmissionPublic[];
  // player-seat extras
  claimedName: string | null;
  privateLog: { id: number; text: string }[];
  turn: TurnRequest | null;
  error: string | null;
}

const initial: UiState = {
  connected: false,
  lobby: null,
  leaderboard: [],
  games: 0,
  players: [],
  roles: [],
  phase: "lobby",
  dayRound: 1,
  totalRounds: 3,
  nightStep: null,
  typing: null,
  chat: [],
  spoilers: [],
  countdownAt: null,
  countdownSeconds: 5,
  votes: null,
  deaths: [],
  reveal: null,
  speed: 1,
  table: { players: {}, center: [null, null, null] },
  effect: null,
  submissions: [],
  claimedName: null,
  privateLog: [],
  turn: null,
  error: null,
};

let nextId = 1;

type Action = { type: "msg"; msg: ServerMessage } | { type: "conn"; up: boolean };

function getCard(t: TableModel, ref: CardRef): Role | null {
  return ref.type === "player" ? (t.players[ref.name] ?? null) : t.center[ref.idx];
}

function setCard(t: TableModel, ref: CardRef, role: Role | null): void {
  if (ref.type === "player") t.players[ref.name] = role;
  else t.center[ref.idx] = role;
}

function applyEffect(table: TableModel, effect: NightEffect): TableModel {
  if (effect.kind !== "swap") return table;
  const next: TableModel = { players: { ...table.players }, center: [...table.center] };
  const a = getCard(next, effect.a);
  const b = getCard(next, effect.b);
  setCard(next, effect.a, b);
  setCard(next, effect.b, a);
  return next;
}

function onEvent(state: UiState, ev: GameEvent): UiState {
  switch (ev.type) {
    case "game_start":
      return {
        ...state,
        players: ev.players,
        roles: ev.roles,
        phase: "night",
        chat: [],
        spoilers: [],
        votes: null,
        deaths: [],
        reveal: null,
        nightStep: null,
        typing: null,
        countdownAt: null,
        privateLog: [],
        error: null,
        effect: null,
        table: {
          players: Object.fromEntries(ev.players.map((p) => [p.name, null])),
          center: [null, null, null],
        },
      };
    case "phase":
      return {
        ...state,
        phase: ev.phase,
        dayRound: ev.round ?? state.dayRound,
        totalRounds: ev.totalRounds ?? state.totalRounds,
        typing: ev.phase === "day" ? state.typing : null,
        nightStep: ev.phase === "night" ? state.nightStep : null,
        effect: ev.phase === "night" ? state.effect : null,
      };
    case "night_step":
      return { ...state, nightStep: ev.role, effect: null };
    case "typing":
      return { ...state, typing: ev.player };
    case "chat":
      return {
        ...state,
        typing: state.typing === ev.player ? null : state.typing,
        chat: [...state.chat, { id: nextId++, player: ev.player, text: ev.text, round: ev.round }],
      };
    case "deal": {
      const lines = [
        ...Object.entries(ev.cards).map(([p, r]) => `DEAL — ${p}: ${r.toUpperCase()}`),
        `DEAL — center: ${ev.center.map((r) => r.toUpperCase()).join(", ")}`,
      ];
      return {
        ...state,
        table: { players: { ...ev.cards }, center: [...ev.center] },
        spoilers: [...state.spoilers, ...lines.map((text) => ({ id: nextId++, text }))],
      };
    }
    case "night_action":
      return {
        ...state,
        table: ev.effect ? applyEffect(state.table, ev.effect) : state.table,
        effect: ev.effect ? { ...ev.effect, id: nextId++ } : state.effect,
        spoilers: [
          ...state.spoilers,
          { id: nextId++, text: `${ev.step.toUpperCase()} — ${ev.player} ${ev.summary}` },
        ],
      };
    case "vote_countdown":
      return { ...state, countdownAt: Date.now(), countdownSeconds: ev.seconds };
    case "votes":
      return { ...state, countdownAt: null, votes: ev.votes, deaths: ev.deaths };
    case "reveal":
      return { ...state, reveal: ev.data };
    default:
      return state;
  }
}

function reducer(state: UiState, action: Action): UiState {
  if (action.type === "conn") return { ...state, connected: action.up };
  const msg = action.msg;
  switch (msg.type) {
    case "event":
      return onEvent(state, msg.event);
    case "lobby":
      return { ...state, lobby: msg.lobby };
    case "scoreboard":
      return { ...state, leaderboard: msg.entries, games: msg.games };
    case "private_info":
      return {
        ...state,
        privateLog: [...state.privateLog, { id: nextId++, text: msg.text }],
      };
    case "your_turn":
      return {
        ...state,
        turn: {
          kind: msg.kind,
          prompt: msg.prompt,
          options: msg.options,
          timeoutMs: msg.timeoutMs,
          startedAt: Date.now(),
        },
      };
    case "turn_over":
      return { ...state, turn: null };
    case "claimed":
      return { ...state, claimedName: msg.name };
    case "speed":
      return { ...state, speed: msg.speed };
    case "submissions":
      return { ...state, submissions: msg.list };
    case "error":
      return { ...state, error: msg.message };
    default:
      return state;
  }
}

export function useGame(channel: Channel) {
  const [state, dispatch] = useReducer(reducer, initial);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    let closed = false;
    let retry: ReturnType<typeof setTimeout>;

    const connect = () => {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      const ws = new WebSocket(`${proto}://${location.host}/ws`);
      wsRef.current = ws;
      ws.onopen = () => {
        dispatch({ type: "conn", up: true });
        ws.send(JSON.stringify({ type: "hello", channel } satisfies ClientMessage));
      };
      ws.onmessage = (e) => {
        try {
          dispatch({ type: "msg", msg: JSON.parse(e.data) as ServerMessage });
        } catch {
          /* ignore */
        }
      };
      ws.onclose = () => {
        dispatch({ type: "conn", up: false });
        if (!closed) retry = setTimeout(connect, 1500);
      };
    };
    connect();
    return () => {
      closed = true;
      clearTimeout(retry);
      wsRef.current?.close();
    };
  }, [channel]);

  const send = useCallback((msg: ClientMessage) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  }, []);

  return { state, send };
}
