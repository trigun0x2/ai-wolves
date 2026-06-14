import { useEffect, useState } from "react";
import { useGame } from "./useGame";
import { getOpToken, opHeaders } from "./operator";
import {
  CountdownBanner,
  OperatorGate,
  PhaseBanner,
  Scoreboard,
  Submissions,
  SPEEDS,
} from "./Dashboard";

/**
 * Operator console (#/admin). The host's control surface — start games, set the
 * pace, replay saved transcripts, and remove agents from the queue. Gated by the
 * OPERATOR_TOKEN: when the server sets one, the controls stay locked until the
 * token is entered (the sensitive endpoints are independently enforced server-side).
 */
export function Admin() {
  const { state, send } = useGame("spectator");
  const [transcripts, setTranscripts] = useState<string[]>([]);
  const [banner, setBanner] = useState<string | null>(null);
  const [opOk, setOpOk] = useState<boolean | null>(null);

  const authRequired = state.lobby?.authRequired ?? false;
  const authed = !authRequired || opOk === true;

  // Verify the operator token against the server so we only show controls that
  // will actually work (the endpoints are enforced server-side regardless).
  useEffect(() => {
    if (!authRequired) {
      setOpOk(true);
      return;
    }
    if (!getOpToken()) {
      setOpOk(false);
      return;
    }
    fetch("/api/operator/check", { headers: opHeaders() })
      .then((r) => setOpOk(r.ok))
      .catch(() => setOpOk(false));
  }, [authRequired, state.connected]);

  useEffect(() => {
    if (!authed) return;
    fetch("/api/transcripts")
      .then((r) => r.json())
      .then((d) => setTranscripts(d.files ?? []))
      .catch(() => {});
  }, [authed, state.games, state.lobby?.running]);

  const flash = (msg: string) => {
    setBanner(msg);
    setTimeout(() => setBanner(null), 8000);
  };

  const start = async () => {
    const res = await fetch("/api/start", { method: "POST", headers: opHeaders() });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      flash(d.error ?? "failed to start");
    }
  };

  const replay = async (file: string) => {
    if (!file) return;
    await fetch("/api/replay", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...opHeaders() },
      body: JSON.stringify({ file }),
    });
  };

  return (
    <div className="admin">
      <header className="bring-header admin-header">
        <h1>⚙ Operator console</h1>
        <a className="admin-link" href="#/">
          ← Back to the arena
        </a>
      </header>

      {authRequired && !authed ? (
        <section className="panel" style={{ maxWidth: 460 }}>
          <OperatorGate opOk={opOk} />
          <div className="hint">
            Enter the <code>OPERATOR_TOKEN</code> to unlock the controls.
          </div>
        </section>
      ) : (
        <div className="admin-grid">
          <section className="panel controls">
            <div className="panel-title">Game control</div>
            {authRequired && <OperatorGate opOk={opOk} />}
            <PhaseBanner state={state} />
            <CountdownBanner state={state} />
            <button
              className="btn primary"
              onClick={start}
              disabled={!state.connected || state.lobby?.running}
            >
              {state.lobby?.running
                ? "Game in progress…"
                : state.lobby?.countdownEndsAt
                  ? "▶ Start now"
                  : "▶ Start game"}
            </button>
            {state.lobby?.playMode && (
              <div className="hint">
                Play mode:{" "}
                {state.lobby.humanClaimed
                  ? `${state.lobby.humanClaimed} seated`
                  : "waiting for human at #/play"}
              </div>
            )}
            <div className="speed-row">
              <span className="speed-label">🐢 Text speed</span>
              {SPEEDS.map((s) => (
                <button
                  key={s}
                  className={`btn speed ${state.speed === s ? "sel" : ""}`}
                  onClick={() => send({ type: "set_speed", speed: s })}
                >
                  {s}×
                </button>
              ))}
            </div>
            <select
              className="select"
              defaultValue=""
              disabled={state.lobby?.running}
              onChange={(e) => {
                replay(e.target.value);
                e.target.value = "";
              }}
            >
              <option value="" disabled>
                ↻ Replay a saved game…
              </option>
              {transcripts.map((f) => (
                <option key={f} value={f}>
                  {f.replace(".json", "")}
                </option>
              ))}
            </select>
            {!state.connected && <div className="hint warn">reconnecting…</div>}
            {banner && <div className="hint warn">{banner}</div>}
          </section>

          {/* manage=true → each queued agent gets a remove button */}
          <Submissions state={state} manage />

          <Scoreboard state={state} />
        </div>
      )}
    </div>
  );
}
