import OpenAI from "openai";
import type { LLMConfig } from "../engine/config";
import type { ChatMsg, LLMProvider } from "./provider";
import { withRetry } from "./retry";

const OPENROUTER_BASE = "https://openrouter.ai/api/v1";

// Host default clients (env keys), one per provider, built once and reused.
const hostClients = new Map<string, OpenAI>();
function getHostClient(provider: "openai" | "openrouter"): OpenAI {
  let c = hostClients.get(provider);
  if (!c) {
    c =
      provider === "openrouter"
        ? new OpenAI({ baseURL: OPENROUTER_BASE, apiKey: process.env.OPENROUTER_API_KEY })
        : new OpenAI(); // reads OPENAI_API_KEY from the environment
    hostClients.set(provider, c);
  }
  return c;
}

/**
 * Resolve the client for a config. A per-agent `apiKey`/`baseURL` (bring-your-own)
 * builds a fresh client scoped to that agent; keys are never cached by value.
 */
function clientFor(cfg: LLMConfig, provider: "openai" | "openrouter"): OpenAI {
  if (cfg.apiKey || cfg.baseURL) {
    const baseURL = cfg.baseURL ?? (provider === "openrouter" ? OPENROUTER_BASE : undefined);
    return new OpenAI({ apiKey: cfg.apiKey, ...(baseURL ? { baseURL } : {}) });
  }
  return getHostClient(provider);
}

/** One code path for OpenAI and OpenRouter (OpenAI-compatible endpoint). */
export function openaiCompatProvider(cfg: LLMConfig): LLMProvider {
  const provider = cfg.provider as "openai" | "openrouter";
  const client = clientFor(cfg, provider);
  return {
    async chat(system: string, messages: ChatMsg[]): Promise<string> {
      return withRetry(async () => {
        const res = await client.chat.completions.create({
          model: cfg.model,
          messages: [
            { role: "system", content: system },
            ...messages.map((m) => ({ role: m.role, content: m.content })),
          ],
        });
        const text = res.choices[0]?.message?.content;
        if (!text) throw new Error("empty completion");
        return text.trim();
      });
    },
  };
}
