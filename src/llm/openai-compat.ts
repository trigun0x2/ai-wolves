import OpenAI from "openai";
import type { LLMConfig } from "../engine/config";
import type { ChatMsg, LLMProvider } from "./provider";
import { withRetry } from "./retry";

const OPENROUTER_BASE = "https://openrouter.ai/api/v1";

const clients = new Map<string, OpenAI>();
function getClient(provider: "openai" | "openrouter"): OpenAI {
  let c = clients.get(provider);
  if (!c) {
    c =
      provider === "openrouter"
        ? new OpenAI({
            baseURL: OPENROUTER_BASE,
            apiKey: process.env.OPENROUTER_API_KEY,
          })
        : new OpenAI(); // reads OPENAI_API_KEY from the environment
    clients.set(provider, c);
  }
  return c;
}

/** One code path for OpenAI and OpenRouter (OpenAI-compatible endpoint). */
export function openaiCompatProvider(cfg: LLMConfig): LLMProvider {
  const provider = cfg.provider as "openai" | "openrouter";
  return {
    async chat(system: string, messages: ChatMsg[]): Promise<string> {
      return withRetry(async () => {
        const res = await getClient(provider).chat.completions.create({
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
