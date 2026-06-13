import { describe, expect, it } from "vitest";
import { Game, sanitizeChat } from "../src/engine/game";
import type { DecisionSchema, PlayerController } from "../src/engine/controller";
import type { GameConfig } from "../src/engine/config";
import type { GameEvent, PublicPlayer, Role } from "../src/shared/types";
import { extractJson } from "../src/agents/session";

/** Scripted seat: queued decisions, canned chat, records everything it was told. */
class Mock implements PlayerController {
  readonly profile: PublicPlayer;
  notifications: string[] = [];
  constructor(
    readonly name: string,
    seat: number,
    private decisions: unknown[] = [],
  ) {
    this.profile = { name, avatar: "🤖", color: "#fff", seat, isHuman: false };
  }
  notify(text: string): void {
    this.notifications.push(text);
  }
  async decide<T>(prompt: string, schema: DecisionSchema<T>): Promise<T | null> {
    this.notifications.push(prompt); // prompts reach the seat's context like notify()
    const next = this.decisions.shift();
    if (next === undefined) return null;
    return schema.parse(next);
  }
  async speak(): Promise<string | null> {
    return `hello from ${this.name}`;
  }
  told(substr: string): boolean {
    return this.notifications.some((n) => n.includes(substr));
  }
}

function makeConfig(players: number, roles: Role[]): GameConfig {
  return {
    players,
    roles,
    discussion: { rounds: 1 },
    pacing: { message_delay_ms: 0, typing_indicator: false },
    spoiler_panel_default: false,
    play_mode: false,
    human_turn_timeout_ms: 1000,
    auto_start: false,
    auto_start_seconds: 60,
    auto_start_host_fill: false,
    default_llm: { provider: "anthropic", model: "claude-opus-4-8" },
    agents: [],
  };
}

describe("Game (scripted)", () => {
  it("runs a full game: lone wolf, seer, robber, troublemaker, vote", async () => {
    // Deal: A=werewolf B=seer C=robber D=troublemaker E=villager
    // Center: werewolf, villager, villager
    const A = new Mock("A", 0, [{ action: "peek_center", card: 0 }]);
    const B = new Mock("B", 1, [
      { action: "peek_player", target: "A" },
      { vote: "C" },
    ]);
    const C = new Mock("C", 2, [{ action: "rob", target: "A" }, { vote: "A" }]);
    const D = new Mock("D", 3, [
      { action: "swap", targets: ["A", "B"] },
      { vote: "C" },
    ]);
    const E = new Mock("E", 4, [{ vote: "C" }]);
    // A's vote comes after its night decision queue: give it one.
    A["decisions" as never]; // (decisions are private; queue set in ctor)
    const Avote = { vote: "E" };
    (A as unknown as { decisions: unknown[] }).decisions.push(Avote);

    const events: GameEvent[] = [];
    const game = new Game({
      config: makeConfig(5, [
        "werewolf",
        "werewolf",
        "seer",
        "robber",
        "troublemaker",
        "villager",
        "villager",
        "villager",
      ]),
      controllers: [A, B, C, D, E],
      emit: (ev) => void events.push(ev),
      rng: () => 0.4999, // deterministic shuffles (order-preserving enough for the test)
      fixedDeal: [
        "werewolf",
        "seer",
        "robber",
        "troublemaker",
        "villager",
        "werewolf",
        "villager",
        "villager",
      ],
    });
    const reveal = await game.run();

    // Private info went only to the right seats.
    expect(A.told("You are dealt: WEREWOLF")).toBe(true);
    expect(A.told("ONLY Werewolf")).toBe(true);
    expect(A.told("Center card 0 is: WEREWOLF")).toBe(true);
    expect(B.told("A's card is: WEREWOLF")).toBe(true);
    expect(C.told("Your new card is: WEREWOLF")).toBe(true);
    expect(D.told("you swapped A's and B's cards")).toBe(true);
    // Nobody else saw the seer's result.
    expect(C.told("A's card is: WEREWOLF")).toBe(false);

    // Card movement: C robbed A (C=werewolf, A=robber), then TM swapped A and B
    // (A=seer, B=robber).
    expect(reveal.finalCards).toEqual({
      A: "seer",
      B: "robber",
      C: "werewolf",
      D: "troublemaker",
      E: "villager",
    });

    // C (now the werewolf) got 3 votes and died → village wins.
    expect(reveal.deaths).toEqual(["C"]);
    expect(reveal.winningTeams).toEqual(["village"]);
    expect(reveal.winners.sort()).toEqual(["A", "B", "D", "E"]);

    // Every seat chatted once per round, publicly.
    const chats = events.filter((e) => e.type === "chat");
    expect(chats).toHaveLength(5);
    // Each non-speaker was told each chat line.
    expect(B.told("[CHAT] A: hello from A")).toBe(true);
    expect(A.told("[CHAT] A: hello from A")).toBe(false);
  });

  it("handles doppelgänger, drunk, and insomniac", async () => {
    // Deal: A=doppelganger B=werewolf C=drunk D=insomniac E=villager
    // Center: seer, villager, troublemaker
    const A = new Mock("A", 0, [{ action: "copy", target: "B" }, { vote: "E" }]);
    const B = new Mock("B", 1, [{ vote: "A" }]);
    const C = new Mock("C", 2, [{ action: "exchange", card: 0 }, { vote: "B" }]);
    const D = new Mock("D", 3, [{ vote: "B" }]);
    const E = new Mock("E", 4, [{ vote: "B" }]);

    const game = new Game({
      config: makeConfig(5, [
        "doppelganger",
        "werewolf",
        "drunk",
        "insomniac",
        "villager",
        "seer",
        "villager",
        "troublemaker",
      ]),
      controllers: [A, B, C, D, E],
      emit: () => {},
      rng: () => 0.4999,
      fixedDeal: [
        "doppelganger",
        "werewolf",
        "drunk",
        "insomniac",
        "villager",
        "seer",
        "villager",
        "troublemaker",
      ],
    });
    const reveal = await game.run();

    // DG copied the werewolf and woke with the pack — both saw each other.
    expect(A.told("B's card: WEREWOLF")).toBe(true);
    expect(A.told("fellow Werewolf is: B")).toBe(true);
    expect(B.told("fellow Werewolf is: A")).toBe(true);
    expect(reveal.doppelCopied).toBe("werewolf");

    // Drunk exchanged with center 0 (the seer) and was not told the new card.
    expect(C.told("center card 0")).toBe(true);
    expect(C.told("SEER")).toBe(false);
    expect(reveal.finalCards.C).toBe("seer");
    expect(reveal.centerFinal[0]).toBe("drunk");

    // Insomniac saw their (unchanged) card.
    expect(D.told("It is: INSOMNIAC")).toBe(true);

    // B (real werewolf) died → village wins; A holds the DG-werewolf card → loses.
    expect(reveal.deaths).toEqual(["B"]);
    expect(reveal.winningTeams).toEqual(["village"]);
    expect(reveal.winners.sort()).toEqual(["C", "D", "E"]);
  });

  it("falls back gracefully when seats pass on decisions", async () => {
    // Everyone passes everything: drunk still must exchange, votes become no_one.
    const A = new Mock("A", 0); // drunk — no decision queued
    const B = new Mock("B", 1);
    const C = new Mock("C", 2);
    const game = new Game({
      config: makeConfig(3, ["drunk", "villager", "villager", "villager", "villager", "seer"]),
      controllers: [A, B, C],
      emit: () => {},
      rng: () => 0.1,
      fixedDeal: ["drunk", "villager", "villager", "villager", "villager", "seer"],
    });
    const reveal = await game.run();
    // Drunk was forced to exchange with a random center card.
    expect(reveal.finalCards.A).not.toBe("drunk");
    expect(reveal.centerFinal).toContain("drunk");
    // All votes defaulted to no_one → nobody died; no wolves → village wins.
    expect(reveal.deaths).toEqual([]);
    expect(reveal.winningTeams).toEqual(["village"]);
  });
});

describe("helpers", () => {
  it("sanitizeChat strips quotes, name prefixes, and newlines", () => {
    expect(sanitizeChat('"hello there"', "A")).toBe("hello there");
    expect(sanitizeChat("A: i swear im a villager", "A")).toBe("i swear im a villager");
    expect(sanitizeChat("line one\nline two", "A")).toBe("line one line two");
    expect(sanitizeChat(null, "A")).toBe("");
  });

  it("extractJson tolerates prose around the object", () => {
    expect(extractJson('{"vote":"A"}')).toEqual({ vote: "A" });
    expect(extractJson('Sure! Here is my vote: {"vote":"A"} :)')).toEqual({ vote: "A" });
    expect(extractJson("no json here")).toBeNull();
  });
});
