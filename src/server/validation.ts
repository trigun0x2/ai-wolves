import { parsePersona } from "../agents/personas";
import type { Persona } from "../agents/personas";

export const LIMITS = {
  nameMax: 24,
  avatarMax: 8,
  bodyMax: 4000, // chars — also bounds per-call token cost for BYO spenders
  bodyMin: 10,
};

export type ValidationResult =
  | { ok: true; persona: Persona }
  | { ok: false; error: string };

/** Remove control characters except newline (\n, 0x0A) and tab (\t, 0x09). */
function stripControl(s: string): string {
  let out = "";
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    if (c === 9 || c === 10 || c >= 32) out += ch;
  }
  return out;
}

/**
 * Validate and normalize an uploaded persona submission. Treats every field as
 * untrusted input: caps lengths, strips control characters, and rejects empties.
 * Returns a parsed Persona ready to drop into the system prompt, or an error.
 */
export function validateSubmittedPersona(
  input: { name?: unknown; avatar?: unknown; color?: unknown; body?: unknown },
  index = 0,
): ValidationResult {
  const name = stripControl(String(input.name ?? "")).trim();
  if (!name) return { ok: false, error: "name is required" };
  if (name.length > LIMITS.nameMax) {
    return { ok: false, error: `name must be ≤ ${LIMITS.nameMax} characters` };
  }

  const body = stripControl(String(input.body ?? "")).trim();
  if (body.length < LIMITS.bodyMin) {
    return { ok: false, error: "persona description is too short" };
  }
  if (body.length > LIMITS.bodyMax) {
    return { ok: false, error: `persona description must be ≤ ${LIMITS.bodyMax} characters` };
  }

  const avatarRaw = stripControl(String(input.avatar ?? "")).trim();
  const avatar = avatarRaw.slice(0, LIMITS.avatarMax) || "🙂";

  const colorRaw = String(input.color ?? "").trim();
  const color = /^#[0-9a-fA-F]{6}$/.test(colorRaw) ? colorRaw : "";

  // Reassemble a clean persona-file string and run it through the same parser the
  // trusted agents/*.md files use — single code path, no special-casing.
  const md = `---\nname: ${name}\navatar: ${avatar}${color ? `\ncolor: "${color}"` : ""}\n---\n${body}`;
  try {
    return { ok: true, persona: parsePersona(md, index, "submitted persona") };
  } catch (err) {
    return { ok: false, error: String(err instanceof Error ? err.message : err) };
  }
}
