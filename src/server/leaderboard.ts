import fs from "node:fs";
import path from "node:path";
import type { LeaderboardEntry } from "../shared/types";

interface Persisted {
  totalGames: number;
  players: LeaderboardEntry[];
}

/**
 * Global, disk-backed leaderboard. Survives restarts by persisting to a JSON
 * file (keyed by player name). Loaded once on boot, rewritten after each game.
 *
 * In production the file lives on a persistent volume (see docs) — on an
 * ephemeral container filesystem it would reset on redeploy.
 */
export class Leaderboard {
  private entries = new Map<string, LeaderboardEntry>();
  private totalGames = 0;

  constructor(private readonly file: string) {
    this.load();
  }

  private load(): void {
    try {
      const data = JSON.parse(fs.readFileSync(this.file, "utf8")) as Persisted;
      this.totalGames = data.totalGames ?? 0;
      for (const e of data.players ?? []) this.entries.set(e.name, e);
      console.log(`[leaderboard] loaded ${this.entries.size} players, ${this.totalGames} games`);
    } catch {
      /* no file yet — start fresh */
    }
  }

  private save(): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const data: Persisted = { totalGames: this.totalGames, players: [...this.entries.values()] };
      fs.writeFileSync(this.file, JSON.stringify(data, null, 2));
    } catch (err) {
      console.error("[leaderboard] save failed:", err);
    }
  }

  /** Record one finished game: every participant gets +1 game; winners get +1 win. */
  record(participants: { name: string; model?: string }[], winners: string[]): void {
    const won = new Set(winners);
    for (const p of participants) {
      const e =
        this.entries.get(p.name) ?? { name: p.name, wins: 0, games: 0, lastPlayed: 0 };
      e.games += 1;
      if (won.has(p.name)) e.wins += 1;
      if (p.model) e.lastModel = p.model;
      e.lastPlayed = Date.now();
      this.entries.set(p.name, e);
    }
    this.totalGames += 1;
    this.save();
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
