import crypto from "node:crypto";
import type { LLMConfig, ProviderName } from "../engine/config";
import type { Persona } from "../agents/personas";
import type { SubmissionPublic } from "../shared/types";
import type { KvStore } from "./store";

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
 *  - The queue and pasted (raw) keys live ONLY in memory. OAuth credentials are
 *    additionally persisted to the durable store (keyed by the opaque keyRef) so
 *    a contributor stays connected across server restarts without re-authorizing
 *    — these are user-scoped OpenRouter tokens, never the host key or a master key.
 */

const CRED_TTL_MS = 30 * 60 * 1000; // unconsumed credential refs (pre-submit)
const QUEUE_TTL_MS = 2 * 60 * 60 * 1000; // queued agents, refreshed on each draw
const OAUTH_TTL_MS = 7 * 24 * 60 * 60 * 1000; // persisted OAuth credentials
const oauthKey = (keyRef: string) => `oauth:${keyRef}`;

interface StoredOAuth {
  provider: ProviderName;
  key: string;
  createdAt: number;
}

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
  private store?: KvStore;

  /** Attach the durable store used to persist OAuth credentials across restarts. */
  attachStore(store: KvStore): void {
    this.store = store;
  }

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

  /** Record the key obtained from the OAuth exchange (and persist it durably). */
  attachKey(keyRef: string, key: string): boolean {
    const c = this.creds.get(keyRef);
    if (!c) return false;
    c.key = key;
    // Persist OAuth credentials so they survive restarts (scoped tokens only).
    this.store
      ?.setJson(oauthKey(keyRef), { provider: c.provider, key, createdAt: Date.now() } satisfies StoredOAuth)
      .catch((e) => console.error("[byo] persist oauth:", e));
    return true;
  }

  /** A credential is "ready" once it holds a key — in memory or in durable storage. */
  async isReady(keyRef: string): Promise<boolean> {
    return !!(await this.resolve(keyRef));
  }

  /**
   * Resolve a credential by ref: memory first, then the durable store (rehydrating
   * a persisted OAuth credential into memory). Returns null if missing/expired.
   */
  private async resolve(keyRef: string): Promise<Credential | null> {
    const mem = this.creds.get(keyRef);
    if (mem?.key) return mem;
    if (!this.store) return null;
    const saved = await this.store.getJson<StoredOAuth>(oauthKey(keyRef));
    if (!saved?.key || Date.now() - saved.createdAt > OAUTH_TTL_MS) return null;
    const cred: Credential = { provider: saved.provider, key: saved.key, createdAt: saved.createdAt };
    this.creds.set(keyRef, cred); // rehydrate for subsequent lookups
    return cred;
  }

  // ---- submissions ----

  /** Build a submission from a validated persona + a ready credential ref. Throws on a bad ref. */
  async addSubmission(
    persona: Persona,
    keyRef: string,
    model: string,
    baseURL?: string,
  ): Promise<SeatSubmission> {
    const cred = await this.resolve(keyRef);
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
