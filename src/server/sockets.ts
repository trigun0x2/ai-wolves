import type { WebSocket } from "ws";
import {
  SPOILER_EVENTS,
  type Channel,
  type GameEvent,
  type ServerMessage,
} from "../shared/types";
import { RETAINED_TYPES, type Bus, type Envelope } from "./bus";

interface Client {
  ws: WebSocket;
  channel: Channel;
  operator: boolean; // authenticated as the host (gates operator-only WS actions)
}

/**
 * Connection hub. Broadcasts go out through the Bus (local loopback in a single
 * process, Redis pub/sub across instances) and are delivered to each instance's
 * own sockets. Spectator connections receive everything (spoiler events flagged
 * for the GM panel); player connections never receive spoiler events.
 *
 * A retained cache of sticky messages (lobby/scoreboard/speed/submissions) lets
 * any instance prime a newly-connected client with current state, even a gateway
 * that just booted (primed from the bus on startup).
 */
export class Hub {
  private clients = new Set<Client>();
  private retainedCache = new Map<string, ServerMessage>();

  constructor(private readonly bus: Bus) {
    bus.onMessage((env) => this.deliverLocal(env));
  }

  /** Load retained sticky state from the bus (call once on startup). */
  async prime(): Promise<void> {
    for (const env of await this.bus.retained()) {
      this.retainedCache.set(env.msg.type, env.msg);
    }
  }

  add(ws: WebSocket): Client {
    const client: Client = { ws, channel: "spectator", operator: false };
    this.clients.add(client);
    ws.on("close", () => this.clients.delete(client));
    return client;
  }

  setChannel(client: Client, channel: Channel): void {
    client.channel = channel;
  }

  setOperator(client: Client, operator: boolean): void {
    client.operator = operator;
  }

  send(ws: WebSocket, msg: ServerMessage): void {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  }

  /** Send the current retained sticky state to one socket (on connect). */
  sendRetained(ws: WebSocket): void {
    for (const msg of this.retainedCache.values()) this.send(ws, msg);
  }

  /**
   * Prime a newly-connected socket. If this instance's cache is still empty (a
   * gateway that booted before the primary wrote retained state), re-read it from
   * the bus first so the client isn't left with a blank dashboard.
   */
  primeAndSend(ws: WebSocket): void {
    if (this.retainedCache.size > 0) {
      this.sendRetained(ws);
      return;
    }
    this.prime()
      .then(() => this.sendRetained(ws))
      .catch((e) => console.error("[hub] prime on connect failed:", e));
  }

  broadcast(msg: ServerMessage): void {
    this.bus.publish({ target: "all", msg });
  }

  broadcastEvent(event: GameEvent): void {
    const spoiler = SPOILER_EVENTS.has(event.type);
    this.bus.publish({
      target: spoiler ? "spectator" : "all",
      msg: { type: "event", event, spoiler },
    });
  }

  toPlayers(msg: ServerMessage): void {
    this.bus.publish({ target: "player", msg });
  }

  /** Deliver a bus message to this instance's local sockets, with target filtering. */
  private deliverLocal(env: Envelope): void {
    if (RETAINED_TYPES.has(env.msg.type)) this.retainedCache.set(env.msg.type, env.msg);
    for (const c of this.clients) {
      if (env.target === "player" && c.channel !== "player") continue;
      if (env.target === "spectator" && c.channel === "player") continue;
      this.send(c.ws, env.msg);
    }
  }
}
