# pi-harness Production-Readiness Plan (Phases 7–12)

Phases 1–6 (scaffolding, tools/permissions, context/cache, cost tracking, CLI, specializations)
are complete: 24 source files, zero type errors, 34/34 tests passing. This plan covers what is
missing between "works in development" and "production-ready."

## Audit findings that drive this plan

These are concrete defects/gaps in the current code, not hypotheticals:

1. **Build is broken.** `package.json` declares `"build": "tsc -p tsconfig.build.json"` and
   `main`/`types`/`bin` all point at `dist/`, but `tsconfig.build.json` does not exist and the
   root `tsconfig.json` has `noEmit: true`. `npm run build` fails; the package cannot be
   published or installed as a bin.
2. **Context trimming is lossy and cache-hostile.** `ContextManager.keepRecentSuffix()`
   (src/context/manager.ts:38) silently drops the oldest messages once over the warm budget.
   Three problems: (a) information is lost with no summary (Tier 2 "cold" from the original
   plan was never wired to compaction); (b) once over budget, every turn re-trims at a
   different boundary, so the prompt prefix changes each request and DeepSeek's automatic
   prefix cache misses — defeating the 120x cacheRead saving the whole design exists for;
   (c) trimming can split an assistant tool-call message from its tool-result message,
   which providers reject with a 400.
3. **`keepRecentSuffix` is O(n²).** It calls `estimateContextTokens()` on a growing slice
   inside a loop. Fine at 50 messages, pathological at 2,000.
4. **No real tools.** Only `echo` exists. The harness cannot read a file or run a command,
   so no specialization is actually usable yet.
5. **No session resume.** `createJsonlSession()` only calls `repo.create()`. Every CLI run
   starts a fresh session; conversations cannot be continued and the JSONL persistence is
   write-only in practice.
6. **No retry/error policy.** A single 429 or transient network error from the provider
   aborts the turn. No backoff, no Retry-After handling, no fatal-vs-transient distinction.
7. **No SIGINT handling.** Ctrl+C kills the process mid-turn instead of aborting the turn;
   `AgentHarness.abort()` is exposed but never wired to a signal.
8. **No config files or permission persistence.** Everything comes from CLI flags or env
   vars; an "ask" answer is forgotten immediately (no "always allow").
9. **Weak typing in specializations.** `CodingSpecializationOptions.defaultModel?: unknown`
   (src/specializations/coding.ts:9) discards the `Model<Api>` type.
10. **No README/docs/examples.** A new consumer has nothing to start from.

Priority order: Phase 7 and Phase 8 are P0 (build correctness + the context/cache defect).
Phase 9 is P1 (the harness becomes actually useful). Phases 10–12 are P2 hardening.

---

## Phase 7: Build, Packaging, CI  (P0 — currently broken)

**Goal**: `npm run build` produces a publishable `dist/`; CI guards every change.

**Files**:
```
tsconfig.build.json             # emit config
package.json                    # exports map, publishConfig
.github/workflows/ci.yml        # typecheck + test + build on Node 22
```

**Key design**:
- `tsconfig.build.json` extends root config with `noEmit: false`, `outDir: "dist"`,
  `declaration: true`, `sourceMap: true`, `rewriteRelativeImportExtensions: true`
  (TS ≥ 5.7; required because source uses `.ts` extension imports under
  `allowImportingTsExtensions`), `include: ["src/**/*.ts"]` (exclude tests).
- Add an `exports` map: `"."` → `dist/index.js`, `"./cli"` → `dist/cli/index.js`,
  plus `types` conditions. Keep `bin` pointing at `dist/cli/index.js` and verify the
  shebang survives emit.
- CI: `npm ci && npm run typecheck && npm test && npm run build`, then a smoke step that
  runs `node dist/cli/index.js --help` to prove the emitted output actually executes.
- Set `"version": "0.1.0"`, add `publishConfig.access` if publishing; otherwise mark
  `"private": true` deliberately.

**Verification**: fresh clone → `npm ci && npm run build && node dist/cli/index.js --help`.

---

## Phase 8: Real Compaction (fix the context tier model)  (P0 — correctness/cost defect)

**Goal**: Replace lossy suffix-trimming with PI Agent's native compaction so Tier 2 (cold)
actually exists, history is summarized instead of dropped, and the prompt prefix stays
stable for prefix caching.

**Files**:
```
src/context/manager.ts          # rework
src/context/compaction-policy.ts  # new: when/how to compact
test/context-cache.test.ts      # extend
```

**Key design**:
- `CompactionPolicy`: after each turn (subscribe to `turn_end`), compute tokens via
  `estimateContextTokens()`; when over the warm budget high-water mark (e.g. 85%),
  call `shouldCompact()` / `harness.compact()` from pi-agent-core. Compaction produces a
  summary entry in the session tree (this *is* Tier 2), and the post-compaction prefix is
  then stable again → cache-friendly.
- The `on("context")` hook becomes a **safety net only**: if a single context still exceeds
  the hard limit (compaction failed or raced), trim — but trim at message-pair boundaries
  (never separate an assistant tool-call from its tool results) and log a warning event.
- Fix the O(n²) estimator: walk messages once from the tail accumulating per-message token
  estimates, instead of re-estimating growing slices.
- Make thresholds configurable on `HarnessConfig`: `compaction: { enabled, highWaterRatio,
  customInstructions? }`.

**Verification**: synthetic 100-turn conversation test (mock model) asserting: compaction
fires once past high-water; no tool-call/result pair is ever split; the message list sent
to the provider shares its prefix with the previous turn except after compaction.

---

## Phase 9: Real Built-in Tools + Sandboxing  (P1)

**Goal**: A usable default toolset so the harness and the coding specialization do real work.

**Files**:
```
src/tools/builtin/read.ts       # read-only
src/tools/builtin/write.ts      # write
src/tools/builtin/edit.ts       # write
src/tools/builtin/ls.ts         # read-only
src/tools/builtin/grep.ts       # read-only
src/tools/builtin/glob.ts       # read-only
src/tools/builtin/bash.ts       # destructive (shell via ExecutionEnv)
src/tools/builtin/fetch.ts      # network
src/tools/sandbox.ts            # path confinement
src/tools/builtin/index.ts      # createDefaultToolset()
```

**Key design**:
- All file tools go through the harness's `ExecutionEnv` (`NodeExecutionEnv`), never raw
  `node:fs`, so they inherit the env's cwd and remain testable with an in-memory env.
- `sandbox.ts`: `resolveWithinRoot(root, requestedPath)` — resolves and rejects any path
  that escapes the configured root (handles `..`, absolute paths, and Windows drive-letter
  and UNC forms; this project runs on Windows, test those cases explicitly). Config:
  `sandbox: { roots: string[] }`, default `[cwd]`.
- `bash` tool: runs through `env.exec` (or PowerShell on win32), with `timeoutMs` (default
  120s), output truncation (default 30k chars), and the access level `"destructive"` so the
  default policy is "ask".
- `fetch` tool: GET-only by default, response size cap, access level `"network"`.
- Output shaping: every tool truncates large results and says so in the result text —
  unbounded tool output is the fastest way to blow the context budget Phase 8 manages.
- Optional peer-dep path (from the original plan): `createCodingSpecialization()` tries a
  dynamic import of `@earendil-works/pi-coding-agent` tools and falls back to the builtins.
- While here: change `defaultModel?: unknown` to `defaultModel?: Model<Api>` in
  `src/specializations/coding.ts` and `types.ts`.

**Verification**: REPL session — "read package.json and summarize it" works; "delete X"
prompts for permission; a path like `..\..\Windows\system32\drivers\etc\hosts` is refused;
unit tests for sandbox edge cases on Windows paths.

---

## Phase 10: Resilience — Retries, Abort, Crash Recovery  (P1)

**Goal**: Transient provider failures don't kill turns; Ctrl+C is graceful; a crashed
session can be reopened.

**Files**:
```
src/resilience/retry.ts         # backoff policy
src/resilience/errors.ts        # classification: fatal vs transient
src/cli/signals.ts              # SIGINT wiring
src/session/recovery.ts         # JSONL tail validation/repair
```

**Key design**:
- `RetryPolicy`: exponential backoff with full jitter, default 4 attempts, honor
  `Retry-After` when present. Classify: 401/403/400 → fatal (no retry, clear message
  pointing at the env var name from `getEnvApiKeyVarName(provider)`); 408/429/5xx/network
  → transient. Wire at the `GenericHarness.prompt()` boundary (wrap the turn), and emit a
  `retry` event so the renderer can show "retrying (2/4) in 3.2s…".
- SIGINT in REPL: first Ctrl+C during a turn → `harness.abort()` and return to prompt;
  second within 2s, or Ctrl+C at the idle prompt → exit cleanly (unsubscribe, close
  readline). One-shot mode: abort and exit 130.
- Crash recovery: on `repo.open()` (Phase 11), validate the last JSONL line; if it's a
  truncated partial write, drop it and log. Never let one corrupt line make a whole
  session unloadable.

**Verification**: tests with a mock transport that fails with 429 twice then succeeds
(assert 3 attempts, jittered delays, final success); a test that aborts mid-stream and
asserts the session is still appendable; a corrupt-tail JSONL fixture that opens cleanly.

---

## Phase 11: Session Lifecycle + Layered Config + Permission Persistence  (P2)

**Goal**: Sessions are resumable and discoverable; configuration lives in files; "always
allow" survives the answer.

**Files**:
```
src/session/factory.ts          # add openJsonlSession(), listSessions()
src/config-file.ts              # load + merge config layers
src/tools/permission-store.ts   # persisted decisions
src/cli/index.ts                # --resume <id>, --continue, --list-sessions
src/cli/repl.ts                 # /sessions command
```

**Key design**:
- Resume: `--continue` opens the most recent session for the cwd; `--resume <id>` opens a
  specific one (use `JsonlSessionRepo`'s open/list APIs; confirm exact method names against
  `G:\pi-agent\packages\agent\src\harness\session\jsonl-repo.ts` before coding). Resume is
  also what makes DeepSeek's `requiresReasoningContentOnAssistantMessages` compat matter:
  add a test that a resumed session round-trips assistant reasoning content without a
  provider 400.
- Config layering, highest wins: CLI flags > `./pi-harness.json` (project) >
  `~/.pi-harness/config.json` (user) > built-in defaults. Schema-validate with typebox
  (already a dependency) and fail with the offending key path. `HarnessConfig` is already
  the merge target; `resolveHarnessConfig()` gains a `loadConfigLayers(cwd)` front-end.
- Permission persistence: extend the ask prompt to `y / n / a (always) / d (never)`;
  "always"/"never" write a per-tool `PermissionLevel` into the project config's
  `policy.tools` map via `permission-store.ts`. In-memory session-scoped allows for plain "y".
- API keys never get written to config files — env vars or `--api-key` only; the config
  loader rejects an `apiKey` key in a file with a clear error.

**Verification**: run, exit, `pi-harness --continue` → prior context visible to model;
`/sessions` lists entries; answering "a" to a tool prompt updates `pi-harness.json` and
the next call doesn't prompt.

---

## Phase 12: Observability Hardening + Docs  (P2)

**Goal**: Production debuggability (what happened, what did it cost, did the cache work)
and a usable on-ramp for consumers.

**Files**:
```
src/observability/event-log.ts    # JSONL event sink per session
src/observability/cache-report.ts # predicted vs actual cache effectiveness
src/observability/budget.ts       # spend limits
src/observability/redact.ts       # secret scrubbing
README.md, docs/specialization-guide.md, examples/
```

**Key design**:
- Event log: subscribe to all harness events, append one JSON line per event to
  `.pi-harness/sessions/<id>.events.jsonl` (tool calls + durations, retries, permission
  decisions, per-turn Usage). All payloads pass through `redact.ts` (mask values of keys
  matching /key|token|secret|password|authorization/i and `Bearer …` strings).
- Cache report: `CacheStrategyEngine` records its decision per request; `CostTracker`
  already records actual `cacheRead`. `cache-report.ts` joins them: expected strategy vs
  achieved hit rate, with a warning when hit rate drops sharply turn-over-turn (the
  signature of prefix invalidation — this is the regression detector for Phase 8).
  Add `/cache` REPL command rendering it.
- Budgets: `budget: { maxUsdPerSession?, warnAtUsd? }` in config; warn on cross, refuse
  new turns past the hard cap with a clear message (don't kill the process).
- Docs: README (install, quickstart, config reference, REPL commands), specialization
  guide (walk through building a research agent: tools + policy + prompt), `examples/`
  with a runnable one-shot script and a custom-tool example.

**Verification**: a session produces a well-formed events JSONL with no secrets in it
(test feeds an Authorization header through a tool arg and asserts masking); cache report
shows >0 hit rate on a 3-turn DeepSeek conversation; budget test stops at the cap.

---

## Testing strategy across phases

- Keep the existing 34 unit tests green; each phase adds its own suite.
- Add `test/mocks/mock-transport.ts` — a scripted pi-ai transport (returns canned stream
  events, injectable failures) so retry/compaction/integration tests run offline and fast.
- One gated e2e smoke (`test/e2e.smoke.test.ts`, skipped unless `DEEPSEEK_API_KEY` is set):
  one-shot prompt, asserts a non-empty response and non-zero usage.
- CI runs on `windows-latest` and `ubuntu-latest` — the sandbox and shell-tool code paths
  differ by platform and both must be exercised.

## Suggested order

7 → 8 → 9 → 10 → 11 → 12. Phases 7 and 8 are independent and can be done in parallel;
Phase 9's bash tool benefits from Phase 10's timeout/abort plumbing but doesn't require it.
