import type { Role, Team } from "../shared/types";

/** Card counts available in the physical ONUW box — configs may not exceed these. */
export const CARD_LIMITS: Record<Role, number> = {
  villager: 3,
  werewolf: 2,
  mason: 2,
  seer: 1,
  robber: 1,
  troublemaker: 1,
  drunk: 1,
  insomniac: 1,
  hunter: 1,
  minion: 1,
  tanner: 1,
  doppelganger: 1,
};

/** Official night wake order. Steps only run for roles present in the configured set. */
export const NIGHT_ORDER: Role[] = [
  "doppelganger",
  "werewolf",
  "minion",
  "mason",
  "seer",
  "robber",
  "troublemaker",
  "drunk",
  "insomniac",
];

/**
 * Team of a card. The Doppelgänger card counts as the role it copied for the rest
 * of the game (whoever ends up holding it) — resolve with `effectiveRole` first.
 */
export function roleTeam(role: Role): Team {
  if (role === "werewolf" || role === "minion") return "werewolf";
  if (role === "tanner") return "tanner";
  return "village";
}

export function effectiveRole(card: Role, doppelCopied: Role | null): Role {
  return card === "doppelganger" && doppelCopied ? doppelCopied : card;
}

export function roleDisplay(role: Role): string {
  const names: Record<Role, string> = {
    villager: "Villager",
    seer: "Seer",
    robber: "Robber",
    troublemaker: "Troublemaker",
    mason: "Mason",
    drunk: "Drunk",
    insomniac: "Insomniac",
    hunter: "Hunter",
    werewolf: "Werewolf",
    minion: "Minion",
    tanner: "Tanner",
    doppelganger: "Doppelgänger",
  };
  return names[role];
}

/** One-line summaries injected into agent system prompts (configured roles only). */
export const ROLE_SUMMARIES: Record<Role, string> = {
  villager: "No night action. Find the Werewolves and vote one out.",
  werewolf:
    "Wakes at night and sees the other Werewolf. A lone Werewolf may peek at one center card. Wins if no Werewolf is eliminated.",
  minion:
    "Learns who the Werewolves are (they do NOT learn the Minion). On the Werewolf team — wins if no Werewolf is eliminated, even if the Minion dies.",
  mason:
    "The two Masons wake and see each other. A lone Mason knows the other Mason card is in the center.",
  seer: "May look at one player's card OR two of the center cards.",
  robber:
    "May swap their own card with another player's and look at their new card.",
  troublemaker: "May swap two OTHER players' cards without looking at them.",
  drunk:
    "Must swap their card with a center card without looking — the Drunk no longer knows their own role.",
  insomniac: "Looks at their own card at the end of the night to see if it changed.",
  hunter:
    "If the Hunter is eliminated, whoever the Hunter voted for is also eliminated.",
  tanner:
    "Wins ONLY by getting voted out. If the Tanner dies, the Werewolf team cannot win.",
  doppelganger:
    "At the start of the night, looks at another player's card and becomes that role (acting on it where applicable).",
};
