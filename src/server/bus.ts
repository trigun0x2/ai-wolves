import { createClient, type RedisClientType } from "redis";
import type { GameEvent, ServerMessage } from "../shared/types";

/**
 * Outbound message bus for fanning ServerMessages to WebSocket clients across
 * one or many instances.
 *
 *  - LocalBus: single process — publish loops straight back to the local handler.
 *  - RedisBus: multi-instance — publish goes to a Redis pub/sub channel; every
 *    instance (including the publisher) receives it via its own subscription and
 *    delivers to its local sockets.
 *
 * "Sticky" message types (lobby/scoreboard/speed/submissions) are also retained
 * (last value), so a freshly-connected client — even on a gateway that just
 * booted — can be primed with current state. No keys ever transit the bus.
 */
export type Target = "all" | "spectator" | "player";
export interface Envelope {
  target: Target;
  msg: ServerMessage;
}

/** Message types whose latest value is replayed to new connections. */
export const RETAINED_TYPES: ReadonlySet<string> = new Set([
  "lobby",
  "scoreboard",
  "speed",
  "submissions",
]);

export interface Bus {
  readonly kind: string;
  publish(env: Envelope): void;
  onMessage(handler: (env: Envelope) => void): void;
  /** Latest retained sticky messages (to prime an instance / a new connection). */
  retained(): Promise<Envelope[]>;
  /**
   * Current-game event log (set by the primary, read by any instance) so a
   * mid-game spectator can be caught up on connect. Not delivered live — fetched
   * once per connection. Never holds keys; just the public event stream.
   */
  setSnapshot(events: GameEvent[]): void;
  getSnapshot(): Promise<GameEvent[]>;
  close(): Promise<void>;
}

export class LocalBus implements Bus {
  readonly kind = "local";
  private handler: (env: Envelope) => void = () => {};
  private store = new Map<string, Envelope>();

  publish(env: Envelope): void {
    if (RETAINED_TYPES.has(env.msg.type)) this.store.set(env.msg.type, env);
    this.handler(env);
  }
  onMessage(handler: (env: Envelope) => void): void {
    this.handler = handler;
  }
  async retained(): Promise<Envelope[]> {
    return [...this.store.values()];
  }
  private snapshot: GameEvent[] = [];
  setSnapshot(events: GameEvent[]): void {
    this.snapshot = events;
  }
  async getSnapshot(): Promise<GameEvent[]> {
    return this.snapshot;
  }
  async close(): Promise<void> {}
}

const CHANNEL = "aiwolves:bus";
const retainedKey = (type: string) => `aiwolves:retained:${type}`;

export class RedisBus implements Bus {
  readonly kind = "redis";
  private handler: (env: Envelope) => void = () => {};

  private constructor(
    private readonly pub: RedisClientType,
    private readonly sub: RedisClientType,
  ) {}

  static async create(url: string): Promise<RedisBus> {
    const pub: RedisClientType = createClient({ url });
    const sub: RedisClientType = pub.duplicate();
    pub.on("error", (e) => console.error("[bus] pub error:", e));
    sub.on("error", (e) => console.error("[bus] sub error:", e));
    await pub.connect();
    await sub.connect();
    const bus = new RedisBus(pub, sub);
    await sub.subscribe(CHANNEL, (raw) => {
      try {
        bus.handler(JSON.parse(raw) as Envelope);
      } catch (e) {
        console.error("[bus] bad message:", e);
      }
    });
    return bus;
  }

  publish(env: Envelope): void {
    const raw = JSON.stringify(env);
    if (RETAINED_TYPES.has(env.msg.type)) {
      this.pub.set(retainedKey(env.msg.type), raw).catch((e) => console.error("[bus] retain:", e));
    }
    this.pub.publish(CHANNEL, raw).catch((e) => console.error("[bus] publish:", e));
  }
  onMessage(handler: (env: Envelope) => void): void {
    this.handler = handler;
  }
  async retained(): Promise<Envelope[]> {
    const keys = [...RETAINED_TYPES].map(retainedKey);
    const vals = await this.pub.mGet(keys);
    return vals.filter((v): v is string => !!v).map((v) => JSON.parse(v) as Envelope);
  }
  setSnapshot(events: GameEvent[]): void {
    this.pub.set("aiwolves:snapshot", JSON.stringify(events)).catch((e) =>
      console.error("[bus] snapshot set:", e),
    );
  }
  async getSnapshot(): Promise<GameEvent[]> {
    const v = await this.pub.get("aiwolves:snapshot");
    return v ? (JSON.parse(v) as GameEvent[]) : [];
  }
  async close(): Promise<void> {
    await this.sub.quit();
    await this.pub.quit();
  }
}

export async function createBus(url?: string): Promise<Bus> {
  if (url) {
    console.log("[bus] using Redis pub/sub");
    return RedisBus.create(url);
  }
  console.log("[bus] local (single process)");
  return new LocalBus();
}
