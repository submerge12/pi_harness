# Agent Design Guide

This guide is the Phase 14 checklist for adding a new profession-specific agent profile.
A profile should be mostly declarative: prompt, tools, policy, model defaults, context
tuning, reusable skills, and golden tasks. If a new profile needs core framework changes,
capture that as framework work instead of hiding it inside the profile.

## Mission And Boundaries

Define the agent's job before choosing tools.

- Mission: the concrete workflow the agent is responsible for.
- Boundaries: work the agent must refuse or hand back to the user.
- Definition of done: the observable condition that proves the workflow is complete.
- Escalation points: decisions that need user approval, credentials, paid calls, writes,
  shell commands, or network access.

Keep the first version narrow. A strong profile is one that can say "no" clearly.

## Cache-Aware Prompt Architecture

System prompts are part of the provider prefix cache. Changing them frequently makes every
turn more expensive. Keep the stable prompt prefix fixed and put volatile details in user
messages, tool results, or runtime context instead.

Recommended section order:

1. Identity: one short paragraph naming the role and audience.
2. Hard rules: durable safety, quality, and refusal rules.
3. Domain reference: stable conventions, terminology, schemas, or workflow rules.
4. Output format: the exact response shape the profile should use.

Avoid placing dates, directory listings, task-specific files, live search results, or
per-run configuration in the system prompt. If it changes between turns, it belongs outside
the cached prefix.

## Tool Inventory And Policy

List every tool the profile needs and assign a risk level to each one. Tools should have
small, predictable inputs and deterministic result shapes.

| Access level | Typical use | Default posture |
| --- | --- | --- |
| `read-only` | Read files, inspect metadata, search local text. | Usually `allow`. |
| `write` | Create or edit artifacts. | Usually `ask`. |
| `destructive` | Run shell commands, move files, delete files, mutate external state. | Usually `ask` or `deny`. |
| `network` | Fetch pages, call APIs, download data. | Profile-specific. |

Write the policy from the profession's risk profile, not from tool availability. A research
agent may allow network access but deny writes. A coding agent may allow read-only file
inspection and ask before writes or commands.

For each tool, record:

- why the profile needs it;
- what permission level it uses;
- whether the default policy is enough or a tool-specific override is required;
- what evidence should appear in the final answer after the tool is used.

## Model And Thinking Economics

Choose model and thinking defaults that fit the profile's value per turn.

- Use higher thinking for work where wrong plans are expensive: coding, migrations,
  architecture review, incident analysis.
- Use lower thinking for simple transformation work: formatting, extraction,
  summarization, and routine classification.
- Record the reason for the default so later changes can be reviewed as product decisions.
- Keep provider-specific limits visible. For example, DeepSeek V4 Pro maps only higher
  thinking requests such as `high` and `xhigh`.

The default should be economical, not maximal. Profiles can still expose overrides for
one-off difficult tasks.

## Context Tuning

Context settings define what survives long sessions. Every profile should document what
must remain intact after compaction.

Examples:

- Coding: file paths, changed files, test commands, failing output, decisions, unresolved
  blockers.
- Research: sources, citations, claim/evidence pairs, date boundaries, unresolved
  verification gaps.
- Data analysis: dataset schemas, filters, derived metrics, assumptions, output paths.

Prefer explicit domain compaction instructions over generic "summarize the conversation"
language. If a profile uses token budget ratios, document the intent of each ratio so it
can be tuned against real sessions.

## Skills And Templates

Skills and prompt templates should package repeated workflows, not one-off instructions.

Good candidates:

- review loops such as `/review`, `/fix-tests`, or `/cite`;
- recurring report formats;
- domain-specific checklists;
- reusable prompt shells for common task types.

Keep templates stable and parameterized. Volatile values should be arguments, not embedded
text, so cached prompt prefixes remain reusable.

## Golden Tasks

Define golden tasks while designing the profile. They are the Phase 17 regression contract,
not an afterthought.

Start with 3 to 10 tasks that cover:

- the main happy path;
- one permission or refusal boundary;
- one context-heavy or multi-turn task;
- one cost-sensitive task;
- one task that should preserve a specific output format.

Each task should state the prompt, fixture needs, expected files or output pattern,
forbidden tools, maximum turns, and cost ceiling. A profile is not ready for production
until its behavior can be measured against these tasks.

## Profile Checklist

Before registering a new profile, confirm:

- mission, boundaries, and done criteria are written down;
- system prompt uses stable cache-aware section order;
- tool inventory has access levels and policy rationale;
- model and thinking defaults include an economic rationale;
- context compaction instructions preserve domain-critical facts;
- skills and templates cover repeated workflows only;
- golden tasks exist before implementation expands.
