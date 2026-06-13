import { describe, expect, it } from "vitest";
import { LocalBus, type Envelope } from "../src/server/bus";
import { Hub } from "../src/server/sockets";
import type { ServerMessage } from "../src/shared/types";

/** Minimal fake of the bits of `ws` the Hub uses. */
class FakeWS {
  readonly OPEN = 1;
  readyState = 1;
  sent: ServerMessage[] = [];
  private closers: (() => void)[] = [];
  send(raw: string) {
    this.sent.push(JSON.parse(raw));
  }
  on(ev: string, fn: () => void) {
    if (ev === "close") this.closers.push(fn);
  }
  close() {
    this.readyState = 3;
    this.closers.forEach((f) => f());
  }
}

const mkHub = () => new Hub(new LocalBus());
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const addClient = (hub: Hub, channel: "spectator" | "player") => {
  const ws = new FakeWS();
  const client = hub.add(ws as any);
  hub.setChannel(client, channel);
  return ws;
};

describe("LocalBus", () => {
  it("loops published messages back to the handler", () => {
    const bus = new LocalBus();
    const got: Envelope[] = [];
    bus.onMessage((e) => got.push(e));
    bus.publish({ target: "all", msg: { type: "speed", speed: 2 } });
    expect(got).toHaveLength(1);
    expect(got[0].msg).toEqual({ type: "speed", speed: 2 });
  });

  it("retains only sticky message types", async () => {
    const bus = new LocalBus();
    bus.onMessage(() => {});
    bus.publish({ target: "all", msg: { type: "speed", speed: 3 } });
    bus.publish({ target: "all", msg: { type: "error", message: "x" } });
    const retained = await bus.retained();
    const types = retained.map((e) => e.msg.type);
    expect(types).toContain("speed");
    expect(types).not.toContain("error"); // not sticky
  });
});

describe("Hub delivery", () => {
  it("broadcast reaches every local client", () => {
    const hub = mkHub();
    const spec = addClient(hub, "spectator");
    const player = addClient(hub, "player");
    hub.broadcast({ type: "speed", speed: 1.5 });
    expect(spec.sent.at(-1)).toEqual({ type: "speed", speed: 1.5 });
    expect(player.sent.at(-1)).toEqual({ type: "speed", speed: 1.5 });
  });

  it("spoiler events skip the player channel; non-spoiler reach all", () => {
    const hub = mkHub();
    const spec = addClient(hub, "spectator");
    const player = addClient(hub, "player");

    hub.broadcastEvent({ type: "night_action", player: "Bea", step: "seer", summary: "peeked" });
    expect(spec.sent.some((m) => m.type === "event")).toBe(true);
    expect(player.sent.some((m) => m.type === "event")).toBe(false); // spoiler → spectator only

    hub.broadcastEvent({ type: "chat", player: "Bea", text: "hi", round: 1 });
    expect(player.sent.some((m) => m.type === "event")).toBe(true); // non-spoiler → all
  });

  it("toPlayers reaches only player-channel clients", () => {
    const hub = mkHub();
    const spec = addClient(hub, "spectator");
    const player = addClient(hub, "player");
    hub.toPlayers({ type: "your_turn", kind: "chat", prompt: "go", timeoutMs: 1000 });
    expect(player.sent.some((m) => m.type === "your_turn")).toBe(true);
    expect(spec.sent.some((m) => m.type === "your_turn")).toBe(false);
  });

  it("primes a newly-connected socket with retained sticky state", () => {
    const hub = mkHub();
    hub.broadcast({ type: "speed", speed: 2.5 }); // becomes retained
    const late = addClient(hub, "spectator");
    late.sent = []; // ignore anything from add()
    hub.sendRetained(late as any);
    expect(late.sent.some((m) => m.type === "speed" && m.speed === 2.5)).toBe(true);
  });

  it("stops delivering to a closed socket", () => {
    const hub = mkHub();
    const ws = addClient(hub, "spectator");
    ws.close();
    const before = ws.sent.length;
    hub.broadcast({ type: "speed", speed: 1 });
    expect(ws.sent.length).toBe(before); // removed on close
  });
});
