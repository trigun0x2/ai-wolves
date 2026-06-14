import { useEffect, useMemo, useRef, useState } from "react";
import type { CardRef, PublicPlayer, RevealData, Role } from "../shared/types";
import { useGame, type UiState } from "./useGame";
import { getOpToken, setOpToken, opHeaders } from "./operator";

const ROLE_EMOJI: Record<Role, string> = {
  villager: "🧑‍🌾",
  seer: "🔮",
  robber: "🥷",
  troublemaker: "😈",
  mason: "⚒️",
  drunk: "🍺",
  insomniac: "😵‍💫",
  hunter: "🏹",
  werewolf: "🐺",
  minion: "🦴",
  tanner: "🪢",
  doppelganger: "🎭",
};

const SPEEDS = [0.5, 1, 1.5, 2, 3];

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function playerOf(players: PublicPlayer[], name: string): PublicPlayer | undefined {
  return players.find((p) => p.name === name);
}

const refEq = (a: CardRef, b: CardRef) =>
  a.type === b.type &&
  (a.type === "player" ? a.name === (b as { name: string }).name : a.idx === (b as { idx: number }).idx);

const isMobile = () =>
  typeof window !== "undefined" && window.matchMedia("(max-width: 860px)").matches;

export function Dashboard() {
  const { state, send } = useGame("spectator");
  // Spoilers default OFF on a phone (casual spectator view); desktop/OBS keeps
  // the config default. Either way the GM toggle still overrides.
  const [spoilers, setSpoilers] = useState<boolean | null>(() => (isMobile() ? false : null));
  const [transcripts, setTranscripts] = useState<string[]>([]);
  const [banner, setBanner] = useState<string | null>(null);
  const [opOk, setOpOk] = useState<boolean | null>(null);
  // First-time intro: auto-show until dismissed (persisted per browser).
  const [showHelp, setShowHelp] = useState(() => !localStorage.getItem("aiwolves:onboarded"));
  const dismissHelp = () => {
    localStorage.setItem("aiwolves:onboarded", "1");
    setShowHelp(false);
  };

  const showSpoilers = spoilers ?? state.lobby?.spoilerDefault ?? false;
  const authRequired = state.lobby?.authRequired ?? false;
  const authed = !authRequired || opOk === true;

  // Verify the operator token (if auth is on) so we can gate the host controls.
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
    fetch("/api/transcripts")
      .then((r) => r.json())
      .then((d) => setTranscripts(d.files ?? []))
      .catch(() => {});
  }, [state.games, state.lobby?.running]);

  useEffect(() => {
    if (state.error) {
      setBanner(state.error);
      const t = setTimeout(() => setBanner(null), 8000);
      return () => clearTimeout(t);
    }
  }, [state.error]);

  const start = async () => {
    const res = await fetch("/api/start", { method: "POST", headers: opHeaders() });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      setBanner(d.error ?? "failed to start");
      setTimeout(() => setBanner(null), 8000);
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

  const showStrip = state.phase === "day" || state.phase === "vote" || state.phase === "reveal";

  // On mobile the night/vote/reveal overlays go full-screen; lock the page
  // behind them so you can't scroll the sidebar into view mid-moment.
  const overlayActive =
    state.phase === "night" ||
    state.countdownAt !== null ||
    (!!state.votes && !state.reveal) ||
    !!state.reveal;
  useEffect(() => {
    document.body.classList.toggle("overlay-open", overlayActive);
    return () => document.body.classList.remove("overlay-open");
  }, [overlayActive]);

  return (
    <div className={`dashboard ${state.phase === "lobby" ? "is-lobby" : ""}`}>
      {showHelp && <HelpModal onClose={dismissHelp} />}
      <button className="help-fab" title="How it works" onClick={() => setShowHelp(true)}>
        ?
      </button>
      <main className="stage">
        {state.notice && (
          <div className="notice-banner">
            <span>{state.notice}</span>
          </div>
        )}
        {showStrip && <TableStrip state={state} showSpoilers={showSpoilers} />}
        <ChatFeed state={state} />
        {state.phase === "night" && <NightTable state={state} showSpoilers={showSpoilers} />}
        {(state.countdownAt !== null || (state.votes && !state.reveal)) && (
          <VoteOverlay state={state} />
        )}
        {state.reveal && <EndgameOverlay reveal={state.reveal} players={state.players} />}
      </main>

      <aside className="sidebar">
        <PhaseBanner state={state} />
        <Submissions state={state} authed={authed} />
        <Roster state={state} />
        <section className="panel controls">
          <div className="panel-title">Control</div>
          {authRequired && <OperatorGate opOk={opOk} />}
          {authed && (
            <>
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
                  Play mode: {state.lobby.humanClaimed ? `${state.lobby.humanClaimed} seated` : "waiting for human at #/play"}
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
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={showSpoilers}
                  onChange={(e) => setSpoilers(e.target.checked)}
                />
                GM / spoiler panel
              </label>
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
            </>
          )}
          {!state.connected && <div className="hint warn">reconnecting…</div>}
          {banner && <div className="hint warn">{banner}</div>}
        </section>
        {showSpoilers && <GMPanel state={state} />}
        <Scoreboard state={state} />
      </aside>
    </div>
  );
}

/** Seats across the top of the stage; the current speaker glows. */
function TableStrip({ state, showSpoilers }: { state: UiState; showSpoilers: boolean }) {
  const last = state.chat.length ? state.chat[state.chat.length - 1].player : null;
  const active = state.phase === "day" ? (state.typing ?? last) : null;
  return (
    <div className="table-strip">
      {state.players.map((p) => {
        const isActive = active === p.name;
        const dead = state.deaths.includes(p.name);
        const card = showSpoilers ? state.table.players[p.name] : null; // current card, post-swaps
        return (
          <div
            key={p.name}
            className={`seat ${isActive ? "active" : ""} ${dead ? "dead" : ""}`}
            style={{
              borderColor: p.color,
              boxShadow: isActive ? `0 0 22px ${p.color}, inset 0 0 8px ${p.color}40` : undefined,
            }}
          >
            <span className="seat-avatar">{p.avatar}</span>
            <span className="seat-name" style={{ color: p.color }}>
              {p.name}
            </span>
            {card && (
              <span className="seat-role">
                {ROLE_EMOJI[card]} {cap(card)}
              </span>
            )}
            {dead && <span className="seat-skull">💀</span>}
            {state.typing === p.name && (
              <span className="seat-status">
                <span className="dots small">
                  <span />
                  <span />
                  <span />
                </span>
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

function ChatFeed({ state }: { state: UiState }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.scrollTo({ top: ref.current.scrollHeight, behavior: "smooth" });
  }, [state.chat.length, state.typing]);

  const typingPlayer = state.typing ? playerOf(state.players, state.typing) : null;

  return (
    <div className="chat-feed" ref={ref}>
      {state.chat.length === 0 && state.phase === "lobby" && (
        <div className="empty-title">
          <h1>🐺 AI Werewolf Arena</h1>
          <p>Press “Start game” to begin a round of One Night Ultimate Werewolf.</p>
        </div>
      )}
      {state.chat.map((m, i) => {
        const p = playerOf(state.players, m.player);
        const latest = i === state.chat.length - 1 && state.phase === "day";
        return (
          <div
            className={`msg ${latest ? "latest" : ""}`}
            key={m.id}
            style={{
              borderLeftColor: p?.color ?? "#666",
              boxShadow: latest ? `0 0 18px ${p?.color ?? "#666"}33` : undefined,
            }}
          >
            <div className="msg-avatar">{p?.avatar ?? "❓"}</div>
            <div className="msg-body">
              <div className="msg-name" style={{ color: p?.color ?? "#aaa" }}>
                {m.player}
              </div>
              <div className="msg-text">{m.text}</div>
            </div>
          </div>
        );
      })}
      {typingPlayer && (
        <div className="msg typing" style={{ borderLeftColor: typingPlayer.color }}>
          <div className="msg-avatar">{typingPlayer.avatar}</div>
          <div className="msg-body">
            <div className="msg-name" style={{ color: typingPlayer.color }}>
              {typingPlayer.name}
            </div>
            <div className="dots">
              <span />
              <span />
              <span />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function PhaseBanner({ state }: { state: UiState }) {
  const label = useMemo(() => {
    switch (state.phase) {
      case "lobby":
        return { icon: "🏠", text: "Lobby", sub: "waiting to start" };
      case "night":
        return {
          icon: "🌙",
          text: "Night",
          sub: state.nightStep ? `${cap(state.nightStep)} acting…` : "the village sleeps",
        };
      case "day":
        return {
          icon: "☀️",
          text: `Day — Round ${state.dayRound}/${state.totalRounds}`,
          sub: "discussion",
        };
      case "vote":
        return { icon: "🗳️", text: "Voting", sub: "votes are secret until everyone is in" };
      case "reveal":
        return { icon: "🎭", text: "Reveal", sub: "the truth comes out" };
    }
  }, [state.phase, state.nightStep, state.dayRound, state.totalRounds]);

  return (
    <div className={`phase-banner phase-${state.phase}`}>
      <span className="phase-icon">{label.icon}</span>
      <div>
        <div className="phase-text">{label.text}</div>
        <div className="phase-sub">{label.sub}</div>
      </div>
    </div>
  );
}

function Roster({ state }: { state: UiState }) {
  if (state.players.length === 0) return null;
  return (
    <section className="panel">
      <div className="panel-title">Players</div>
      <div className="roster">
        {state.players.map((p) => (
          <div
            className={`chip ${state.deaths.includes(p.name) ? "dead" : ""}`}
            key={p.name}
            style={{ borderColor: p.color }}
          >
            <span>{p.avatar}</span> {p.name}
            {state.deaths.includes(p.name) && " 💀"}
          </div>
        ))}
      </div>
      {state.roles.length > 0 && (
        <div className="role-list">
          In play: {state.roles.map((r) => `${ROLE_EMOJI[r]} ${cap(r)}`).join(" · ")}
        </div>
      )}
    </section>
  );
}

function Scoreboard({ state }: { state: UiState }) {
  const rows = state.leaderboard;
  if (rows.length === 0) return null;
  return (
    <section className="panel">
      <div className="panel-title">
        🏆 Global leaderboard — {state.games} game{state.games === 1 ? "" : "s"}
      </div>
      <table className="score">
        <thead>
          <tr className="score-head">
            <th>Player</th>
            <th>W</th>
            <th>GP</th>
            <th>Win%</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((e, i) => {
            const p = playerOf(state.players, e.name);
            const rate = e.games ? Math.round((e.wins / e.games) * 100) : 0;
            return (
              <tr key={e.name}>
                <td>
                  <span className="rank">{i + 1}.</span> {p?.avatar ?? ""} {e.name}
                </td>
                <td className="wins">{e.wins}</td>
                <td className="gp">{e.games}</td>
                <td className="rate">{rate}%</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

/** First-time intro to One Night Ultimate Werewolf. Dismissible, reopenable via "?". */
function HelpModal({ onClose }: { onClose: () => void }) {
  return (
    <div className="help-overlay" onClick={onClose}>
      <div className="help-card" onClick={(e) => e.stopPropagation()}>
        <button className="help-x" onClick={onClose} title="close">
          ✕
        </button>
        <h2>🐺 How AI Werewolf Arena works</h2>
        <p className="help-lead">
          Every player at the table is an AI agent — each one believes it's playing online with
          humans. You're watching them bluff, deduce, and turn on each other in{" "}
          <b>One Night Ultimate Werewolf</b>.
        </p>

        <div className="help-section">
          <h3>The round</h3>
          <ul>
            <li>
              <b>🌙 Night</b> — everyone's secretly dealt a role. Some roles act in secret, and{" "}
              <b>cards can get swapped between players</b>.
            </li>
            <li>
              <b>☀️ Day</b> — the players discuss: claiming roles, accusing, and lying. Lying is
              expected play.
            </li>
            <li>
              <b>🗳️ Vote</b> — everyone votes at once. The most-voted player(s) are eliminated.
            </li>
          </ul>
        </div>

        <div className="help-section">
          <h3>Who wins</h3>
          <ul>
            <li>
              <b>🏡 Village</b> wins if at least one <b>🐺 Werewolf</b> is voted out.
            </li>
            <li>
              <b>🐺 Werewolves</b> win if none of them is voted out.
            </li>
            <li>
              <b>🪢 Tanner</b> wins only by getting voted out.
            </li>
          </ul>
        </div>

        <div className="help-twist">
          💡 The twist: your team is the card you hold at the <b>end</b> of the night — so a player
          can win for a team they never knew they joined.
        </div>

        <p className="help-cta-line">
          Want in? Hit <b>➕ Add a player</b> to bring your own AI model and join the queue.
        </p>

        <button className="btn primary help-got" onClick={onClose}>
          Got it
        </button>
      </div>
    </div>
  );
}

/** Operator login / status. Setting a token reloads so the WS reconnects authed. */
function OperatorGate({ opOk }: { opOk: boolean | null }) {
  const [tok, setTok] = useState("");
  if (opOk) {
    return (
      <div className="op-gate ok">
        <span>🔑 Operator</span>
        <button
          className="op-signout"
          onClick={() => {
            setOpToken("");
            location.reload();
          }}
        >
          sign out
        </button>
      </div>
    );
  }
  const unlock = () => {
    if (!tok.trim()) return;
    setOpToken(tok.trim());
    location.reload();
  };
  return (
    <div className="op-gate">
      <div className="hint">🔒 Host controls are locked.</div>
      <div className="field-row">
        <input
          className="in"
          type="password"
          placeholder="operator token"
          value={tok}
          onChange={(e) => setTok(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && unlock()}
        />
        <button className="btn primary" onClick={unlock}>
          Unlock
        </button>
      </div>
    </div>
  );
}

/** Live countdown to the next auto-started game. */
function CountdownBanner({ state }: { state: UiState }) {
  const [now, setNow] = useState(Date.now());
  const ends = state.lobby?.countdownEndsAt ?? null;
  useEffect(() => {
    if (ends === null) return;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [ends]);
  if (ends === null || state.lobby?.running) return null;
  const left = Math.max(0, Math.ceil((ends - now) / 1000));
  const mm = Math.floor(left / 60);
  const ss = String(left % 60).padStart(2, "0");
  return (
    <div className="countdown-banner">
      ⏳ Auto-starting in <b>{mm}:{ss}</b>
    </div>
  );
}

/** Host view of the agent queue. A random subset is drawn each game. */
function Submissions({ state, authed }: { state: UiState; authed: boolean }) {
  const list = state.submissions;
  const seats = state.lobby?.playerCount ?? 0;
  const remove = (id: string) =>
    fetch(`/api/submit/${id}`, { method: "DELETE", headers: opHeaders() });
  return (
    <section className="panel subs">
      <div className="panel-title">🎮 Agent queue ({list.length} waiting)</div>
      <button
        className="btn add-player"
        onClick={() => window.open(`${location.origin}/#/bring`, "_blank", "noopener")}
      >
        ➕ Add a player
      </button>
      {list.length === 0 ? (
        <div className="hint">
          Viewers add their own model + character. Each game draws {seats || "N"} at random; any
          unfilled seats come from <code>config.yaml</code>.
        </div>
      ) : (
        <>
          <div className="queue-note">
            {list.length <= seats
              ? `all ${list.length} drawn next game (${seats} seats)`
              : `${seats} of ${list.length} drawn at random next game`}{" "}
            · removed after playing
          </div>
          <div className="sub-list">
            {list.map((s) => (
              <div className="sub-row queued" key={s.id}>
                <span className="sub-av" style={{ borderColor: s.color }}>
                  {s.avatar}
                </span>
                <div className="sub-info">
                  <div className="sub-name" style={{ color: s.color }}>
                    {s.name} <span className="sub-model">{s.model}</span>
                  </div>
                  <div className="sub-preview">{s.personaPreview}</div>
                </div>
                <button
                  className="sub-del"
                  title="remove from queue"
                  disabled={state.lobby?.running || !authed}
                  onClick={() => remove(s.id)}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

function GMPanel({ state }: { state: UiState }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.scrollTo({ top: ref.current.scrollHeight });
  }, [state.spoilers.length]);
  return (
    <section className="panel gm">
      <div className="panel-title">🔒 GM panel (spoilers)</div>
      <div className="gm-log" ref={ref}>
        {state.spoilers.length === 0 ? (
          <div className="hint">night actions will appear here</div>
        ) : (
          state.spoilers.map((s) => <div key={s.id}>{s.text}</div>)
        )}
      </div>
    </section>
  );
}

/** One card on the night table. */
function TableCard({
  label,
  avatar,
  color,
  role,
  anim,
  animId,
}: {
  label: string;
  avatar?: string;
  color?: string;
  role: Role | null;
  anim: "" | "peeked" | "swapped";
  animId: number;
}) {
  return (
    <div className="table-seat">
      <div className="table-seat-label" style={{ color }}>
        {avatar ? `${avatar} ` : ""}
        {label}
      </div>
      {/* key change re-triggers the CSS animation for each new effect */}
      <div key={anim ? `e${animId}` : "static"} className={`pcard ${role ? "face" : "back"} ${anim}`}>
        {role ? (
          <>
            <span className="pcard-emoji">{ROLE_EMOJI[role]}</span>
            <span className="pcard-role">{cap(role)}</span>
          </>
        ) : (
          <span className="pcard-back-icon">🐾</span>
        )}
      </div>
    </div>
  );
}

/** Night scene: the full table of cards. Faces + animations only with spoilers on. */
function NightTable({ state, showSpoilers }: { state: UiState; showSpoilers: boolean }) {
  const eff = showSpoilers ? state.effect : null;

  const animFor = (ref: CardRef): "" | "peeked" | "swapped" => {
    if (!eff) return "";
    if (eff.kind === "peek" && eff.targets.some((t) => refEq(t, ref))) return "peeked";
    if (eff.kind === "swap" && (refEq(eff.a, ref) || refEq(eff.b, ref))) return "swapped";
    return "";
  };

  const caption = showSpoilers && state.spoilers.length
    ? state.spoilers[state.spoilers.length - 1].text
    : null;

  return (
    <div className="overlay night">
      <div className="night-head">
        <span className="moon">🌙</span>
        <h2>The village sleeps…</h2>
      </div>
      {state.nightStep && (
        <div className="night-step" key={state.nightStep}>
          {ROLE_EMOJI[state.nightStep]} {cap(state.nightStep)}, wake up…
        </div>
      )}
      <div className="card-table">
        <div className="card-row players">
          {state.players.map((p) => (
            <TableCard
              key={p.name}
              label={p.name}
              avatar={p.avatar}
              color={p.color}
              role={showSpoilers ? state.table.players[p.name] : null}
              anim={animFor({ type: "player", name: p.name })}
              animId={eff?.id ?? 0}
            />
          ))}
        </div>
        <div className="card-row center">
          {state.table.center.map((r, i) => (
            <TableCard
              key={i}
              label={`Center ${i}`}
              role={showSpoilers ? r : null}
              anim={animFor({ type: "center", idx: i })}
              animId={eff?.id ?? 0}
            />
          ))}
        </div>
      </div>
      {caption ? (
        <div className="night-caption" key={state.spoilers.length}>
          {caption}
        </div>
      ) : (
        <div className="night-caption muted">night actions are hidden — they'll all come out at the reveal</div>
      )}
    </div>
  );
}

/** Countdown → votes flip in one by one with a live tally → verdict. */
function VoteOverlay({ state }: { state: UiState }) {
  const [now, setNow] = useState(Date.now());
  const [shown, setShown] = useState(0);
  const [verdict, setVerdict] = useState(false);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(t);
  }, []);

  // Sequential reveal choreography.
  useEffect(() => {
    if (!state.votes) return;
    setShown(0);
    setVerdict(false);
    const votes = state.votes;
    let i = 0;
    const step = setInterval(() => {
      i++;
      setShown(i);
      if (i >= votes.length) {
        clearInterval(step);
        setTimeout(() => setVerdict(true), 1000);
      }
    }, 800);
    return () => clearInterval(step);
  }, [state.votes]);

  if (state.countdownAt !== null && !state.votes) {
    const remaining = Math.max(
      0,
      state.countdownSeconds - Math.floor((now - state.countdownAt) / 1000),
    );
    return (
      <div className="overlay vote">
        <h2>All votes are in</h2>
        <div className="countdown">{remaining > 0 ? remaining : "🐺"}</div>
        <div className="vote-sub">revealing in…</div>
      </div>
    );
  }

  if (!state.votes) return null;
  const visible = state.votes.slice(0, shown);

  // Live tally of revealed votes.
  const tally = new Map<string, number>();
  for (const v of visible) tally.set(v.target, (tally.get(v.target) ?? 0) + 1);
  const tallyRows = [...tally.entries()].sort((a, b) => b[1] - a[1]);

  return (
    <div className="overlay vote">
      <h2>The votes</h2>
      <div className="vote-layout">
        <div className="vote-grid">
          {visible.map((v) => {
            const voter = playerOf(state.players, v.voter);
            const target = playerOf(state.players, v.target);
            const fatal = verdict && state.deaths.includes(v.target);
            return (
              <div className="vote-card flip" key={v.voter}>
                <span className="vote-tile" style={{ borderColor: voter?.color }}>
                  <span className="vote-tile-avatar">{voter?.avatar}</span>
                  <span style={{ color: voter?.color }}>{v.voter}</span>
                </span>
                <span className="arrow big">➜</span>
                {v.target === "no_one" ? (
                  <span className="vote-tile no-one">🚫 no one</span>
                ) : (
                  <span
                    className={`vote-tile ${fatal ? "fatal" : ""}`}
                    style={{ borderColor: target?.color }}
                  >
                    <span className="vote-tile-avatar">{target?.avatar}</span>
                    <span style={{ color: fatal ? undefined : target?.color }}>{v.target}</span>
                  </span>
                )}
              </div>
            );
          })}
        </div>
        <div className="vote-tally">
          <div className="panel-title">Tally</div>
          {tallyRows.map(([target, n]) => {
            const p = playerOf(state.players, target);
            const dead = verdict && state.deaths.includes(target);
            return (
              <div className={`tally-row ${dead ? "fatal" : ""}`} key={target}>
                <span className="tally-name" style={{ color: p?.color }}>
                  {target === "no_one" ? "🚫 no one" : `${p?.avatar ?? ""} ${target}`}
                </span>
                <span className="tally-marks">{"🔻".repeat(n)}</span>
              </div>
            );
          })}
        </div>
      </div>
      {verdict && (
        <div className="deaths stamp">
          {state.deaths.length === 0
            ? "🕊️ Nobody dies."
            : `💀 ${state.deaths.join(", ")} ${state.deaths.length === 1 ? "dies" : "die"}!`}
        </div>
      )}
    </div>
  );
}

function EndgameOverlay({ reveal, players }: { reveal: RevealData; players: PublicPlayer[] }) {
  const [closed, setClosed] = useState(false);
  if (closed) return null;
  const teamLabel: Record<string, string> = {
    village: "🏡 Village",
    werewolf: "🐺 Werewolf team",
    tanner: "🪢 Tanner",
  };
  return (
    <div className="overlay endgame">
      <h2>
        {reveal.winningTeams.length
          ? `${reveal.winningTeams.map((t) => teamLabel[t]).join(" + ")} win${reveal.winningTeams.length === 1 ? "s" : ""}!`
          : "Nobody wins!"}
      </h2>
      {reveal.winners.length > 0 && (
        <div className="winners">🏆 {reveal.winners.join(", ")}</div>
      )}
      <div className="reveal-grid">
        {players.map((p) => {
          const orig = reveal.originalCards[p.name];
          const fin = reveal.finalCards[p.name];
          const dead = reveal.deaths.includes(p.name);
          return (
            <div className={`reveal-card ${dead ? "dead" : ""}`} key={p.name}>
              <div className="reveal-name" style={{ color: p.color }}>
                {p.avatar} {p.name} {dead && "💀"}
              </div>
              <div className="reveal-roles">
                <span>
                  {ROLE_EMOJI[orig]} {cap(orig)}
                </span>
                <span className="arrow">➜</span>
                <span className={orig !== fin ? "changed" : ""}>
                  {ROLE_EMOJI[fin]} {cap(fin)}
                  {fin === "doppelganger" && reveal.doppelCopied
                    ? ` (${cap(reveal.doppelCopied)})`
                    : ""}
                </span>
              </div>
            </div>
          );
        })}
        <div className="reveal-card center-card">
          <div className="reveal-name">🃏 Center</div>
          <div className="reveal-roles">
            <span>{reveal.centerOriginal.map((r) => ROLE_EMOJI[r]).join(" ")}</span>
            <span className="arrow">➜</span>
            <span>{reveal.centerFinal.map((r) => ROLE_EMOJI[r]).join(" ")}</span>
          </div>
        </div>
      </div>
      <div className="night-log">
        <div className="panel-title">What happened in the night</div>
        <ol>
          {reveal.nightLog.map((e, i) => (
            <li key={i}>
              <b>{e.player}</b> ({e.step}) {e.summary}
            </li>
          ))}
        </ol>
      </div>
      <button className="btn" onClick={() => setClosed(true)}>
        Close
      </button>
    </div>
  );
}
