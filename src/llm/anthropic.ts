import Anthropic from "@anthropic-ai/sdk";
import type { LLMConfig } from "../engine/config";
import type { ChatMsg, LLMProvider } from "./provider";
import { withRetry } from "./retry";

// Host default client (env key), built once and reused.
let hostClient: Anthropic | null = null;
function getHostClient(): Anthropic {
  hostClient ??= new Anthropic(); // reads ANTHROPIC_API_KEY from the environment
  return hostClient;
}

/**
 * Resolve the client for a config. A per-agent `apiKey` (bring-your-own) builds a
 * fresh, throwaway client scoped to that agent so one player's key is never reused
 * for another's. Keys are never cached by value.
 */
function clientFor(cfg: LLMConfig): Anthropic {
  if (cfg.apiKey || cfg.baseURL) {
    return new Anthropic({
      apiKey: cfg.apiKey,
      ...(cfg.baseURL ? { baseURL: cfg.baseURL } : {}),
    });
  }
  return getHostClient();
}

export function anthropicProvider(cfg: LLMConfig): LLMProvider {
  const client = clientFor(cfg);
  return {
    async chat(system: string, messages: ChatMsg[]): Promise<string> {
      return withRetry(async () => {
        const params: Anthropic.MessageCreateParams = {
          model: cfg.model,
          // Responses are short chat lines or small JSON; cap output (covers
          // adaptive thinking too) to keep replies brief and bound cost.
          max_tokens: 2000,
          // The system prompt is identical for every call an agent makes in a
          // game — cache it so each turn only pays for the new suffix.
          system: [
            {
              type: "text",
              text: system,
              cache_control: { type: "ephemeral" },
            },
          ],
          messages,
        };
        // Adaptive thinking (default on). Disable per-agent in config for
        // models that don't support it.
        if (cfg.thinking !== false) {
          params.thinking = { type: "adaptive" };
        }
        if (cfg.effort) {
          params.output_config = {
            effort: cfg.effort as "low" | "medium" | "high" | "max",
          };
        }
        const res = await client.messages.create(params);
        if (res.stop_reason === "refusal") {
          throw Object.assign(new Error("model refused"), { status: 400 });
        }
        return res.content
          .filter((b): b is Anthropic.TextBlock => b.type === "text")
          .map((b) => b.text)
          .join("\n")
          .trim();
      });
    },
  };
}
