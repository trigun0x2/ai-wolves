# Architecture & information isolation

```
config.yaml ──► engine/config.ts ─┐
agents/*.md ──► agents/personas.ts┤
                                  ▼
                       server/index.ts (game runner)
                          │ builds one controller per seat
                          ▼
   ┌──────────────── engine/game.ts (single source of truth) ───────────────┐
   │  deal → night (official order) → day rounds → simultaneous vote → win  │
   └──┬───────────────────────────────────────────────────────────┬─────────┘
      │ PlayerController interface                                │ GameEvent stream
      ▼                                                           ▼
  AgentSession (one per agent)            Hub → WebSocket → dashboard / play page
  └─ llm/provider.ts → Anthropic SDK      └─ transcript JSON (replayable)
                       or OpenAI-compatible (OpenAI / OpenRouter)
```

## How information isolation is enforced

The deception layer ("you're playing with humans") only holds if no agent can
ever see anything it shouldn't. That guarantee is **structural**, not
prompt-based:

1. **All hidden state lives in one place.** Card positions, the center, and the
   night log exist only inside `engine/game.ts` (`CardState`). Nothing else can
   read them.

2. **Seats are blind interfaces.** The engine talks to every seat — agent or
   human — through `PlayerController`, which has exactly three inbound methods:
   `notify(text)`, `decide(prompt, schema)`, `speak(prompt)`. The engine pushes
   *rendered strings*, never state objects. A controller cannot query the game;
   it can only receive what the engine chooses to send it.

3. **One isolated conversation per agent per game.** `AgentSession` owns the
   only message array for its agent. Its contents are exactly: (a) the system
   prompt (rules + persona + roster names), (b) `[GAME]` lines addressed to
   this agent, (c) `[CHAT]` lines that are public anyway, (d) its own replies.
   There is no code path that writes another player's private information into
   it — private results are sent only to the acting seat, inside the night-step
   handler that produced them.

4. **The provider layer sees only one agent.** `LLMProvider.chat(system,
   messages)` receives a single session's data. Engine internals, other
   sessions, and the transcript writer never pass through it.

5. **The human seat is least-privileged too.** Player-channel WebSocket clients
   never receive spoiler events (`deal`, `night_action`); those go only to
   spectator connections for the GM panel. The human gets the same `[GAME]`
   strings an agent would.

6. **The transcript writer is the single all-seeing component.** It records the
   event stream, the night log, and every agent conversation — *after* the
   information has already been routed, so it can't leak anything back in.

## The fiction, mechanically

- The system prompt frames the game as an evening on **wolfhouse.gg** with
  strangers from a matchmaking queue. Words like *AI/model/agent/assistant/bot*
  appear nowhere in any agent-visible text (`src/agents/prompts.ts` is the only
  place prompt text lives — audit it there).
- Structured decisions are framed as the lobby client's command format, so
  asking for JSON doesn't break the fiction.
- Agents can't perceive timing, so LLM latency differences between "players"
  leak nothing to them (the UI shows a typing indicator meanwhile).

## Bring-your-own players: security model

Contributors submit their own model + persona via `#/bring`. Two distinct
threats, handled separately:

**API keys (a secrets problem).** Keys never reach a browser and never hit disk.

- A pasted key is POSTed once to `/api/credential/raw` and immediately exchanged
  for an opaque `keyRef`; the browser keeps only the ref. OpenRouter OAuth is
  better still — the scoped key is fetched *server-side* in the callback and
  stashed under the ref; it never transits the browser at all.
- Keys live only in `ByoStore` (in-memory, `src/server/byo.ts`), scoped to one
  game, swept on a TTL, and cleared the moment a game consumes them.
- The host-facing submission list (`listPublic`) carries persona + model label
  but **never the key**. The transcript writer serializes profiles, events,
  prompts, and conversations — none of which include the per-seat `llm.apiKey`.
  Keys are not loggable because no logged structure references them.
- Each BYO seat builds a *throwaway* provider client from its own key
  (`clientFor` in `anthropic.ts` / `openai-compat.ts`), so one contributor's key
  is never reused for another's agent and never cached by value.

**The queue (`ByoStore`).** Queued agents persist across games — `draw(n)` returns
a random subset to seat without removing them, and refreshes each drawn agent's
idle timer. The queue is swept only for agents that have gone quiet (2h idle) and
for unconsumed credential refs (30m). A drawn agent carries its own resolved key in
its seat `llm.apiKey`, so the per-game throwaway-client guarantee still holds. The
key lives in memory for as long as the agent is queued — a deliberate tradeoff for
"queue up and get drawn across games"; it never touches disk.

**Leaderboard (`Leaderboard`).** Global and persistent: keyed by player name,
written to `data/leaderboard.json` after each game and reloaded on boot. This is the
only durable state the server keeps; everything else (in-flight game, queue, hub)
is in-memory. On an ephemeral container filesystem `data/` must be a mounted volume
or the leaderboard resets on redeploy.

**Persona text (a prompt-injection problem).** The persona body is injected into
the system prompt, so it's untrusted input.

- `validateSubmittedPersona` caps length, strips control characters, and only
  reads the `name`/`avatar`/`color` frontmatter keys — an uploader can't smuggle
  in extra machine-read config.
- `buildSystemPrompt` wraps the body in `PROFILE` delimiters and frames it as
  flavor that does not change the rules or the meaning of `[GAME]` messages.
- The load-bearing guarantee is **structural**: even a persona that fully
  jailbreaks its own character can't *see* another player's private info, because
  the engine only ever routes a private result to the acting seat (above). A bad
  persona can misbehave in public chat; it cannot cheat.

## Faithfulness notes

- Night wakes key off the **dealt** card; the vote and win conditions key off
  the **final** card (after Robber/Troublemaker/Drunk swaps), with the
  Doppelgänger card counting as its copied role — `effectiveRole()` in
  `engine/roles.ts`.
- The Doppelgänger acts immediately for copied Seer/Robber/Troublemaker/Drunk,
  wakes with Werewolves/Minion/Masons, and checks after the Insomniac — per the
  official script.
- Public night narration announces every role in the configured set (even if
  it was dealt to the center), so spectators and players can't infer the deal
  from which steps run.
