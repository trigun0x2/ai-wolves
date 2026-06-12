import { describe, expect, it } from "vitest";
import { validateSubmittedPersona, LIMITS } from "../src/server/validation";
import { ByoStore } from "../src/server/byo";

describe("validateSubmittedPersona", () => {
  it("accepts a well-formed submission and parses it", () => {
    const r = validateSubmittedPersona({
      name: "Barista Bea",
      avatar: "☕",
      color: "#7dd3fc",
      body: "A calm barista who treats werewolf like latte art.",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.persona.name).toBe("Barista Bea");
      expect(r.persona.avatar).toBe("☕");
      expect(r.persona.color).toBe("#7dd3fc");
      expect(r.persona.body).toContain("latte art");
    }
  });

  it("rejects empty name and too-short body", () => {
    expect(validateSubmittedPersona({ name: "", body: "x".repeat(20) }).ok).toBe(false);
    expect(validateSubmittedPersona({ name: "A", body: "short" }).ok).toBe(false);
  });

  it("caps body length", () => {
    const r = validateSubmittedPersona({ name: "A", body: "x".repeat(LIMITS.bodyMax + 1) });
    expect(r.ok).toBe(false);
  });

  it("strips control characters from the body (injection-hardening hygiene)", () => {
    const r = validateSubmittedPersona({
      name: "A",
      body: "line one\x00\x07 still here\nline two",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.persona.body).not.toContain("\x00");
      expect(r.persona.body).toContain("line one");
      expect(r.persona.body).toContain("line two");
    }
  });

  it("falls back to a default avatar/color when omitted or malformed", () => {
    const r = validateSubmittedPersona({ name: "A", body: "a valid body here", color: "not-a-hex" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.persona.avatar).toBeTruthy();
      expect(r.persona.color).toMatch(/^#/);
    }
  });

  it("clamps an over-long avatar", () => {
    const r = validateSubmittedPersona({ name: "A", body: "a valid body here", avatar: "😀😀😀😀😀😀" });
    expect(r.ok).toBe(true);
    if (r.ok) expect([...r.persona.avatar].length).toBeLessThanOrEqual(LIMITS.avatarMax);
  });
});

describe("ByoStore", () => {
  it("exchanges a raw key for a ref and resolves it into a submission llm", () => {
    const store = new ByoStore();
    const keyRef = store.putRawKey("openai", "sk-secret", "gpt-4.1");
    expect(store.isReady(keyRef)).toBe(true);

    const v = validateSubmittedPersona({ name: "Bea", body: "a valid persona body" });
    if (!v.ok) throw new Error(v.error);
    const sub = store.addSubmission(v.persona, keyRef, "gpt-4.1");
    expect(sub.llm.provider).toBe("openai");
    expect(sub.llm.model).toBe("gpt-4.1");
    expect(sub.llm.apiKey).toBe("sk-secret");

    // Public view must never leak the key.
    const pub = store.listPublic();
    expect(pub).toHaveLength(1);
    expect(JSON.stringify(pub)).not.toContain("sk-secret");
  });

  it("OAuth flow: verifier first, key attached on callback, then ready", () => {
    const store = new ByoStore();
    const { keyRef, challenge } = store.startOAuth();
    expect(challenge).toBeTruthy();
    expect(store.isReady(keyRef)).toBe(false); // not ready until the exchange
    expect(store.getVerifier(keyRef)).toBeTruthy();

    store.attachKey(keyRef, "sk-or-from-oauth");
    expect(store.isReady(keyRef)).toBe(true);

    const v = validateSubmittedPersona({ name: "Vee", body: "a valid persona body" });
    if (!v.ok) throw new Error(v.error);
    const sub = store.addSubmission(v.persona, keyRef, "anthropic/claude-opus-4-8");
    expect(sub.llm.provider).toBe("openrouter");
    expect(sub.llm.apiKey).toBe("sk-or-from-oauth");
  });

  it("rejects a submission with an unconnected credential ref", () => {
    const store = new ByoStore();
    const v = validateSubmittedPersona({ name: "Nope", body: "a valid persona body" });
    if (!v.ok) throw new Error(v.error);
    expect(() => store.addSubmission(v.persona, "bogus-ref", "m")).toThrow();
    // an OAuth ref with no key yet is also not usable
    const { keyRef } = store.startOAuth();
    expect(() => store.addSubmission(v.persona, keyRef, "m")).toThrow();
  });

  it("clearSubmissions wipes submissions and credentials", () => {
    const store = new ByoStore();
    const keyRef = store.putRawKey("anthropic", "sk-x");
    const v = validateSubmittedPersona({ name: "Z", body: "a valid persona body" });
    if (!v.ok) throw new Error(v.error);
    store.addSubmission(v.persona, keyRef, "claude-opus-4-8");
    expect(store.count()).toBe(1);
    store.clearSubmissions();
    expect(store.count()).toBe(0);
    expect(store.isReady(keyRef)).toBe(false);
  });

  it("draw removes the drawn agents from the queue (consumed after playing)", () => {
    const store = new ByoStore();
    for (let i = 0; i < 6; i++) {
      const kr = store.putRawKey("openrouter", `sk-${i}`);
      const v = validateSubmittedPersona({ name: `Agent ${i}`, body: "a valid persona body" });
      if (!v.ok) throw new Error(v.error);
      store.addSubmission(v.persona, kr, "some/model");
    }
    const drawn = store.draw(3);
    expect(drawn).toHaveLength(3);
    // Drawn agents are consumed — only the undrawn remain queued.
    expect(store.count()).toBe(3);
    expect(drawn.every((d) => typeof d.llm.apiKey === "string")).toBe(true);
    // The remaining 3 are exactly the ones not drawn.
    const drawnNames = new Set(drawn.map((d) => d.persona.name));
    expect(store.listPublic().every((s) => !drawnNames.has(s.name))).toBe(true);

    // Drawing again pulls only from what's left.
    const next = store.draw(5);
    expect(next).toHaveLength(3);
    expect(store.count()).toBe(0);
  });

  it("draw returns everything when fewer agents than seats, emptying the queue", () => {
    const store = new ByoStore();
    const kr = store.putRawKey("openai", "sk-1");
    const v = validateSubmittedPersona({ name: "Solo", body: "a valid persona body" });
    if (!v.ok) throw new Error(v.error);
    store.addSubmission(v.persona, kr, "gpt-4.1");
    expect(store.draw(5)).toHaveLength(1);
    expect(store.count()).toBe(0);
  });
});

describe("Leaderboard", () => {
  it("accumulates wins/games and persists across instances via the store", async () => {
    const { Leaderboard } = await import("../src/server/leaderboard");
    const { KvStore } = await import("./helpers");

    // In-memory store stands in for Redis/file; the point is persistence survives
    // a fresh Leaderboard reading the same store.
    const store = new KvStore();
    const lb = new Leaderboard(store);
    await lb.init();
    await lb.record(
      [
        { name: "Bea", model: "anthropic:claude-opus-4-8" },
        { name: "Reg", model: "openai:gpt-4.1" },
      ],
      ["Bea"],
    );
    await lb.record(
      [
        { name: "Bea", model: "anthropic:claude-opus-4-8" },
        { name: "Reg", model: "openai:gpt-4.1" },
      ],
      ["Reg"],
    );
    expect(lb.games()).toBe(2);

    const reloaded = new Leaderboard(store);
    await reloaded.init();
    expect(reloaded.games()).toBe(2);
    const rows = reloaded.list();
    const bea = rows.find((r) => r.name === "Bea")!;
    expect(bea.wins).toBe(1);
    expect(bea.games).toBe(2);
    expect(bea.lastModel).toBe("anthropic:claude-opus-4-8");
    expect(rows.map((r) => r.name)).toEqual(["Bea", "Reg"]);
  });
});
