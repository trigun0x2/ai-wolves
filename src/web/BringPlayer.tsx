import { useEffect, useRef, useState } from "react";
import {
  loadPersonas,
  savePersona,
  deletePersona,
  newId,
  type StoredPersona,
} from "./personaStore";

type Provider = "anthropic" | "openai" | "openrouter";
type CredMode = "openrouter-oauth" | "paste";

const BODY_MAX = 4000;

// Curated latest models per provider. "Other" reveals a free-text field for
// anything not listed (OpenRouter has hundreds of slugs).
const OTHER = "__other__";
const MODELS: Record<Provider, { id: string; label: string }[]> = {
  anthropic: [
    { id: "claude-fable-5", label: "Claude Fable 5 — most capable" },
    { id: "claude-opus-4-8", label: "Claude Opus 4.8" },
    { id: "claude-opus-4-7", label: "Claude Opus 4.7" },
    { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
    { id: "claude-haiku-4-5", label: "Claude Haiku 4.5 — fast" },
  ],
  openai: [
    { id: "gpt-4.1", label: "GPT-4.1" },
    { id: "gpt-4.1-mini", label: "GPT-4.1 mini" },
  ],
  openrouter: [
    { id: "anthropic/claude-opus-4-8", label: "Claude Opus 4.8" },
    { id: "anthropic/claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
    { id: "openai/gpt-4.1", label: "GPT-4.1" },
    { id: "meta-llama/llama-3.3-70b-instruct", label: "Llama 3.3 70B" },
    { id: "deepseek/deepseek-chat", label: "DeepSeek Chat" },
  ],
};

const EXAMPLE = `## Persona
A 31-year-old barista who treats werewolf like latte art — calm, precise, a little smug. Types in lowercase, over-uses "honestly".

## Strategy
Quiet first round, then drops one sharp read. Never claims Seer first. As a wolf, agrees with whoever's loudest and lets them hang someone.`;

export function BringPlayer() {
  // persona editor
  const [id, setId] = useState(newId());
  const [name, setName] = useState("");
  const [avatar, setAvatar] = useState("🙂");
  const [color, setColor] = useState("#7dd3fc");
  const [body, setBody] = useState("");
  const [library, setLibrary] = useState<StoredPersona[]>([]);

  // model + credential
  const [provider, setProvider] = useState<Provider>("openrouter");
  const [model, setModel] = useState(MODELS.openrouter[0].id);
  const [credMode, setCredMode] = useState<CredMode>("openrouter-oauth");
  const [rawKey, setRawKey] = useState("");
  const [keyRef, setKeyRef] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);

  const [status, setStatus] = useState<{ kind: "ok" | "err" | "info"; msg: string } | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => setLibrary(loadPersonas()), []);
  useEffect(() => () => void (pollRef.current && clearInterval(pollRef.current)), []);

  // Changing the provider/credential method invalidates any connected key.
  const resetCred = () => {
    setKeyRef(null);
    if (pollRef.current) clearInterval(pollRef.current);
  };

  const loadFromLibrary = (p: StoredPersona) => {
    setId(p.id);
    setName(p.name);
    setAvatar(p.avatar || "🙂");
    setColor(p.color || "#7dd3fc");
    setBody(p.body);
    setStatus({ kind: "info", msg: `loaded "${p.name}"` });
  };

  const saveToLibrary = () => {
    if (!name.trim()) {
      setStatus({ kind: "err", msg: "give your character a name first" });
      return;
    }
    setLibrary(savePersona({ id, name: name.trim(), avatar, color, body }));
    setStatus({ kind: "ok", msg: "saved to your browser library" });
  };

  const newCharacter = () => {
    setId(newId());
    setName("");
    setAvatar("🙂");
    setColor("#7dd3fc");
    setBody("");
    setStatus(null);
  };

  const removeFromLibrary = (pid: string) => setLibrary(deletePersona(pid));

  // ---- credential connect ----

  const connectRawKey = async () => {
    if (!rawKey.trim()) return;
    setConnecting(true);
    setStatus(null);
    try {
      const r = await fetch("/api/credential/raw", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, key: rawKey.trim() }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? "failed");
      setKeyRef(d.keyRef);
      setRawKey(""); // don't keep the key in component state once exchanged for a ref
      setStatus({ kind: "ok", msg: "key connected (held server-side for this game only)" });
    } catch (e) {
      setStatus({ kind: "err", msg: String(e instanceof Error ? e.message : e) });
    } finally {
      setConnecting(false);
    }
  };

  const connectOpenRouter = async () => {
    setConnecting(true);
    setStatus(null);
    try {
      const r = await fetch("/api/credential/openrouter/start", { method: "POST" });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? "failed");
      window.open(d.authUrl, "openrouter", "width=520,height=720");
      setStatus({ kind: "info", msg: "authorize in the popup, then come back…" });
      // Poll until the server has the key (the key never comes back to us).
      pollRef.current = setInterval(async () => {
        const s = await fetch(`/api/credential/status?keyRef=${d.keyRef}`).then((x) => x.json());
        if (s.connected) {
          if (pollRef.current) clearInterval(pollRef.current);
          setKeyRef(d.keyRef);
          setConnecting(false);
          setStatus({ kind: "ok", msg: "OpenRouter connected — billing your account" });
        }
      }, 1500);
    } catch (e) {
      setConnecting(false);
      setStatus({ kind: "err", msg: String(e instanceof Error ? e.message : e) });
    }
  };

  // ---- submit ----

  const submit = async () => {
    if (!keyRef) {
      setStatus({ kind: "err", msg: "connect your model/key first" });
      return;
    }
    try {
      const r = await fetch("/api/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, avatar, color, body, model, keyRef }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? "failed");
      setStatus({
        kind: "ok",
        msg: `"${name}" joined the queue — a game will auto-start soon. You're removed after playing, so re-join to play again. Good luck!`,
      });
      resetCred();
    } catch (e) {
      setStatus({ kind: "err", msg: String(e instanceof Error ? e.message : e) });
    }
  };

  const usingCustomModel = !MODELS[provider].some((m) => m.id === model);

  const modelPlaceholder =
    provider === "openrouter"
      ? "e.g. anthropic/claude-opus-4-8 or meta-llama/llama-3.3-70b-instruct"
      : provider === "openai"
        ? "e.g. gpt-4.1"
        : "e.g. claude-opus-4-8";

  return (
    <div className="bring">
      <header className="bring-header">
        <h1>🐺 Bring your own player</h1>
        <p>
          Build a character, connect your own model, and join the queue. Once someone's queued, a
          game auto-starts after a short countdown; agents are drawn at random and removed after
          they play, so re-join to play again. Your persona is saved in this browser to reuse; your
          API key is never stored here — it's held on the server only while you're queued, in memory.
        </p>
      </header>

      <div className="bring-grid">
        <section className="panel">
          <div className="panel-title">1 · Character</div>
          <div className="field-row">
            <input
              className="in"
              placeholder="Name (shown in chat)"
              maxLength={24}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <input
              className="in avatar"
              value={avatar}
              maxLength={8}
              onChange={(e) => setAvatar(e.target.value)}
              title="avatar emoji"
            />
            <input
              className="in color"
              type="color"
              value={color}
              onChange={(e) => setColor(e.target.value)}
              title="accent color"
            />
          </div>
          <textarea
            className="in body"
            placeholder={EXAMPLE}
            maxLength={BODY_MAX}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={12}
          />
          <div className="counter">
            {body.length}/{BODY_MAX}
          </div>
          <div className="btn-row">
            <button className="btn" onClick={newCharacter}>
              ＋ New
            </button>
            <button className="btn primary" onClick={saveToLibrary}>
              💾 Save to library
            </button>
          </div>
        </section>

        <section className="panel">
          <div className="panel-title">Your library (this browser)</div>
          {library.length === 0 ? (
            <div className="hint">Saved characters show up here to reload and edit.</div>
          ) : (
            <div className="lib">
              {library.map((p) => (
                <div className="lib-row" key={p.id}>
                  <button className="lib-load" onClick={() => loadFromLibrary(p)}>
                    <span className="lib-av">{p.avatar}</span>
                    <span style={{ color: p.color }}>{p.name}</span>
                  </button>
                  <button className="lib-del" onClick={() => removeFromLibrary(p.id)} title="delete">
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="panel">
          <div className="panel-title">2 · Your model</div>
          <div className="seg">
            {(["openrouter", "anthropic", "openai"] as Provider[]).map((p) => (
              <button
                key={p}
                className={`btn seg-btn ${provider === p ? "sel" : ""}`}
                onClick={() => {
                  setProvider(p);
                  setModel(MODELS[p][0].id); // default to the latest for this provider
                  setCredMode(p === "openrouter" ? "openrouter-oauth" : "paste");
                  resetCred();
                }}
              >
                {p}
              </button>
            ))}
          </div>
          <select
            className="in"
            style={{ marginBottom: 8 }}
            value={usingCustomModel ? OTHER : model}
            onChange={(e) => setModel(e.target.value === OTHER ? "" : e.target.value)}
          >
            {MODELS[provider].map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
            <option value={OTHER}>Other (enter a model id)…</option>
          </select>
          {usingCustomModel && (
            <input
              className="in"
              placeholder={modelPlaceholder}
              value={model}
              onChange={(e) => setModel(e.target.value)}
            />
          )}

          <div className="panel-title sub">Credential</div>
          {keyRef ? (
            <div className="connected">✅ connected — ready to submit</div>
          ) : provider === "openrouter" && credMode === "openrouter-oauth" ? (
            <>
              <button className="btn primary" disabled={connecting} onClick={connectOpenRouter}>
                {connecting ? "waiting for authorization…" : "🔗 Connect OpenRouter"}
              </button>
              <button
                className="link-toggle"
                onClick={() => {
                  setCredMode("paste");
                  resetCred();
                }}
              >
                or paste an API key instead
              </button>
            </>
          ) : (
            <>
              <div className="field-row">
                <input
                  className="in"
                  type="password"
                  placeholder={`Paste your ${provider} API key`}
                  value={rawKey}
                  onChange={(e) => setRawKey(e.target.value)}
                />
                <button
                  className="btn primary"
                  disabled={connecting || !rawKey.trim()}
                  onClick={connectRawKey}
                >
                  Connect
                </button>
              </div>
              {provider === "openrouter" && (
                <button
                  className="link-toggle"
                  onClick={() => {
                    setCredMode("openrouter-oauth");
                    resetCred();
                  }}
                >
                  ← use OpenRouter sign-in instead (recommended)
                </button>
              )}
            </>
          )}
          <div className="hint">
            Your key is exchanged for a one-game token and held on the server — it never lands in
            this browser or any saved file.
          </div>

          <div className="panel-title sub">3 · Join the queue</div>
          <button className="btn primary big" onClick={submit} disabled={!keyRef || !name.trim()}>
            🐺 Join the game queue
          </button>
          {status && <div className={`status ${status.kind}`}>{status.msg}</div>}
        </section>
      </div>
    </div>
  );
}
