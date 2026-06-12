import fs from "node:fs";

export interface Persona {
  name: string;
  avatar: string;
  color: string;
  /** Markdown body (persona + strategy sections), injected verbatim into the system prompt. */
  body: string;
}

const DEFAULT_COLORS = [
  "#e8a0bf",
  "#7dd3fc",
  "#fbbf24",
  "#a3e635",
  "#f87171",
  "#c4b5fd",
  "#34d399",
  "#fb923c",
  "#f472b6",
  "#94a3b8",
];

export function defaultColor(index: number): string {
  return DEFAULT_COLORS[index % DEFAULT_COLORS.length];
}

/**
 * Parse persona markdown (YAML-ish frontmatter + body) from a string.
 * Dependency-free and forgiving. `source` is used only for error messages.
 *
 * Only the `name`, `avatar`, and `color` frontmatter keys are read — any other
 * keys an uploader includes are ignored, so a persona file can't smuggle in
 * extra machine-read config.
 */
export function parsePersona(raw: string, index = 0, source = "persona"): Persona {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) throw new Error(`${source} is missing --- frontmatter ---`);
  const [, front, body] = m;

  const fields: Record<string, string> = {};
  for (const line of front.split(/\r?\n/)) {
    const kv = line.match(/^(\w+)\s*:\s*(.*)$/);
    if (kv) fields[kv[1].toLowerCase()] = kv[2].trim().replace(/^["']|["']$/g, "");
  }
  if (!fields.name) throw new Error(`${source} has no "name" in frontmatter`);

  return {
    name: fields.name,
    avatar: fields.avatar || "🙂",
    color: fields.color || defaultColor(index),
    body: body.trim(),
  };
}

/** Parse a persona file from disk (trusted, operator-controlled `agents/` folder). */
export function loadPersona(path: string, index = 0): Persona {
  return parsePersona(fs.readFileSync(path, "utf8"), index, `Persona file ${path}`);
}
