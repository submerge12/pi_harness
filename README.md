# pi-harness

**English** | [简体中文](README.zh-CN.md)

A reusable TypeScript runtime for building tool-using AI Agents on top of
[PI Agent](https://www.npmjs.com/package/@earendil-works/pi-agent-core).

pi-harness adds the runtime services needed to turn a model response into a controlled task loop:
context management, tool permissions, sessions, memory provenance, retries, budgets, review, and
observable results. Domain behavior is added through composable Agent Profiles.

## Key features

- native and prompted-JSON tool calling;
- permission-gated tool dispatch with read, write, destructive, and network levels;
- three-tier context management for stable prefixes, active history, and compacted history;
- provider-aware cache strategy and token/cost reporting;
- JSONL sessions, checkpoints, retries, and session budgets;
- memory entries with source, trust level, and expiry;
- worker-reviewer repair loops and machine-checkable acceptance criteria;
- opt-in [automatic goal verification and strict PowerShell 7 sessions](docs/goal-gate.md);
- redacted event logs, receipts, traces, and cache reports;
- pluggable Agent Profiles for coding, research, data analysis, and domain products.

## Quick start

Requires Node.js 22.19 or later.

```bash
npm install
npm run check
npm test
npx pi-harness
```

Run one task without the interactive interface:

```bash
node --experimental-strip-types examples/one-shot.ts "Say exactly: ok"
```

Run a TaskContract and receive a NormalizedResult:

```bash
node --experimental-strip-types src/adapter-run.ts --task-file task.json
```

## Agent Profiles

Built-in profiles include `coding`, `research`, and `data-analysis`. Products can register their
own prompts, tools, context builders, and policies without changing the generic runtime.

```bash
npm run new-agent -- <name>
```

## Current availability

The runtime has 500+ behavioral tests, including an integration tier that drives the real PI
`AgentHarness` loop and serves as the upgrade gate for the pinned pi-agent-core version. JSONL
sessions are persistent. MCP servers can be attached as a stdio tool source. The default user-memory
store is currently in-process; persistent user memory, durable mid-run resume, OpenTelemetry export,
streaming, and a generic parallel plan executor are not presented as shipped features.

AOH's reviewed `PI-HARDENING` successor plan is queued to close production-path effect
authorization, attempt-scoped write authority, logical effect idempotency, and persisted
exact-model qualification; it is not active until the current AOH Control Room board closes.

## Public repository contents

The public repository contains runtime source, tests, public docs, examples, and non-secret
configuration samples. Sessions, user memory, provider responses, raw traces, conformance outputs,
cost logs, caches, worktrees, credentials, and other development-only files remain local.

## License

[MIT](./LICENSE)
