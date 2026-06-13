import fs from "node:fs";
import path from "node:path";
import type { GameEvent } from "../shared/types";
import type { Hub } from "./sockets";
import { paceFor } from "./pacing";

export interface TranscriptEventEntry {
  t: number;
  ev: GameEvent;
}

export function listTranscripts(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .reverse();
}

/** Play a saved game back through the spectator UI with normal pacing. */
export async function runReplay(
  dir: string,
  file: string,
  hub: Hub,
  messageDelayMs: number,
  getSpeed: () => number = () => 1,
  setSnapshot: (events: GameEvent[]) => void = () => {},
): Promise<void> {
  const safe = path.basename(file);
  const full = path.join(dir, safe);
  const data = JSON.parse(fs.readFileSync(full, "utf8")) as {
    events: TranscriptEventEntry[];
  };
  if (!Array.isArray(data.events)) throw new Error(`${safe} has no events array`);
  const replayed: GameEvent[] = [];
  for (const { ev } of data.events) {
    if (ev.type === "game_start") replayed.length = 0;
    replayed.push(ev);
    setSnapshot([...replayed]); // keep mid-replay catch-up current
    hub.broadcastEvent(ev);
    await paceFor(ev, messageDelayMs, getSpeed());
  }
}
