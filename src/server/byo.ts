import crypto from "node:crypto";
import type { LLMConfig, ProviderName } from "../engine/config";
import type { Persona } from "../agents/personas";
import type { SubmissionPublic } from "../shared/types";

/**
 * In-memory queue for "bring your own player" agents.
 *
 * Agents queue up and persist across games; when a game starts, a random subset
 * is drawn to fill the seats (the queue is NOT consumed — drawn agents stay in
 * the queue and can be drawn again).
 *
 * SECURITY MODEL:
 *  - API keys live ONLY here, in memory, keyed by an opaque `keyRef`. The
 *    contributor's browser only ever holds the keyRef, never the key itself —
 *    not even for keys they typed (those are POSTed once and exchanged for a ref).
 *  - For OpenRouter OAuth, the key is fetched server-side and stashed under the
 *    same ref; it never transits the browser.
 *  - Nothing here is written to disk or logged. Entries are swept on an idle TTL
 *    (refreshed whenever an agent is drawn into a game), so a long-running queue
 *    drops only the agents that have gone quiet.
 */

const CRED_TTL_MS = 30 * 60 * 1000; // unconsumed credential refs (pre-submit)
const QUEUE_TTL_MS = 2 * 60 * 60 * 1000; // queued agents, refreshed on each draw

interface Credential {
  provider: ProviderName;
  model?: string;
  key?: string; // resolved API key (raw-paste, or post-OAuth)
  verifier?: string; // PKCE code_verifier, present until the OAuth exchange completes
  createdAt: number;
}

export interface SeatSubmission {
  id: string;
  persona: Persona;
  llm: LLMConfig; // includes the ephemeral apiKey/baseURL — never serialized
  createdAt: number;
  lastActive: number; // refreshed whenever drawn into a game
}

function ref(): string {
  return crypto.randomBytes(16).toString("hex");
}

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** PKCE pair: verifier + S256 challenge. */
export function pkce(): { verifier: string; challenge: string } {
  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

export class ByoStore {
  private creds = new Map<string, Credential>();
  private subs = new Map<string, SeatSubmission>();

  // ---- credentials ----

  /** Stash a raw pasted key, return its opaque ref. */
  putRawKey(provider: ProviderName, key: string, model?: string): string {
    const r = ref();
    this.creds.set(r, { provider, key, model, createdAt: Date.now() });
    return r;
  }

  /** Begin an OpenRouter OAuth handshake: store the verifier, return ref + challenge. */
  startOAuth(): { keyRef: string; challenge: string } {
    const { verifier, challenge } = pkce();
    const r = ref();
    this.creds.set(r, { provider: "openrouter", verifier, createdAt: Date.now() });
    return { keyRef: r, challenge };
  }

  /**
   * Read and CONSUME the PKCE verifier for an OAuth exchange (one-shot). Clearing
   * it means a replayed callback can't trigger another outbound token exchange.
   */
  takeVerifier(keyRef: string): string | null {
    const c = this.creds.get(keyRef);
    if (!c?.verifier) return null;
    const v = c.verifier;
    c.verifier = undefined;
    return v;
  }

  /** Record the key obtained from the OAuth exchange. */
  attachKey(keyRef: string, key: string): boolean {
    const c = this.creds.get(keyRef);
    if (!c) return false;
    c.key = key;
    return true;
  }

  /** A credential is "ready" once it actually holds a key. */
  isReady(keyRef: string): boolean {
    return !!this.creds.get(keyRef)?.key;
  }

  private resolve(keyRef: string): Credential | null {
    const c = this.creds.get(keyRef);
    return c?.key ? c : null;
  }

  // ---- submissions ----

  /** Build a submission from a validated persona + a ready credential ref. Throws on a bad ref. */
  addSubmission(persona: Persona, keyRef: string, model: string, baseURL?: string): SeatSubmission {
    const cred = this.resolve(keyRef);
    if (!cred) throw new Error("credential not connected (connect your model first)");
    const llm: LLMConfig = {
      provider: cred.provider,
      model: model || cred.model || "",
      apiKey: cred.key,
      ...(baseURL ? { baseURL } : {}),
    };
    if (!llm.model) throw new Error("pick a model");
    const now = Date.now();
    const sub: SeatSubmission = { id: ref(), persona, llm, createdAt: now, lastActive: now };
    this.subs.set(sub.id, sub);
    return sub;
  }

  removeSubmission(id: string): boolean {
    return this.subs.delete(id);
  }

  /**
   * Randomly draw up to `n` queued agents to seat in a game and REMOVE them from
   * the queue — an agent plays once per join, then must re-join to play again.
   */
  draw(n: number, rng: () => number = Math.random): SeatSubmission[] {
    const pool = [...this.subs.values()];
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    const drawn = pool.slice(0, n);
    for (const s of drawn) this.subs.delete(s.id);
    return drawn;
  }

  /** Host-facing list — persona preview and model label, NEVER the key. */
  listPublic(): SubmissionPublic[] {
    return [...this.subs.values()]
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((s) => ({
        id: s.id,
        name: s.persona.name,
        avatar: s.persona.avatar,
        color: s.persona.color,
        provider: s.llm.provider,
        model: s.llm.model,
        personaPreview: s.persona.body.slice(0, 140),
      }));
  }

  all(): SeatSubmission[] {
    return [...this.subs.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  count(): number {
    return this.subs.size;
  }

  /** Drop idle queued agents and stale unconsumed credential refs. */
  sweep(): void {
    const now = Date.now();
    for (const [k, c] of this.creds) {
      if (now - c.createdAt > CRED_TTL_MS) this.creds.delete(k);
    }
    for (const [k, s] of this.subs) {
      if (now - s.lastActive > QUEUE_TTL_MS) this.subs.delete(k);
    }
  }
}
