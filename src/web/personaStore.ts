/**
 * Browser-local persona library. Personas are ephemeral server-side (forgotten
 * after one game) but kept here in localStorage so a contributor can pull up and
 * edit their characters across sessions.
 *
 * SECURITY: only persona text lives here — never API keys. Keys are exchanged for
 * an opaque server-side ref and never touch localStorage.
 */
export interface StoredPersona {
  id: string;
  name: string;
  avatar: string;
  color: string;
  body: string;
  updatedAt: number;
}

const KEY = "aiwolves:personas";

export function loadPersonas(): StoredPersona[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const list = JSON.parse(raw) as StoredPersona[];
    return Array.isArray(list) ? list.sort((a, b) => b.updatedAt - a.updatedAt) : [];
  } catch {
    return [];
  }
}

function persist(list: StoredPersona[]): void {
  localStorage.setItem(KEY, JSON.stringify(list));
}

export function savePersona(p: Omit<StoredPersona, "updatedAt">): StoredPersona[] {
  const list = loadPersonas().filter((x) => x.id !== p.id);
  list.push({ ...p, updatedAt: Date.now() });
  persist(list);
  return list.sort((a, b) => b.updatedAt - a.updatedAt);
}

export function deletePersona(id: string): StoredPersona[] {
  const list = loadPersonas().filter((x) => x.id !== id);
  persist(list);
  return list;
}

export function newId(): string {
  return `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}
