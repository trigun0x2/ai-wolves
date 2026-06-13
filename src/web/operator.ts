/**
 * Operator token handling for the dashboard. The host opens the dashboard with
 * `?op=TOKEN` (or `#op=TOKEN`); the token is stashed in localStorage and stripped
 * from the URL, then sent on operator API calls and the WebSocket hello.
 *
 * This is a convenience credential for the host only — not a contributor secret.
 */
const KEY = "aiwolves:op";

function readFromUrl(): string | null {
  const fromQuery = new URLSearchParams(location.search).get("op");
  const fromHash = new URLSearchParams(location.hash.replace(/^#/, "").split("?")[1] ?? "").get("op");
  return fromQuery || fromHash;
}

// On load: if the URL carries a token, persist it and scrub it from the address bar.
(() => {
  const t = readFromUrl();
  if (t) {
    localStorage.setItem(KEY, t);
    const url = new URL(location.href);
    url.searchParams.delete("op");
    history.replaceState(null, "", url.pathname + url.search + url.hash);
  }
})();

export function getOpToken(): string {
  return localStorage.getItem(KEY) ?? "";
}

export function setOpToken(token: string): void {
  if (token) localStorage.setItem(KEY, token);
  else localStorage.removeItem(KEY);
}

/** Header to attach to operator API calls. Empty object when no token is held. */
export function opHeaders(): Record<string, string> {
  const t = getOpToken();
  return t ? { "x-operator-token": t } : {};
}
