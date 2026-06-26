# CLAUDE.md

Guidance for Claude Code when working in `pi-harness`. This file is the operating
contract; the deep design rationale lives under `docs/` (see "Reference docs" at the end).

## What this project is

`pi-harness` is a standalone, generic TypeScript LLM harness built **on top of** PI Agent
(`@earendil-works/pi-agent-core` + `@earendil-works/pi-ai`, v0.76.0). It wraps
`AgentHarness` by **composition** (`GenericHarness`, `src/harness.ts`) and layers on:

- three-tier cache-aware context management + provider-adaptive caching,
- tool registry with `deny > ask > allow` permission gating,
- cost/budget tracking and redacted event logging,
- a pluggable **agent profile** system (coding / research / data-analysis / compass-health),
- an agent-orchestration layer: request lifecycle, task contracts, worker–reviewer repair
  loop, evidence capture, human gates.

Design stance is **generic-first**: the core harness is domain-neutral; specialization comes
from composing tools + system prompts + policy via an `AgentProfile`, not from subclassing.
DeepSeek V4 Pro (`provider: deepseek`, `modelId: deepseek-v4-pro`) is the default model.

## Commands

| Task | Command |
| --- | --- |
| Typecheck (the `check` gate) | `npm run check` (alias for `npm run typecheck` → `tsc --noEmit`) |
| Run tests | `npm test` (`vitest --run`) |
| Run one test file | `npx vitest --run test/<file>.test.ts` |
| Build publishable `dist/` | `npm run build` (`tsc -p tsconfig.build.json`) |
| Regenerate JSON schemas | `npm run emit-schemas` (writes `schemas/*.json` from TypeBox) |
| Scaffold a new agent profile | `npm run new-agent -- <name>` |
| Interactive REPL | `npx pi-harness` |
| One-shot prompt | `node --experimental-strip-types examples/one-shot.ts "..."` |

Requires Node ≥ 22.19. The default provider needs `DEEPSEEK_API_KEY` in the environment
(`.env` is git-ignored; never commit it). After any change, `npm run check` **and**
`npm test` must both pass — keep the suite green.

## Conventions

- **TypeScript ESM, `NodeNext`.** Imports use explicit `.ts` extensions
  (`allowImportingTsExtensions`); keep that style. The public surface is re-exported through
  `src/index.ts` barrels — add new modules there when they are part of the API.
- **`erasableSyntaxOnly` is on.** No `enum`, no `namespace`, no parameter-property
  constructors, no other runtime-emitting TS syntax. Use `const` objects + union types and
  plain assignments instead.
- **Indentation is tabs** (see `tsconfig.json`). Match the surrounding file.
- **Schemas are TypeBox.** Define in `src/**/schemas/*.ts`, then `npm run emit-schemas` to
  refresh `schemas/*.json`. Don't hand-edit the generated JSON.
- **Tests are vitest**, colocated under `test/` mirroring `src/`. Prefer in-memory
  repos/stores and a mock transport over disk or network I/O.

## Invariants — do not break these

These encode the reasons the design exists; violating them silently regresses cost or
correctness.

1. **Append-only / frozen prefix for cache stability.** Active history (Tier 1 "warm") is
   append-only and is never reordered mid-session. The pinned prefix (system prompt + tool
   definitions, Tier 0) stays byte-stable so DeepSeek's automatic-prefix cache hits — that
   cache is ~120× cheaper than uncached input and is the whole point of the cache layer.
   When you must shed context, **compact** (summarize into Tier 2 "cold") rather than trim;
   the `on("context")` trim hook is a last-resort safety net only.
2. **Never split a tool-call from its tool-result.** Any trimming/pruning operates on
   message-pair boundaries; separating an assistant tool-call message from its result causes
   provider 400s.
3. **No secrets in files.** API keys come from env vars or `--api-key` only; the config
   loader rejects an `apiKey` field in any config file. All event-log / evidence payloads
   pass through redaction (`src/observability/redact.ts`, `src/evidence/redactor.ts`) — mask
   key/token/secret/password/authorization values and `Bearer …` strings. A secret must
   never reach a committed evidence file, manifest, or trace.
4. **Claimed work needs evidence.** The worker–reviewer completion gate
   (`src/feedback/ledger.ts`) refuses to mark work done without supporting receipts. Don't
   bypass it or assert a capability is implemented without a passing test/eval behind it.
5. **Permissions default to least privilege.** `deny > ask > allow`; read-only tools run
   parallel, write/destructive tools run sequential. New tools must declare an
   `accessLevel` (`read-only | write | destructive | network`).

## Architecture map (`src/`)

Pure/leaf modules have no I/O and are the safest to change; orchestration modules wire them
together.

- **Core harness** — `harness.ts` (`GenericHarness`: model/session setup, prompt execution,
  retries, compaction, pruning, cost/budget/event logging, tool wiring), `config.ts` +
  `config-file.ts` (layered config, secret rejection), `model-resolver.ts`.
- **Agents & profiles** — `agents/profile.ts` (`AgentProfile` contract), `agents/merge.ts`,
  `agents/registry.ts`, `agents/create-agent.ts` (builds a harness from a profile), and
  built-ins under `agents/profiles/` (`coding`, `research`, `data-analysis`,
  `compass-health`, `_template`).
- **Cache / context** — `cache/` (provider cache profiles + strategy engine),
  `context/` (token budget, compaction policy, lifecycle tiers, JIT skill loading, relevance
  detection, prune planner/executor).
- **Tools / policy / execution / evidence** — `tools/` (registry, sandbox, permission gate,
  built-ins incl. `spawn-agent` delegation), `policy/` (scoped permission profiles &
  decisions), `execution/` (worktree isolation + write-scope), `evidence/` (capture,
  manifest, redaction, receipts), `checkpoint/`.
- **Request lifecycle & contracts** — `lifecycle/entry.ts` (intake → routing → skill select →
  memory recall/write → task-contract execution → receipts → worker–reviewer loop),
  `intake/`, `routing/`, `contract/` (task contract, plan package, plan validator),
  `runtime/` (generic executor + `pi-adapter`).
- **Review & orchestration** — `review/` (blind review + cross-check gate, reviewer agent),
  `orchestration/` (worker–reviewer state machine, coordinator repair loop, human-gate
  persistence).
- **Memory / trace / feedback / skills** — `memory/`, `trace/`, `feedback/`, `skills/`.
- **Observability / resilience** — `observability/` (cost tracker, cache report, budget,
  event log, redact, formatter), `resilience/` (error classification + retry/backoff).
- **CLI / sessions / DB / notifications / scheduler** — `cli/` (REPL, renderer, signals,
  permission prompts), `session/` (JSONL sessions, recovery, domain session), `db/` (Drizzle
  + Postgres), `notifications/`, `scheduler/`.

## Working rules

- This repo **is directly editable** (Holly's standing exception). Sibling projects
  (MathPilot, knowledge-showcase, compass-health, Multica, pi-agent) remain **read-only** —
  build alongside, don't modify them. Note `compass-health-agent` is a `file:` dependency.
- Verify permission/sandbox/compat gates **in the target runtime**, not from an unrelated
  shell. If you can't match the runtime identity, report INCONCLUSIVE rather than asserting
  PASS.
- "Explain X" means answer in chat — don't edit files unless explicitly asked to change them.

## Reference docs

- `docs/AGENT-ARCHITECTURE.md` — pluggable agent-profile architecture.
- `docs/agent-design-guide.md` / `docs/specialization-guide.md` — how to build a new profile.
- `docs/context-cache-design.md` — context eviction, cache recovery, tool-set stability.
- `docs/request-lifecycle-architecture.md` — the request pipeline.
- `docs/worker-reviewer-loop-plan.md` (+ repair/completion) — the repair loop.
- `docs/file-responsibility-summary.md` — per-file inventory (keep in sync when adding files).
- `docs/harness-engineering-framework.md` — engineering principles.
- `PLAN.md`, `PLAN-agents.md`, `PLAN-cache-pruning.md` — phased build plans; `docs/*-execution-log.md` track what was done.
- `construction.md` — broad (Chinese) architecture overview.
