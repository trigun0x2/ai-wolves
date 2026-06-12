import type { PublicPlayer, ServerMessage } from "../shared/types";
import type { DecisionSchema, PlayerController } from "../engine/controller";

/**
 * The human seat. Same PlayerController interface as an agent — the engine
 * cannot tell the difference, and neither can the other players.
 */
export class HumanController implements PlayerController {
  readonly name: string;
  private pending: {
    resolve: (value: unknown) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;

  constructor(
    readonly profile: PublicPlayer,
    private readonly timeoutMs: number,
    private readonly send: (msg: ServerMessage) => void,
  ) {
    this.name = profile.name;
  }

  notify(text: string): void {
    this.send({ type: "private_info", text });
  }

  /** Route an input from the player's websocket to whatever turn is waiting. */
  handleInput(value: unknown): void {
    if (!this.pending) return;
    clearTimeout(this.pending.timer);
    const { resolve } = this.pending;
    this.pending = null;
    this.send({ type: "turn_over" });
    resolve(value);
  }

  private await_(msg: ServerMessage): Promise<unknown> {
    return new Promise((resolve) => {
      // Cancel any orphaned turn (shouldn't happen — engine is sequential per seat).
      if (this.pending) clearTimeout(this.pending.timer);
      const timer = setTimeout(() => {
        this.pending = null;
        this.send({ type: "turn_over" });
        resolve(null);
      }, this.timeoutMs);
      this.pending = { resolve, timer };
      this.send(msg);
    });
  }

  async decide<T>(prompt: string, schema: DecisionSchema<T>): Promise<T | null> {
    const value = await this.await_({
      type: "your_turn",
      kind: "decision",
      prompt,
      options: schema.options,
      timeoutMs: this.timeoutMs,
    });
    if (value === null) return null;
    return schema.parse(value);
  }

  async speak(prompt: string): Promise<string | null> {
    const value = await this.await_({
      type: "your_turn",
      kind: "chat",
      prompt,
      timeoutMs: this.timeoutMs,
    });
    return typeof value === "string" && value.trim() ? value : null;
  }
}
