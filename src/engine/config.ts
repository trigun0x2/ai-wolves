import fs from "node:fs";
import yaml from "js-yaml";
import type { Role } from "../shared/types";
import { CARD_LIMITS } from "./roles";

export type ProviderName = "anthropic" | "openai" | "openrouter";

export interface LLMConfig {
  provider: ProviderName;
  model: string;
  /** Anthropic only: output_config.effort (low|medium|high|xhigh|max). Omit to use API default. */
  effort?: string;
  /** Anthropic only: send adaptive thinking (default true). Set false for models without it. */
  thinking?: boolean;
  /**
   * Per-agent API key (bring-your-own). When set, the provider builds a throwaway
   * client scoped to this agent instead of using the host's env credentials.
   * SECURITY: this is held in memory only — it must never be written to a
   * transcript, log, or disk. It is intentionally absent from config.yaml.
   */
  apiKey?: string;
  /** Custom OpenAI-compatible endpoint (e.g. a user-run proxy). */
  baseURL?: string;
}

export interface AgentEntry {
  file: string;
  llm?: Partial<LLMConfig>;
}

export interface GameConfig {
  players: number;
  roles: Role[];
  discussion: { rounds: number };
  pacing: { message_delay_ms: number; typing_indicator: boolean };
  spoiler_panel_default: boolean;
  play_mode: boolean;
  human_turn_timeout_ms: number;
  default_llm: LLMConfig;
  agents: AgentEntry[];
}

const ALL_ROLES = Object.keys(CARD_LIMITS) as Role[];

export function validateConfig(cfg: GameConfig): string[] {
  const errors: string[] = [];
  if (!Number.isInteger(cfg.players) || cfg.players < 3 || cfg.players > 10) {
    errors.push(`players must be an integer between 3 and 10 (got ${cfg.players})`);
  }
  if (!Array.isArray(cfg.roles)) {
    errors.push("roles must be a list");
    return errors;
  }
  if (cfg.roles.length !== cfg.players + 3) {
    errors.push(
      `roles must contain exactly players + 3 = ${cfg.players + 3} cards (got ${cfg.roles.length})`,
    );
  }
  const counts = new Map<Role, number>();
  for (const r of cfg.roles) {
    if (!ALL_ROLES.includes(r)) {
      errors.push(`unknown role "${r}"`);
      continue;
    }
    counts.set(r, (counts.get(r) ?? 0) + 1);
  }
  for (const [role, n] of counts) {
    if (n > CARD_LIMITS[role]) {
      errors.push(`too many ${role} cards: ${n} (the box has ${CARD_LIMITS[role]})`);
    }
  }
  const masons = counts.get("mason") ?? 0;
  if (masons === 1) errors.push("Masons come as a pair: include 0 or 2 mason cards");

  if (!cfg.discussion || !Number.isInteger(cfg.discussion.rounds) || cfg.discussion.rounds < 1) {
    errors.push("discussion.rounds must be a positive integer");
  }
  const agentSeats = cfg.players - (cfg.play_mode ? 1 : 0);
  if (!Array.isArray(cfg.agents) || cfg.agents.length < agentSeats) {
    errors.push(
      `need at least ${agentSeats} agent persona files for ${cfg.players} players` +
        (cfg.play_mode ? " (one seat is reserved for the human)" : ""),
    );
  }
  if (!cfg.default_llm?.provider || !cfg.default_llm?.model) {
    errors.push("default_llm must specify provider and model");
  }
  return errors;
}

export function loadConfig(path: string): GameConfig {
  const raw = yaml.load(fs.readFileSync(path, "utf8")) as Partial<GameConfig>;
  const cfg: GameConfig = {
    players: raw.players ?? 5,
    roles: raw.roles ?? [
      "werewolf",
      "werewolf",
      "seer",
      "robber",
      "troublemaker",
      "villager",
      "villager",
      "villager",
    ],
    discussion: { rounds: raw.discussion?.rounds ?? 3 },
    pacing: {
      message_delay_ms: raw.pacing?.message_delay_ms ?? 2500,
      typing_indicator: raw.pacing?.typing_indicator ?? true,
    },
    spoiler_panel_default: raw.spoiler_panel_default ?? false,
    play_mode: raw.play_mode ?? false,
    human_turn_timeout_ms: raw.human_turn_timeout_ms ?? 75_000,
    default_llm: raw.default_llm ?? { provider: "anthropic", model: "claude-opus-4-8" },
    agents: raw.agents ?? [],
  };
  const errors = validateConfig(cfg);
  if (errors.length) {
    throw new Error(`Invalid config (${path}):\n - ${errors.join("\n - ")}`);
  }
  return cfg;
}
