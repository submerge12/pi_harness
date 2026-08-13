# pi-harness

A generic, cache-aware TypeScript LLM agent harness built by composition on top of
[PI Agent](https://www.npmjs.com/package/@earendil-works/pi-agent-core). The core is
domain-neutral; specialization comes from composing tools, prompts, and policy into
**agent profiles** — not from subclassing.

## 中文概览

pi-harness 是构建在 PI Agent 内循环之上的通用 TypeScript Agent 运行时。大模型 API 只能给出
一次响应；harness 负责把 prompt、context、工具、权限、状态、反馈和验证组织成可以持续执行、
失败可见、结果可证明的任务闭环。业务能力通过 Agent Profile 组合注入，核心不依赖具体领域。

已实现的重点能力：

- **三层上下文与缓存经济性：** byte-stable frozen prefix、append-only warm history、压缩后的
  cold summary；只有节省 token 的收益超过 cache bust 成本时才裁剪；
- **工具与权限：** registry、`deny > ask > allow`、read/write/destructive/network 访问级别、
  write-scope lease 和 worktree 隔离；
- **完成证据：** 工具 receipt、机器可检查的 acceptance criteria、真实 git diff、blind reviewer、
  失败后恢复基线并把 verdict/lesson 反馈给下一次 attempt；
- **模型接入：** 原生 tool calling 与 prompted-JSON shim、失败分类、重试/预算、按精确模型配置的
  `ModelProfile` 和 conformance gate；
- **可观测性：** 脱敏事件日志、stage trace、成本、cache hit report 和 CJK-aware token 估算；
- **会话与记忆：** JSONL session 持久化；memory 带来源、信任等级和 TTL，但默认用户 memory
  store 仍是进程内实现，尚不能宣称已完成跨进程用户长期记忆。

当前边界：production-path effect authorization、并发安全的 attempt scope、非文件副作用幂等、
持久化模型资格证明正在 AOH 的 `PI-HARDENING` 后续计划中；token/event streaming、durable
mid-loop resume、MCP、OTel 和通用并行 plan executor 尚未实现。

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
the pinned pi-agent-core version). AOH's reviewed `PI-HARDENING` successor plan is queued
to close production-path effect authorization, attempt-scoped write authority, logical
effect idempotency, and persisted exact-model qualification; it is not active until the
current AOH Control Room board closes. Other known gaps, deliberately not yet built:
token/event streaming, durable mid-loop resume, MCP client support, OTel-standard
telemetry export, persistent user-memory storage, and a parallel plan executor. The
intent is to adopt standards for those layers and keep the originality budget on context
economics and feedback integrity.

## License

[MIT](./LICENSE)
