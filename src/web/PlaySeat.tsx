import { useEffect, useRef, useState } from "react";
import { useGame } from "./useGame";

/**
 * The human player's private screen. Keep this window OFF your stream capture —
 * it shows your role and night information.
 */
export function PlaySeat() {
  const { state, send } = useGame("player");
  const [name, setName] = useState("");
  const [avatar, setAvatar] = useState("🧑");
  const [draft, setDraft] = useState("");
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: "smooth" });
  }, [state.privateLog.length, state.chat.length]);

  if (!state.claimedName) {
    return (
      <div className="play claim">
        <h1>🐺 Take a seat</h1>
        <p>You'll play alongside everyone else in the lobby. Keep this window off-stream.</p>
        {!state.lobby?.playMode && (
          <p className="hint warn">play_mode is off in config.yaml — turn it on first.</p>
        )}
        <div className="claim-form">
          <input
            placeholder="Your name"
            value={name}
            maxLength={20}
            onChange={(e) => setName(e.target.value)}
          />
          <input
            className="avatar-input"
            value={avatar}
            maxLength={4}
            onChange={(e) => setAvatar(e.target.value)}
          />
          <button
            className="btn primary"
            disabled={!name.trim() || !state.lobby?.playMode}
            onClick={() => send({ type: "claim_seat", name: name.trim(), avatar })}
          >
            Claim seat
          </button>
        </div>
        {state.error && <p className="hint warn">{state.error}</p>}
      </div>
    );
  }

  const submitChat = () => {
    if (!draft.trim()) return;
    send({ type: "input", value: draft.trim() });
    setDraft("");
  };

  return (
    <div className="play">
      <header className="play-header">
        <span>
          {avatar} {state.claimedName} — private screen (keep off-stream)
        </span>
        <span className="phase-sub">phase: {state.phase}</span>
      </header>

      <div className="play-columns">
        <section className="panel play-private">
          <div className="panel-title">🔒 Your private game feed</div>
          <div className="private-log" ref={logRef}>
            {state.privateLog.length === 0 && (
              <div className="hint">Your role and night info will appear here when the game starts.</div>
            )}
            {state.privateLog.map((l) => (
              <div className="private-line" key={l.id}>
                {l.text}
              </div>
            ))}
          </div>
        </section>

        <section className="panel play-chat">
          <div className="panel-title">Lobby chat</div>
          <div className="private-log">
            {state.chat.map((m) => (
              <div key={m.id}>
                <b>{m.player}:</b> {m.text}
              </div>
            ))}
          </div>
        </section>
      </div>

      {state.turn && (
        <section className="panel turn">
          <div className="panel-title">⏰ Your turn</div>
          <p className="turn-prompt">{state.turn.prompt}</p>
          {state.turn.kind === "chat" ? (
            <div className="turn-chat">
              <input
                autoFocus
                value={draft}
                maxLength={400}
                placeholder="Type your message…"
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && submitChat()}
              />
              <button className="btn primary" onClick={submitChat}>
                Send
              </button>
            </div>
          ) : (
            <div className="turn-options">
              {state.turn.options?.map((o, i) => (
                <button
                  className="btn option"
                  key={i}
                  onClick={() => send({ type: "input", value: o.value })}
                >
                  {o.label}
                </button>
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
