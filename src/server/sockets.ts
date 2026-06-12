import type { WebSocket } from "ws";
import {
  SPOILER_EVENTS,
  type Channel,
  type GameEvent,
  type ServerMessage,
} from "../shared/types";

interface Client {
  ws: WebSocket;
  channel: Channel;
}

/**
 * Connection hub. Spectator connections receive everything (spoiler events are
 * flagged so the dashboard's GM panel can show/hide them). Player connections
 * (the human seat) never receive spoiler events — the human must not see the
 * deal or night actions.
 */
export class Hub {
  private clients = new Set<Client>();

  add(ws: WebSocket): Client {
    const client: Client = { ws, channel: "spectator" };
    this.clients.add(client);
    ws.on("close", () => this.clients.delete(client));
    return client;
  }

  setChannel(client: Client, channel: Channel): void {
    client.channel = channel;
  }

  send(ws: WebSocket, msg: ServerMessage): void {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  }

  broadcast(msg: ServerMessage): void {
    for (const c of this.clients) this.send(c.ws, msg);
  }

  broadcastEvent(event: GameEvent): void {
    const spoiler = SPOILER_EVENTS.has(event.type);
    const msg: ServerMessage = { type: "event", event, spoiler };
    for (const c of this.clients) {
      if (spoiler && c.channel === "player") continue;
      this.send(c.ws, msg);
    }
  }

  toPlayers(msg: ServerMessage): void {
    for (const c of this.clients) {
      if (c.channel === "player") this.send(c.ws, msg);
    }
  }
}
