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

/**
 * Parse a persona file: YAML-ish frontmatter (name/avatar/color) + markdown body.
 * Kept dependency-free and forgiving — bad files fail loudly with the path.
 */
export function loadPersona(path: string, index = 0): Persona {
  const raw = fs.readFileSync(path, "utf8");
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) throw new Error(`Persona file ${path} is missing --- frontmatter ---`);
  const [, front, body] = m;

  const fields: Record<string, string> = {};
  for (const line of front.split(/\r?\n/)) {
    const kv = line.match(/^(\w+)\s*:\s*(.*)$/);
    if (kv) fields[kv[1].toLowerCase()] = kv[2].trim().replace(/^["']|["']$/g, "");
  }
  if (!fields.name) throw new Error(`Persona file ${path} has no "name" in frontmatter`);

  return {
    name: fields.name,
    avatar: fields.avatar || "🙂",
    color: fields.color || DEFAULT_COLORS[index % DEFAULT_COLORS.length],
    body: body.trim(),
  };
}
