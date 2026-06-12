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
