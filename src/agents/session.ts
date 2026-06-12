import type { PublicPlayer } from "../shared/types";
import type { DecisionSchema, PlayerController } from "../engine/controller";
import type { ChatMsg, LLMProvider } from "../llm/provider";
import * as P from "./prompts";

export interface LLMCallLog {
  agent: string;
  prompt: string; // the user message that triggered this call
  response: string;
  error?: string;
}

/**
 * One isolated conversation per agent per game.
 *
 * Information isolation is structural: this class holds the ONLY message array
 * for this agent, and the engine can only add to it via notify()/decide()/speak().
 * Nothing here references any other player's session or the engine's hidden state.
 */
export class AgentSession implements PlayerController {
  readonly name: string;
  private messages: ChatMsg[] = [];
  private pending: string[] = []; // [GAME]/[CHAT] lines buffered until the next ask

  constructor(
    readonly profile: PublicPlayer,
    private readonly systemPrompt: string,
    private readonly provider: LLMProvider,
    private readonly onLog?: (entry: LLMCallLog) => void,
  ) {
    this.name = profile.name;
  }

  notify(text: string): void {
    this.pending.push(text);
  }

  /** Full conversation (for the transcript). */
  getConversation(): { system: string; messages: ChatMsg[] } {
    return { system: this.systemPrompt, messages: [...this.messages] };
  }

  private flush(prompt: string): string {
    const content = [...this.pending, prompt].join("\n\n");
    this.pending = [];
    this.messages.push({ role: "user", content });
    return content;
  }

  private async complete(triggeringPrompt: string): Promise<string> {
    try {
      const text = await this.provider.chat(this.systemPrompt, this.messages);
      this.messages.push({ role: "assistant", content: text });
      this.onLog?.({ agent: this.name, prompt: triggeringPrompt, response: text });
      return text;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.onLog?.({ agent: this.name, prompt: triggeringPrompt, response: "", error: msg });
      throw err;
    }
  }

  async speak(prompt: string): Promise<string | null> {
    const sent = this.flush(prompt);
    try {
      return await this.complete(sent);
    } catch {
      // Keep the conversation consistent: pretend the fallback line was said.
      this.messages.push({ role: "assistant", content: P.FALLBACK_CHAT });
      return P.FALLBACK_CHAT;
    }
  }

  async decide<T>(prompt: string, schema: DecisionSchema<T>): Promise<T | null> {
    let sent = this.flush(prompt);
    for (let attempt = 0; attempt < 3; attempt++) {
      let raw: string;
      try {
        raw = await this.complete(sent);
      } catch {
        return null; // provider down after retries → engine treats as a pass
      }
      const parsed = extractJson(raw);
      if (parsed !== null) {
        const value = schema.parse(parsed);
        if (value !== null) return value;
      }
      sent = P.malformed(schema.hint);
      this.messages.push({ role: "user", content: sent });
    }
    return null;
  }
}

/** Pull the first JSON object out of a model reply (tolerates prose around it). */
export function extractJson(raw: string): unknown | null {
  const t = raw.trim();
  try {
    return JSON.parse(t);
  } catch {
    /* fall through */
  }
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  // Try progressively shorter candidates ending at each '}' from the last one back.
  for (let e = end; e > start; e = t.lastIndexOf("}", e - 1)) {
    try {
      return JSON.parse(t.slice(start, e + 1));
    } catch {
      /* keep trying */
    }
    if (e <= start) break;
  }
  return null;
}
