import type { LLMConfig } from "../engine/config";
import { anthropicProvider } from "./anthropic";
import { openaiCompatProvider } from "./openai-compat";

export interface ChatMsg {
  role: "user" | "assistant";
  content: string;
}

/** The single seam between the game and any LLM. */
export interface LLMProvider {
  chat(system: string, messages: ChatMsg[]): Promise<string>;
}

export function createProvider(cfg: LLMConfig): LLMProvider {
  switch (cfg.provider) {
    case "anthropic":
      return anthropicProvider(cfg);
    case "openai":
    case "openrouter":
      return openaiCompatProvider(cfg);
    default:
      throw new Error(`Unknown provider: ${(cfg as LLMConfig).provider}`);
  }
}
