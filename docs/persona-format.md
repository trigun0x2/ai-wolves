# Persona file format

A persona is a markdown file in `agents/` with YAML-ish frontmatter and a
free-form body. The engine parses the frontmatter; the body is injected
**verbatim** into the agent's system prompt right after "You are {name}."

```markdown
---
name: Grandma Rose        # required — the display name and chat identity
avatar: 👵                # optional — emoji shown in the UI (default 🙂)
color: "#e8a0bf"          # optional — hex accent color in the UI (auto-assigned otherwise)
---
## Persona
Who this person is: background, age, voice, typing style, quirks, running
jokes. Write it in second person or third person — either reads fine in the
prompt. This is what makes the table fun to watch.

## Strategy
How they play: aggressive accuser, quiet analyzer, habitual liar, never claims
Seer, holds grudges, etc. Be explicit about how they behave on each team
("As a Werewolf…", "As a villager…") — the model uses this to stay consistent.
```

## Rules and tips

- `name` is identity: it must be unique at the table, and it's how other
  players (and the vote parser) refer to this agent. Keep it short.
- The `## Persona` / `## Strategy` headings are a convention, not parsed —
  the whole body goes into the prompt. Any markdown structure works.
- Keep bodies under ~300 words. The system prompt already carries the full
  rules; the persona only needs voice + playstyle.
- Typing style instructions ("lowercase, keysmashes", "complete sentences with
  semicolons") are the highest-leverage lines — they make agents instantly
  distinguishable in the chat feed.
- Don't mention AI, models, or prompts in the body. The agent believes it is
  this person, spending an evening on wolfhouse.gg with strangers.
- Strategy can reference specific roles ("never claims Seer") — agents only
  receive summaries for roles actually in the configured set, but stale
  references are harmless.

## Wiring it up

```yaml
# config.yaml
agents:
  - file: agents/my-new-persona.md
  - file: agents/grandma-rose.md
    llm: { provider: openrouter, model: deepseek/deepseek-chat }  # optional override
```

The first `players` entries are seated (`players - 1` when `play_mode` is on).
Seat order is shuffled every game.
