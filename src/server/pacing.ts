import type { GameEvent } from "../shared/types";
import { sleep } from "../engine/util";

/**
 * Stream rhythm: how long to hold after each event before the game continues.
 * The typing indicator shows while the LLM call is in flight, so the agent's
 * real latency provides natural variation on top of these.
 *
 * `speed` is a live multiplier from the dashboard (1 = normal, 2 = twice as
 * fast). The vote sequence is NOT scaled — the countdown and the staggered
 * vote flips are choreographed client-side in real time, so the server holds
 * long enough for them regardless of text speed.
 */
export async function paceFor(
  ev: GameEvent,
  messageDelayMs: number,
  speed = 1,
): Promise<void> {
  const s = Math.min(4, Math.max(0.25, speed));
  const d = (ms: number) => sleep(ms / s);
  switch (ev.type) {
    case "chat":
      return d(messageDelayMs);
    case "typing":
      return d(400);
    case "night_step":
      return d(2000);
    case "night_action":
      return d(1400); // lets the card table animate each action (GM view)
    case "phase":
      return d(1500);
    case "vote_countdown":
      return sleep(ev.seconds * 1000);
    case "votes":
      // Sequential reveal: ~0.8s per vote + verdict beat (client-side, real time).
      return sleep(ev.votes.length * 800 + 4000);
    default:
      return;
  }
}
