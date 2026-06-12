import { describe, expect, it } from "vitest";
import { resolveVote, NO_ONE } from "../src/engine/vote";
import type { Role, VoteRecord } from "../src/shared/types";

const v = (voter: string, target: string): VoteRecord => ({ voter, target });
const roles = (m: Record<string, Role>) => (p: string) => m[p] ?? "villager";

describe("resolveVote", () => {
  it("kills the plurality target", () => {
    const { deaths } = resolveVote(
      [v("A", "D"), v("B", "D"), v("C", "D"), v("D", "A")],
      roles({}),
    );
    expect(deaths.sort()).toEqual(["D"]);
  });

  it("kills all tied players", () => {
    const { deaths } = resolveVote(
      [v("A", "B"), v("C", "B"), v("B", "A"), v("D", "A"), v("E", "C")],
      roles({}),
    );
    expect(deaths.sort()).toEqual(["A", "B"]);
  });

  it("nobody dies when no_one strictly wins", () => {
    const { deaths } = resolveVote(
      [v("A", NO_ONE), v("B", NO_ONE), v("C", NO_ONE), v("D", "E"), v("E", "D")],
      roles({}),
    );
    expect(deaths).toEqual([]);
  });

  it("player dies when tied with no_one (eliminations take precedence)", () => {
    const { deaths } = resolveVote(
      [v("A", NO_ONE), v("B", NO_ONE), v("C", "A"), v("D", "A"), v("E", "B")],
      roles({}),
    );
    expect(deaths).toEqual(["A"]);
  });

  it("nobody dies when everyone votes no_one", () => {
    const { deaths } = resolveVote(
      [v("A", NO_ONE), v("B", NO_ONE), v("C", NO_ONE)],
      roles({}),
    );
    expect(deaths).toEqual([]);
  });

  it("hunter takes their vote target down, chaining through hunters", () => {
    const { deaths } = resolveVote(
      [v("A", "H"), v("B", "H"), v("H", "T"), v("T", "U"), v("U", "A")],
      roles({ H: "hunter", T: "hunter" }),
    );
    // H dies by vote → H is hunter → T dies → T is hunter → U dies.
    expect(deaths.sort()).toEqual(["H", "T", "U"]);
  });

  it("hunter who voted no_one takes nobody down", () => {
    const { deaths } = resolveVote(
      [v("A", "H"), v("B", "H"), v("H", NO_ONE)],
      roles({ H: "hunter" }),
    );
    expect(deaths).toEqual(["H"]);
  });
});
