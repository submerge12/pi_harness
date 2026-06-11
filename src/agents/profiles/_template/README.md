# Agent Profile Template

This directory is copied by `npm run new-agent -- <name>`.

Replace the placeholders in:

- `profile.ts`: profile metadata, tools, policy, model defaults, context tuning, skills,
  and templates.
- `prompt.ts`: stable cache-aware system prompt sections.

The generator registers the profile in `src/agents/profiles/index.ts`. Before expanding
the generated implementation, write the design notes from `docs/agent-design-guide.md`
and define the profile's golden tasks.
