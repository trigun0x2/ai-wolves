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
): Promise<void> {
  const safe = path.basename(file);
  const full = path.join(dir, safe);
  const data = JSON.parse(fs.readFileSync(full, "utf8")) as {
    events: TranscriptEventEntry[];
  };
  if (!Array.isArray(data.events)) throw new Error(`${safe} has no events array`);
  for (const { ev } of data.events) {
    hub.broadcastEvent(ev);
    await paceFor(ev, messageDelayMs, getSpeed());
  }
}
