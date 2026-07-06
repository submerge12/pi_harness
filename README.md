# pi-harness

A generic, cache-aware TypeScript LLM agent harness built by composition on top of
[PI Agent](https://www.npmjs.com/package/@earendil-works/pi-agent-core). The core is
domain-neutral; specialization comes from composing tools, prompts, and policy into
**agent profiles** — not from subclassing.

Three ideas distinguish it from mainstream agent frameworks:

1. **Cache economics as an architectural invariant.** Context is managed in three tiers
   (byte-stable frozen prefix → append-only warm history → compact-to-cold summaries).
   Pruning only fires when the tokens saved outweigh the one-time cost of busting the
   provider's prefix cache, and a cache report reconciles the *expected* strategy against
   the *actual* per-turn hit rate.
2. **Evidence-gated completion.** A worker–reviewer repair loop where "done" is
   structurally unfakeable: completion claims require successful receipts inside the
   contract's write scope, a blind reviewer judges the real git diff (never the worker's
   self-report — transcript access is a compile error), acceptance criteria are
   machine-checked (`exit-zero`, `file-exists <path>`, `test-command <cmd>`,
   `contains <text>`), failed attempts rewind to a binary-safe pre-attempt baseline, and
   review verdicts feed the next attempt as digests and TTL'd lessons.
3. **Conformance-gated model onboarding.** A model may not touch real work until it
   passes a capability suite with self-validating graders (every task ships a golden the
   grader must pass and counterexamples it must reject) plus mandatory adversarial
   probes for honesty and write-boundary respect. Per-model behavior (window, tool-calling
   mode, failure signatures, cost, cache) lives in declared `ModelProfile` data — generic
   modules consume fields, never model names.

## Feature highlights

- **Tool safety**: registry with `deny > ask > allow` permission gating enforced *inside*
  dispatch (a later event hook cannot override a deny), access levels
  (read-only / write / destructive / network), write-scope leases, and worktree isolation.
- **Secret hygiene**: a single redaction core (key/value assignments, Bearer tokens,
  registered known-secret values) applied to event logs, evidence, traces, and human-gate
  persistence; config files that contain an `apiKey` are rejected outright. An end-to-end
  test seeds a secret through a real tool run and sweeps every persisted artifact.
- **Request lifecycle**: intake → routing → skill selection (JIT progressive disclosure) →
  memory recall → schema-validated TaskContract execution → receipts → worker–reviewer
  loop → normalized, schema-validated results.
- **Memory with provenance**: trust levels (`user_confirmed` > `tool_evidenced` >
  `model_inferred`), receipt-linked trust promotion, TTLs, and recall-time GC;
  model-inferred facts never enter background context.
- **Resilience and cost control**: classified retries with full-jitter backoff and
  Retry-After support, per-model failure-signature classification (refusal / loop /
  truncation) wired into retry policy, and a hard session budget re-checked after every
  provider turn — mid-prompt, not just between prompts.
- **Model adapters**: a prompted-JSON tool-calling shim (with repair re-prompt) for models
  without native tool calls.
- **Observability**: redacted event logs, stage traces, cost tracking, cache reports, and
  a CJK-aware token estimator calibrating compaction thresholds.

## Quickstart

Requires Node.js ≥ 22.19.

```bash
npm install
npm run check   # typecheck
npm test        # vitest suite (500+ tests, incl. a real-AgentHarness integration tier)
```

The default provider is DeepSeek; set the key in your environment (never in files):

```bash
export DEEPSEEK_API_KEY="..."        # bash
$env:DEEPSEEK_API_KEY = "..."        # PowerShell
```

Run the interactive REPL (Ink TUI):

```bash
npx pi-harness
```

One-shot prompt and custom-tool examples:

```bash
node --experimental-strip-types examples/one-shot.ts "Say exactly: ok"
node --experimental-strip-types examples/custom-tool.ts
```

Batch execution — pipe a TaskContract JSON in, get a NormalizedResult JSON out:

```bash
node --experimental-strip-types src/adapter-run.ts --task-file task.json
```

Run the model conformance suite against a live model (opt-in, paid):

```bash
node --experimental-strip-types scripts/run-conformance.ts --live
```

## Agent profiles

Built-in profiles: `coding`, `research`, `data-analysis` — plus `compass-health`, a
domain profile that activates only when the **optional** private `compass-health-agent`
package is present (it is an `optionalDependencies` entry; without it, install, build,
typecheck, and the test suite all still pass, and the profile is simply not registered).

Scaffold a new profile:

```bash
npm run new-agent -- <name>
```

The script copies the template into `src/agents/profiles/<name>/` and registers it.
See `docs/agent-design-guide.md` and `docs/specialization-guide.md`.

## Architecture

```
┌────────────────────────── GenericHarness (composition) ─────────────────────────┐
│ prompt/skill/runRequest · retries · compaction · budget · cost · event log      │
│   ├── context/   three-tier lifecycle · prune planner · JIT skills · estimator  │
│   ├── cache/     provider cache profiles · strategy engine · hit-rate report    │
│   ├── tools/     registry · permission gate (in-dispatch) · sandbox             │
│   ├── model-profiles/ + model-adapters/   declared per-model behavior           │
│   └── PI AgentHarness (@earendil-works/pi-agent-core)  ← the inner loop         │
├── lifecycle/    intake → route → skill → memory → contract execution            │
├── orchestration/  worker–reviewer state machine · rewind · human gates          │
├── review/       blind review · evidence cross-check · acceptance criteria      │
├── feedback/     receipts ledger (completion gate) · verdict digests · lessons  │
├── evidence/ + redaction/   receipts, manifests, secret masking                  │
└── conformance/  capability tasks + honesty / write-boundary probes              │
```

Design docs in `docs/`: `AGENT-ARCHITECTURE.md`, `context-cache-design.md`,
`request-lifecycle-architecture.md`, `harness-engineering-framework.md`, and a per-file
inventory in `file-responsibility-summary.md`. The post-review repair plan with its
review standards lives in `PLAN-repair.md`.

## Configuration

Programmatic configuration is resolved with `resolveHarnessConfig`; a layered config-file
loader is also provided (which rejects any `apiKey` field — keys come from the
environment or `--api-key` only).

| Field | Default | Description |
| --- | --- | --- |
| `cwd` | `process.cwd()` | Working directory for session and tool context. |
| `sessionsRoot` | `.pi-harness/sessions` | JSONL session storage root. |
| `provider` / `modelId` | `deepseek` / `deepseek-v4-pro` | Derived from the default ModelProfile. |
| `thinkingLevel` | `off` | Reasoning effort passed to the model. |
| `policy` | least-privilege | `deny > ask > allow` defaults per tool access level. |
| `budget` | `undefined` | `warnAtUsd` / `maxUsdPerSession` hard cap. |
| `reviewLoop` | disabled | Enables the worker–reviewer loop with git diff source. |
| `tools` / `toolRegistrations` | `undefined` | Custom tools (always permission-gated). |

## REPL commands

| Command | Description |
| --- | --- |
| `/cost` · `/cache` | Session cost and expected-vs-actual cache summary. |
| `/sessions` | List persisted sessions. |
| `/model [provider/model]` | Show or switch the model. |
| `/thinking [level]` | Show or set thinking level (`off`…`xhigh`). |
| `/compact [instructions]` | Compact context. |
| `/quit` | Exit. |

## Status and roadmap

The harness is a working system with 500+ behavioral tests, including an integration
tier that drives the real PI `AgentHarness` loop (also serving as the upgrade gate for
the pinned pi-agent-core version). Known gaps, deliberately not yet built: token/event
streaming, durable mid-loop resume, MCP client support, OTel-standard telemetry export,
and a parallel plan executor. The intent is to adopt standards for those layers and keep
the originality budget on context economics and feedback integrity.

## License

[MIT](./LICENSE)
