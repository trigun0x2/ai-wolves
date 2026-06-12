import type { Role } from "../shared/types";

/** Mutable card layout during the night. All night actions go through this class. */
export class CardState {
  private readonly cards: Map<string, Role>;
  readonly center: Role[];

  constructor(cards: Map<string, Role>, center: Role[]) {
    this.cards = new Map(cards);
    this.center = [...center];
  }

  get(player: string): Role {
    const r = this.cards.get(player);
    if (!r) throw new Error(`No card for player ${player}`);
    return r;
  }

  getCenter(i: number): Role {
    if (i < 0 || i > 2) throw new Error(`Bad center index ${i}`);
    return this.center[i];
  }

  swapPlayers(a: string, b: string): void {
    const ra = this.get(a);
    const rb = this.get(b);
    this.cards.set(a, rb);
    this.cards.set(b, ra);
  }

  swapWithCenter(player: string, i: number): void {
    const rp = this.get(player);
    const rc = this.getCenter(i);
    this.cards.set(player, rc);
    this.center[i] = rp;
  }

  snapshot(): Record<string, Role> {
    return Object.fromEntries(this.cards);
  }
}
