import type { Role, VoteRecord } from "../shared/types";

export const NO_ONE = "no_one";

/**
 * Tally simultaneous votes and apply elimination rules:
 *  - Player(s) with the most votes die; ties among players all die.
 *  - "no_one" is a real vote option: if it strictly beats every player, nobody dies.
 *    If a player ties with "no_one", the player dies (eliminations take precedence).
 *  - Hunter: if an eliminated player's final (effective) card is Hunter, the player
 *    they voted for also dies. Chains resolve recursively.
 */
export function resolveVote(
  votes: VoteRecord[],
  effectiveCard: (player: string) => Role,
): { deaths: string[]; counts: Record<string, number> } {
  const counts: Record<string, number> = {};
  for (const v of votes) counts[v.target] = (counts[v.target] ?? 0) + 1;

  const playerCounts = Object.entries(counts).filter(([t]) => t !== NO_ONE);
  const maxPlayer = playerCounts.reduce((m, [, n]) => Math.max(m, n), 0);
  const noOne = counts[NO_ONE] ?? 0;

  let deaths: string[] = [];
  if (maxPlayer > 0 && noOne <= maxPlayer) {
    deaths = playerCounts.filter(([, n]) => n === maxPlayer).map(([t]) => t);
  }

  // Hunter chain.
  const voteOf = new Map(votes.map((v) => [v.voter, v.target]));
  const dead = new Set(deaths);
  const queue = [...deaths];
  while (queue.length) {
    const d = queue.shift()!;
    if (effectiveCard(d) !== "hunter") continue;
    const target = voteOf.get(d);
    if (target && target !== NO_ONE && !dead.has(target)) {
      dead.add(target);
      queue.push(target);
    }
  }
  return { deaths: [...dead], counts };
}
