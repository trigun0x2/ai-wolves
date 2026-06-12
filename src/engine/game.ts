import type {
  CardRef,
  GameEvent,
  NightEffect,
  NightLogEntry,
  RevealData,
  Role,
  VoteRecord,
} from "../shared/types";
import type { GameConfig } from "./config";
import type { PlayerController } from "./controller";
import { CardState } from "./cards";
import { NIGHT_ORDER, effectiveRole, roleDisplay } from "./roles";
import { resolveVote, NO_ONE } from "./vote";
import { evaluateWinners } from "./win";
import { shuffle, pick, type Rng } from "./util";
import * as P from "../agents/prompts";
import * as D from "../agents/decisions";

export interface GameDeps {
  config: GameConfig;
  controllers: PlayerController[];
  /** Sink for every game event. The server broadcasts, paces, and records these. */
  emit: (ev: GameEvent) => Promise<void> | void;
  rng?: Rng;
  gameId?: string;
  /** Test hook: deal fixedDeal[i] to controllers[i]; last 3 cards go to the center. */
  fixedDeal?: Role[];
}

const C = (r: Role) => roleDisplay(r).toUpperCase();

export class Game {
  private readonly config: GameConfig;
  private readonly controllers: PlayerController[];
  private readonly emitFn: GameDeps["emit"];
  private readonly rng: Rng;
  private readonly gameId: string;
  private readonly fixedDeal?: Role[];

  private state!: CardState;
  private dealt = new Map<string, Role>();
  private centerOriginal: Role[] = [];
  private doppel: { player: string; copied: Role } | null = null;
  private nightLog: NightLogEntry[] = [];

  constructor(deps: GameDeps) {
    this.config = deps.config;
    this.controllers = deps.controllers;
    this.emitFn = deps.emit;
    this.rng = deps.rng ?? Math.random;
    this.gameId = deps.gameId ?? `game-${Date.now()}`;
    this.fixedDeal = deps.fixedDeal;
  }

  private async emit(ev: GameEvent): Promise<void> {
    await this.emitFn(ev);
  }

  private names(): string[] {
    return this.controllers.map((c) => c.name);
  }

  private othersOf(name: string): string[] {
    return this.names().filter((n) => n !== name);
  }

  private byName(name: string): PlayerController {
    const c = this.controllers.find((x) => x.name === name);
    if (!c) throw new Error(`Unknown player ${name}`);
    return c;
  }

  private dealtWith(role: Role): PlayerController[] {
    return this.controllers.filter((c) => this.dealt.get(c.name) === role);
  }

  /** Players who wake for a group role: dealt it, plus the Doppelgänger copy of it. */
  private wakeGroup(role: "werewolf" | "minion" | "mason"): PlayerController[] {
    const group = this.dealtWith(role);
    if (this.doppel?.copied === role) group.push(this.byName(this.doppel.player));
    return group;
  }

  private async log(
    step: string,
    player: string,
    summary: string,
    effect?: NightEffect,
  ): Promise<void> {
    this.nightLog.push({ step, player, summary });
    await this.emit({ type: "night_action", player, step, summary, effect });
  }

  async run(): Promise<RevealData> {
    const { config, controllers } = this;

    // --- Deal ---
    const deck = this.fixedDeal ?? shuffle(config.roles, this.rng);
    controllers.forEach((c, i) => this.dealt.set(c.name, deck[i]));
    this.centerOriginal = deck.slice(controllers.length, controllers.length + 3);
    this.state = new CardState(this.dealt, this.centerOriginal);

    await this.emit({
      type: "game_start",
      gameId: this.gameId,
      players: controllers.map((c) => c.profile),
      roles: [...config.roles],
    });
    await this.emit({
      type: "deal",
      cards: Object.fromEntries(this.dealt),
      center: [...this.centerOriginal],
    });
    for (const c of controllers) c.notify(P.deal(this.dealt.get(c.name)!));

    // --- Night ---
    await this.emit({ type: "phase", phase: "night" });
    for (const step of NIGHT_ORDER) {
      if (!config.roles.includes(step)) continue;
      await this.emit({ type: "night_step", role: step });
      await this.nightStep(step);
    }

    // --- Day ---
    const rounds = config.discussion.rounds;
    await this.emit({ type: "phase", phase: "day", round: 1, totalRounds: rounds });
    for (const c of controllers) c.notify(P.dayStart(rounds));

    for (let r = 1; r <= rounds; r++) {
      if (r > 1) await this.emit({ type: "phase", phase: "day", round: r, totalRounds: rounds });
      const order = shuffle(controllers, this.rng);
      for (const speaker of order) {
        if (config.pacing.typing_indicator) {
          await this.emit({ type: "typing", player: speaker.name });
        }
        const raw = await speaker.speak(P.speakTurn(r, rounds));
        const text = sanitizeChat(raw, speaker.name) || "…";
        await this.emit({ type: "chat", player: speaker.name, text, round: r });
        for (const other of controllers) {
          if (other !== speaker) other.notify(P.chatLine(speaker.name, text));
        }
      }
    }

    // --- Vote (simultaneous) ---
    await this.emit({ type: "phase", phase: "vote" });
    const votes: VoteRecord[] = await Promise.all(
      controllers.map(async (c) => {
        const schema = D.voteSchema(this.othersOf(c.name));
        const choice = await c.decide(P.votePrompt(schema.hint), schema);
        return { voter: c.name, target: choice?.vote ?? NO_ONE };
      }),
    );

    await this.emit({ type: "vote_countdown", seconds: 5 });
    const finalCards = this.state.snapshot();
    const eff = (p: string) => effectiveRole(finalCards[p], this.doppel?.copied ?? null);
    const { deaths } = resolveVote(votes, eff);
    await this.emit({ type: "votes", votes, deaths });

    // --- Reveal ---
    const win = evaluateWinners(finalCards, this.doppel?.copied ?? null, deaths);
    const reveal: RevealData = {
      originalCards: Object.fromEntries(this.dealt),
      finalCards,
      centerOriginal: [...this.centerOriginal],
      centerFinal: [...this.state.center],
      doppelCopied: this.doppel?.copied ?? null,
      nightLog: [...this.nightLog],
      votes,
      deaths,
      winningTeams: win.winningTeams,
      winners: win.winners,
    };
    await this.emit({ type: "phase", phase: "reveal" });
    await this.emit({ type: "reveal", data: reveal });
    return reveal;
  }

  // ---------------- Night steps ----------------

  private async nightStep(step: Role): Promise<void> {
    switch (step) {
      case "doppelganger":
        return this.stepDoppelganger();
      case "werewolf":
        return this.stepWerewolf();
      case "minion":
        return this.stepMinion();
      case "mason":
        return this.stepMason();
      case "seer":
      case "robber":
      case "troublemaker":
      case "drunk": {
        for (const actor of this.dealtWith(step)) {
          await this.roleAction(actor, step, step);
        }
        return;
      }
      case "insomniac":
        return this.stepInsomniac();
      default:
        return; // villager/hunter/tanner/minion handled elsewhere or no action
    }
  }

  private async stepDoppelganger(): Promise<void> {
    const dg = this.dealtWith("doppelganger")[0];
    if (!dg) return;
    const others = this.othersOf(dg.name);
    const schema = D.copySchema(others);
    const choice = await dg.decide(P.dgWake(schema.hint), schema);
    const target = choice?.target ?? pick(others, this.rng); // must copy — random on pass
    const copied = this.state.get(target);
    this.doppel = { player: dg.name, copied };
    dg.notify(P.dgResult(target, copied));
    await this.log(
      "doppelganger",
      dg.name,
      `looked at ${target}'s card and became the ${roleDisplay(copied)}`,
      { kind: "peek", viewer: dg.name, targets: [{ type: "player", name: target }] },
    );
    if (copied === "seer" || copied === "robber" || copied === "troublemaker" || copied === "drunk") {
      await this.roleAction(dg, copied, `doppelganger → ${copied}`);
    }
  }

  private async stepWerewolf(): Promise<void> {
    const wolves = this.wakeGroup("werewolf");
    if (wolves.length === 0) return;
    if (wolves.length >= 2) {
      for (const w of wolves) {
        const others = wolves.filter((x) => x !== w).map((x) => x.name);
        w.notify(P.wolfWakePack(others));
        await this.log("werewolf", w.name, `woke and saw fellow Werewolf: ${others.join(", ")}`, {
          kind: "peek",
          viewer: w.name,
          targets: others.map((name) => ({ type: "player", name }) as CardRef),
        });
      }
      return;
    }
    // Lone wolf may peek one center card.
    const w = wolves[0];
    const schema = D.loneWolfSchema();
    const choice = await w.decide(P.wolfWakeLone(schema.hint), schema);
    if (choice && choice.action === "peek_center") {
      const role = this.state.getCenter(choice.card);
      w.notify(P.centerPeekResult(choice.card, role));
      await this.log(
        "werewolf",
        w.name,
        `woke alone and peeked center card ${choice.card}: ${C(role)}`,
        { kind: "peek", viewer: w.name, targets: [{ type: "center", idx: choice.card }] },
      );
    } else {
      w.notify(P.skipped());
      await this.log("werewolf", w.name, "woke alone and didn't peek");
    }
  }

  private async stepMinion(): Promise<void> {
    const minions = this.wakeGroup("minion");
    if (minions.length === 0) return;
    const wolfNames = this.wakeGroup("werewolf").map((w) => w.name);
    for (const m of minions) {
      m.notify(P.minionWake(wolfNames.filter((n) => n !== m.name)));
      await this.log(
        "minion",
        m.name,
        wolfNames.length
          ? `learned the Werewolves: ${wolfNames.join(", ")}`
          : "learned there are no Werewolves among the players",
        wolfNames.length
          ? {
              kind: "peek",
              viewer: m.name,
              targets: wolfNames.map((name) => ({ type: "player", name }) as CardRef),
            }
          : undefined,
      );
    }
  }

  private async stepMason(): Promise<void> {
    const masons = this.wakeGroup("mason");
    if (masons.length === 0) return;
    for (const m of masons) {
      const others = masons.filter((x) => x !== m).map((x) => x.name);
      m.notify(P.masonWake(others));
      await this.log(
        "mason",
        m.name,
        others.length ? `saw the other Mason: ${others.join(", ")}` : "saw no other Mason (in the center)",
        others.length
          ? {
              kind: "peek",
              viewer: m.name,
              targets: others.map((name) => ({ type: "player", name }) as CardRef),
            }
          : undefined,
      );
    }
  }

  private async stepInsomniac(): Promise<void> {
    for (const actor of this.dealtWith("insomniac")) {
      const role = this.state.get(actor.name);
      actor.notify(P.insomniacWake(role));
      await this.log("insomniac", actor.name, `checked their card: ${C(role)}`, {
        kind: "peek",
        viewer: actor.name,
        targets: [{ type: "player", name: actor.name }],
      });
    }
    if (this.doppel?.copied === "insomniac") {
      const dg = this.byName(this.doppel.player);
      const role = this.state.get(dg.name);
      dg.notify(P.insomniacWake(role));
      await this.log("doppelganger → insomniac", dg.name, `checked their card: ${C(role)}`, {
        kind: "peek",
        viewer: dg.name,
        targets: [{ type: "player", name: dg.name }],
      });
    }
  }

  /** Shared by dealt roles and the Doppelgänger acting as a copied role. */
  private async roleAction(
    actor: PlayerController,
    role: "seer" | "robber" | "troublemaker" | "drunk",
    stepLabel: string,
  ): Promise<void> {
    const others = this.othersOf(actor.name);
    switch (role) {
      case "seer": {
        const schema = D.seerSchema(others);
        const choice = await actor.decide(P.seerWake(schema.hint), schema);
        if (choice?.action === "peek_player") {
          const seen = this.state.get(choice.target);
          actor.notify(P.seerPlayerResult(choice.target, seen));
          await this.log(stepLabel, actor.name, `looked at ${choice.target}'s card: ${C(seen)}`, {
            kind: "peek",
            viewer: actor.name,
            targets: [{ type: "player", name: choice.target }],
          });
        } else if (choice?.action === "peek_center") {
          const [a, b] = choice.cards;
          const ra = this.state.getCenter(a);
          const rb = this.state.getCenter(b);
          actor.notify(P.seerCenterResult(a, ra, b, rb));
          await this.log(
            stepLabel,
            actor.name,
            `looked at center cards ${a} (${C(ra)}) and ${b} (${C(rb)})`,
            {
              kind: "peek",
              viewer: actor.name,
              targets: [
                { type: "center", idx: a },
                { type: "center", idx: b },
              ],
            },
          );
        } else {
          actor.notify(P.skipped());
          await this.log(stepLabel, actor.name, "chose not to look");
        }
        return;
      }
      case "robber": {
        const schema = D.robberSchema(others);
        const choice = await actor.decide(P.robberWake(schema.hint), schema);
        if (choice?.action === "rob") {
          this.state.swapPlayers(actor.name, choice.target);
          const newRole = this.state.get(actor.name);
          actor.notify(P.robberResult(choice.target, newRole));
          await this.log(
            stepLabel,
            actor.name,
            `took ${choice.target}'s card and is now the ${roleDisplay(newRole)}`,
            {
              kind: "swap",
              a: { type: "player", name: actor.name },
              b: { type: "player", name: choice.target },
            },
          );
        } else {
          actor.notify(P.skipped());
          await this.log(stepLabel, actor.name, "kept their own card");
        }
        return;
      }
      case "troublemaker": {
        const schema = D.troublemakerSchema(others);
        const choice = await actor.decide(P.tmWake(schema.hint), schema);
        if (choice?.action === "swap") {
          const [a, b] = choice.targets;
          this.state.swapPlayers(a, b);
          actor.notify(P.tmResult(a, b));
          await this.log(stepLabel, actor.name, `swapped ${a}'s and ${b}'s cards`, {
            kind: "swap",
            a: { type: "player", name: a },
            b: { type: "player", name: b },
          });
        } else {
          actor.notify(P.skipped());
          await this.log(stepLabel, actor.name, "didn't swap anyone");
        }
        return;
      }
      case "drunk": {
        const schema = D.drunkSchema();
        const choice = await actor.decide(P.drunkWake(schema.hint), schema);
        const idx = choice?.card ?? (Math.floor(this.rng() * 3) as 0 | 1 | 2); // must exchange
        this.state.swapWithCenter(actor.name, idx);
        actor.notify(P.drunkResult(idx));
        await this.log(stepLabel, actor.name, `exchanged their card with center card ${idx} (unseen)`, {
          kind: "swap",
          a: { type: "player", name: actor.name },
          b: { type: "center", idx },
        });
        return;
      }
    }
  }
}

/** Normalize a chat line: single line, no wrapping quotes, no self name-prefix, capped. */
export function sanitizeChat(raw: string | null, speaker: string): string {
  if (!raw) return "";
  let t = raw.replace(/\s+/g, " ").trim();
  if (
    (t.startsWith('"') && t.endsWith('"')) ||
    (t.startsWith("“") && t.endsWith("”"))
  ) {
    t = t.slice(1, -1).trim();
  }
  const prefix = new RegExp(`^\\[?CHAT\\]?\\s*`, "i");
  t = t.replace(prefix, "");
  const namePrefix = new RegExp(`^${speaker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*:\\s*`, "i");
  t = t.replace(namePrefix, "");
  return t.slice(0, 600);
}
