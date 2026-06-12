import { z } from "zod";
import type { DecisionSchema } from "../engine/controller";
import type { UIOption } from "../shared/types";
import { NO_ONE } from "../engine/vote";

function make<T>(hint: string, options: UIOption[], schema: z.ZodType<T>): DecisionSchema<T> {
  return {
    hint,
    options,
    parse(value: unknown): T | null {
      const r = schema.safeParse(value);
      return r.success ? r.data : null;
    },
  };
}

const centerIdx = z.union([z.literal(0), z.literal(1), z.literal(2)]);
const inSet = (names: string[]) =>
  z.string().refine((n) => names.includes(n), { message: "unknown player" });

const skip = z.object({ action: z.literal("skip") });

// ---- Doppelgänger: must copy another player ----
export type CopyDecision = { action: "copy"; target: string };
export function copySchema(others: string[]): DecisionSchema<CopyDecision> {
  return make(
    `e.g. {"action":"copy","target":"${others[0]}"}`,
    others.map((n) => ({ label: `Look at ${n}'s card`, value: { action: "copy", target: n } })),
    z.object({ action: z.literal("copy"), target: inSet(others) }),
  );
}

// ---- Lone werewolf: peek one center card or skip ----
export type LoneWolfDecision = { action: "peek_center"; card: 0 | 1 | 2 } | { action: "skip" };
export function loneWolfSchema(): DecisionSchema<LoneWolfDecision> {
  return make(
    `e.g. {"action":"peek_center","card":1} or {"action":"skip"}`,
    [
      ...[0, 1, 2].map((i) => ({
        label: `Peek center card ${i}`,
        value: { action: "peek_center", card: i },
      })),
      { label: "Don't look", value: { action: "skip" } },
    ],
    z.union([z.object({ action: z.literal("peek_center"), card: centerIdx }), skip]),
  );
}

// ---- Seer ----
export type SeerDecision =
  | { action: "peek_player"; target: string }
  | { action: "peek_center"; cards: [0 | 1 | 2, 0 | 1 | 2] }
  | { action: "skip" };
export function seerSchema(others: string[]): DecisionSchema<SeerDecision> {
  const pairs: [number, number][] = [
    [0, 1],
    [0, 2],
    [1, 2],
  ];
  return make(
    `e.g. {"action":"peek_player","target":"${others[0]}"} or {"action":"peek_center","cards":[0,2]} or {"action":"skip"}`,
    [
      ...others.map((n) => ({
        label: `Look at ${n}'s card`,
        value: { action: "peek_player", target: n },
      })),
      ...pairs.map(([a, b]) => ({
        label: `Look at center cards ${a} & ${b}`,
        value: { action: "peek_center", cards: [a, b] },
      })),
      { label: "Don't look", value: { action: "skip" } },
    ],
    z.union([
      z.object({ action: z.literal("peek_player"), target: inSet(others) }),
      z.object({
        action: z.literal("peek_center"),
        cards: z
          .tuple([centerIdx, centerIdx])
          .refine(([a, b]) => a !== b, { message: "pick two different cards" }),
      }),
      skip,
    ]) as z.ZodType<SeerDecision>,
  );
}

// ---- Robber ----
export type RobberDecision = { action: "rob"; target: string } | { action: "skip" };
export function robberSchema(others: string[]): DecisionSchema<RobberDecision> {
  return make(
    `e.g. {"action":"rob","target":"${others[0]}"} or {"action":"skip"}`,
    [
      ...others.map((n) => ({
        label: `Take ${n}'s card`,
        value: { action: "rob", target: n },
      })),
      { label: "Keep your card", value: { action: "skip" } },
    ],
    z.union([z.object({ action: z.literal("rob"), target: inSet(others) }), skip]),
  );
}

// ---- Troublemaker ----
export type TroublemakerDecision = { action: "swap"; targets: [string, string] } | { action: "skip" };
export function troublemakerSchema(others: string[]): DecisionSchema<TroublemakerDecision> {
  const pairs: [string, string][] = [];
  for (let i = 0; i < others.length; i++)
    for (let j = i + 1; j < others.length; j++) pairs.push([others[i], others[j]]);
  return make(
    `e.g. {"action":"swap","targets":["${others[0]}","${others[1] ?? others[0]}"]} or {"action":"skip"}`,
    [
      ...pairs.map(([a, b]) => ({
        label: `Swap ${a} ↔ ${b}`,
        value: { action: "swap", targets: [a, b] },
      })),
      { label: "Don't swap", value: { action: "skip" } },
    ],
    z.union([
      z.object({
        action: z.literal("swap"),
        targets: z
          .tuple([inSet(others), inSet(others)])
          .refine(([a, b]) => a !== b, { message: "pick two different players" }),
      }),
      skip,
    ]) as z.ZodType<TroublemakerDecision>,
  );
}

// ---- Drunk: must exchange ----
export type DrunkDecision = { action: "exchange"; card: 0 | 1 | 2 };
export function drunkSchema(): DecisionSchema<DrunkDecision> {
  return make(
    `e.g. {"action":"exchange","card":2}`,
    [0, 1, 2].map((i) => ({
      label: `Exchange with center card ${i}`,
      value: { action: "exchange", card: i },
    })),
    z.object({ action: z.literal("exchange"), card: centerIdx }),
  );
}

// ---- Vote ----
export type VoteDecision = { vote: string };
export function voteSchema(others: string[]): DecisionSchema<VoteDecision> {
  return make(
    `e.g. {"vote":"${others[0]}"} or {"vote":"no_one"}`,
    [
      ...others.map((n) => ({ label: `Vote ${n}`, value: { vote: n } })),
      { label: "Vote no one", value: { vote: NO_ONE } },
    ],
    z.object({ vote: inSet([...others, NO_ONE]) }),
  );
}
