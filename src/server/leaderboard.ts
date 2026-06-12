import type { LeaderboardEntry } from "../shared/types";
import type { KvStore } from "./store";

interface Persisted {
  totalGames: number;
  players: LeaderboardEntry[];
}

/**
 * Global, persistent leaderboard. Backed by a KvStore (Redis in production, a
 * JSON file in dev), keyed by player name. Loaded once on boot via init(),
 * rewritten after each game. The in-memory map is the runtime source of truth;
 * reads (list/games) are synchronous, writes (record) persist asynchronously.
 */
export class Leaderboard {
  private entries = new Map<string, LeaderboardEntry>();
  private totalGames = 0;

  constructor(
    private readonly store: KvStore,
    private readonly key = "leaderboard",
  ) {}

  async init(): Promise<void> {
    const data = await this.store.getJson<Persisted>(this.key);
    if (data) {
      this.totalGames = data.totalGames ?? 0;
      for (const e of data.players ?? []) this.entries.set(e.name, e);
      console.log(`[leaderboard] loaded ${this.entries.size} players, ${this.totalGames} games`);
    }
  }

  /** Record one finished game: every participant gets +1 game; winners get +1 win. */
  async record(participants: { name: string; model?: string }[], winners: string[]): Promise<void> {
    const won = new Set(winners);
    for (const p of participants) {
      const e = this.entries.get(p.name) ?? { name: p.name, wins: 0, games: 0, lastPlayed: 0 };
      e.games += 1;
      if (won.has(p.name)) e.wins += 1;
      if (p.model) e.lastModel = p.model;
      e.lastPlayed = Date.now();
      this.entries.set(p.name, e);
    }
    this.totalGames += 1;
    try {
      await this.store.setJson(this.key, {
        totalGames: this.totalGames,
        players: [...this.entries.values()],
      } satisfies Persisted);
    } catch (err) {
      console.error("[leaderboard] persist failed:", err);
    }
  }

  /** Sorted by wins, then games, then name. */
  list(): LeaderboardEntry[] {
    return [...this.entries.values()].sort(
      (a, b) => b.wins - a.wins || b.games - a.games || a.name.localeCompare(b.name),
    );
  }

  games(): number {
    return this.totalGames;
  }
}
