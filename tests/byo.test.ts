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
});
