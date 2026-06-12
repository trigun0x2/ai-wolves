import Anthropic from "@anthropic-ai/sdk";
import type { LLMConfig } from "../engine/config";
import type { ChatMsg, LLMProvider } from "./provider";
import { withRetry } from "./retry";

let client: Anthropic | null = null;
function getClient(): Anthropic {
  client ??= new Anthropic(); // reads ANTHROPIC_API_KEY from the environment
  return client;
}

export function anthropicProvider(cfg: LLMConfig): LLMProvider {
  return {
    async chat(system: string, messages: ChatMsg[]): Promise<string> {
      return withRetry(async () => {
        const params: Anthropic.MessageCreateParams = {
          model: cfg.model,
          max_tokens: 8000,
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
        const res = await getClient().messages.create(params);
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
