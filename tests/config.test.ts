import { afterEach, describe, expect, it } from "vitest";
import { resolveDefaultLLM } from "../src/engine/config";

const KEYS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY"] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
const clear = () => KEYS.forEach((k) => delete process.env[k]);

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("resolveDefaultLLM provider priority", () => {
  it("prefers Anthropic when its key is set (even alongside others)", () => {
    clear();
    process.env.ANTHROPIC_API_KEY = "a";
    process.env.OPENAI_API_KEY = "b";
    process.env.OPENROUTER_API_KEY = "c";
    const r = resolveDefaultLLM({ effort: "low" });
    expect(r.provider).toBe("anthropic");
    expect(r.model).toBe("claude-opus-4-8");
    expect(r.effort).toBe("low");
  });

  it("falls through to OpenAI when Anthropic is absent", () => {
    clear();
    process.env.OPENAI_API_KEY = "b";
    process.env.OPENROUTER_API_KEY = "c";
    const r = resolveDefaultLLM();
    expect(r.provider).toBe("openai");
    expect(r.model).toBe("gpt-4.1");
    expect(r.effort).toBeUndefined(); // effort is Anthropic-only
  });

  it("uses OpenRouter when it's the only key", () => {
    clear();
    process.env.OPENROUTER_API_KEY = "c";
    expect(resolveDefaultLLM().provider).toBe("openrouter");
  });

  it("falls back to anthropic when no key is set", () => {
    clear();
    expect(resolveDefaultLLM().provider).toBe("anthropic");
  });

  it("honors an explicitly pinned provider+model (skips auto-select)", () => {
    clear();
    process.env.ANTHROPIC_API_KEY = "a";
    const r = resolveDefaultLLM({ provider: "openai", model: "gpt-4.1-mini" });
    expect(r.provider).toBe("openai");
    expect(r.model).toBe("gpt-4.1-mini");
  });

  it("config model/effort/thinking override the resolved defaults", () => {
    clear();
    process.env.OPENAI_API_KEY = "b";
    const r = resolveDefaultLLM({ model: "gpt-4.1-mini", thinking: false });
    expect(r.provider).toBe("openai");
    expect(r.model).toBe("gpt-4.1-mini");
    expect(r.thinking).toBe(false);
  });
});
