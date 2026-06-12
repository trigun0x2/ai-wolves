import type { PublicPlayer, UIOption } from "../shared/types";

/**
 * A decision schema validates a structured decision and carries everything the
 * UI (human seat) and re-ask loop (agents) need to render/repair it.
 */
export interface DecisionSchema<T> {
  /** Shown to agents on a malformed reply, e.g. `e.g. {"vote":"Maya"}`. */
  hint: string;
  /** Pre-built options so the human seat can render buttons. */
  options: UIOption[];
  /** Returns the parsed decision, or null if invalid. */
  parse(value: unknown): T | null;
}

/**
 * One seat at the table. Implemented by AgentSession (LLM) and HumanController (WS).
 * The engine only ever talks to seats through this interface — there is no path
 * for one seat's private information to reach another.
 */
export interface PlayerController {
  readonly name: string;
  readonly profile: PublicPlayer;

  /** Deliver private context ([GAME]/[CHAT] lines). No response expected. */
  notify(text: string): void;

  /** Ask for a structured decision. Resolves null on pass/failure (engine handles fallback). */
  decide<T>(prompt: string, schema: DecisionSchema<T>): Promise<T | null>;

  /** Ask for a public chat message. Resolves null if the seat passes. */
  speak(prompt: string): Promise<string | null>;
}
