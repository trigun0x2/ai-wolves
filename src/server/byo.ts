import crypto from "node:crypto";
import type { LLMConfig, ProviderName } from "../engine/config";
import type { Persona } from "../agents/personas";
import type { SubmissionPublic } from "../shared/types";

/**
 * In-memory store for "bring your own player" submissions.
 *
 * SECURITY MODEL:
 *  - API keys live ONLY here, in memory, keyed by an opaque `keyRef`. The
 *    contributor's browser only ever holds the keyRef, never the key itself —
 *    not even for keys they typed (those are POSTed once and exchanged for a ref).
 *  - For OpenRouter OAuth, the key is fetched server-side and stashed under the
 *    same ref; it never transits the browser.
 *  - Nothing here is written to disk or logged. Everything is cleared between
 *    games and swept on a TTL.
 */

const TTL_MS = 30 * 60 * 1000;

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

  getVerifier(keyRef: string): string | null {
    return this.creds.get(keyRef)?.verifier ?? null;
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
    const sub: SeatSubmission = { id: ref(), persona, llm, createdAt: Date.now() };
    this.subs.set(sub.id, sub);
    return sub;
  }

  removeSubmission(id: string): boolean {
    return this.subs.delete(id);
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

  /** Clear submissions + the credentials they consumed (call after a game starts/ends). */
  clearSubmissions(): void {
    this.subs.clear();
    this.creds.clear();
  }

  /** Drop entries older than the TTL. */
  sweep(): void {
    const cutoff = Date.now() - TTL_MS;
    for (const [k, c] of this.creds) if (c.createdAt < cutoff) this.creds.delete(k);
    for (const [k, s] of this.subs) if (s.createdAt < cutoff) this.subs.delete(k);
  }
}
