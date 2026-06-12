import { describe, expect, it } from "vitest";
import { evaluateWinners } from "../src/engine/win";
import type { Role } from "../src/shared/types";

const cards = (m: Record<string, Role>) => m;

describe("evaluateWinners", () => {
  it("village wins when a werewolf dies", () => {
    const r = evaluateWinners(
      cards({ A: "werewolf", B: "seer", C: "villager" }),
      null,
      ["A"],
    );
    expect(r.winningTeams).toEqual(["village"]);
    expect(r.winners.sort()).toEqual(["B", "C"]);
  });

  it("werewolf team wins when no werewolf dies", () => {
    const r = evaluateWinners(
      cards({ A: "werewolf", B: "minion", C: "villager", D: "seer" }),
      null,
      ["C"],
    );
    expect(r.winningTeams).toEqual(["werewolf"]);
    expect(r.winners.sort()).toEqual(["A", "B"]);
  });

  it("village wins a wolf-free game only if nobody dies", () => {
    const none = evaluateWinners(cards({ A: "seer", B: "villager" }), null, []);
    expect(none.winningTeams).toEqual(["village"]);

    const someoneDied = evaluateWinners(cards({ A: "seer", B: "villager" }), null, ["B"]);
    expect(someoneDied.winningTeams).toEqual([]);
    expect(someoneDied.winners).toEqual([]);
  });

  it("lone minion wins by surviving while another player dies", () => {
    const r = evaluateWinners(
      cards({ A: "minion", B: "villager", C: "seer" }),
      null,
      ["B"],
    );
    expect(r.winningTeams).toEqual(["werewolf"]);
    expect(r.winners).toEqual(["A"]);
  });

  it("lone minion does not win by dying alone", () => {
    const r = evaluateWinners(
      cards({ A: "minion", B: "villager", C: "seer" }),
      null,
      ["A"],
    );
    expect(r.winningTeams).toEqual([]);
  });

  it("tanner wins by dying and blocks the werewolf team", () => {
    const r = evaluateWinners(
      cards({ A: "werewolf", B: "tanner", C: "villager" }),
      null,
      ["B"],
    );
    expect(r.winningTeams).toEqual(["tanner"]);
    expect(r.winners).toEqual(["B"]);
  });

  it("tanner and village can both win", () => {
    const r = evaluateWinners(
      cards({ A: "werewolf", B: "tanner", C: "villager", D: "seer" }),
      null,
      ["A", "B"],
    );
    expect(r.winningTeams.sort()).toEqual(["tanner", "village"]);
    expect(r.winners.sort()).toEqual(["B", "C", "D"]);
  });

  it("doppelgänger card counts as its copied role", () => {
    // DG copied werewolf and ended the night holding the DG card → werewolf team.
    const r = evaluateWinners(
      cards({ A: "doppelganger", B: "werewolf", C: "villager" }),
      "werewolf",
      ["C"],
    );
    expect(r.winningTeams).toEqual(["werewolf"]);
    expect(r.winners.sort()).toEqual(["A", "B"]);
  });
});
