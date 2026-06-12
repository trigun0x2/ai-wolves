import type { Role, Team } from "../shared/types";
import { effectiveRole, roleTeam } from "./roles";

export interface WinResult {
  winningTeams: Team[];
  winners: string[];
}

/**
 * Standard ONUW win evaluation (teams determined by the card held at the END of
 * the night; the Doppelgänger card counts as its copied role).
 *
 *  - Village wins if ≥1 Werewolf died, OR no Werewolf cards are among players and
 *    nobody died.
 *  - Werewolf team (Werewolves + Minion) wins if a Werewolf is in play and none died.
 *  - Tanner wins iff he dies, and a Tanner death blocks ALL Werewolf-team wins
 *    (including the lone-Minion edge case — documented choice).
 *  - Minion edge case: Minion in play with no Werewolves wins if he survives and
 *    any other player dies (unless that death was the Tanner — see above).
 *  - Multiple teams can win simultaneously (e.g. Tanner + Village).
 */
export function evaluateWinners(
  finalCards: Record<string, Role>,
  doppelCopied: Role | null,
  deaths: string[],
): WinResult {
  const players = Object.keys(finalCards);
  const eff = (p: string) => effectiveRole(finalCards[p], doppelCopied);
  const deadSet = new Set(deaths);

  const wolves = players.filter((p) => eff(p) === "werewolf");
  const minions = players.filter((p) => eff(p) === "minion");
  const tanners = players.filter((p) => eff(p) === "tanner");

  const wolfDied = wolves.some((p) => deadSet.has(p));
  const deadTanners = tanners.filter((p) => deadSet.has(p));
  const tannerDied = deadTanners.length > 0;

  const villageWins = wolfDied || (wolves.length === 0 && deaths.length === 0);
  const wolfTeamWins = wolves.length > 0 && !wolfDied && !tannerDied;
  const minionAloneWins =
    wolves.length === 0 &&
    minions.length > 0 &&
    minions.some((p) => !deadSet.has(p)) &&
    deaths.some((p) => eff(p) !== "minion") &&
    !tannerDied;

  const winningTeams: Team[] = [];
  const winners = new Set<string>();

  if (villageWins) {
    winningTeams.push("village");
    for (const p of players) if (roleTeam(eff(p)) === "village") winners.add(p);
  }
  if (wolfTeamWins || minionAloneWins) {
    winningTeams.push("werewolf");
    if (wolfTeamWins) {
      for (const p of [...wolves, ...minions]) winners.add(p);
    } else {
      for (const p of minions) if (!deadSet.has(p)) winners.add(p);
    }
  }
  if (tannerDied) {
    winningTeams.push("tanner");
    for (const p of deadTanners) winners.add(p);
  }

  return { winningTeams, winners: [...winners] };
}
