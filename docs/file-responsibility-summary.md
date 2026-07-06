# G:\pi-harness File Responsibility Summary

Generated/vendor/runtime folders intentionally not expanded: `.git/`, `node_modules/`, `dist/`, `.pi-harness/`, `.tmp/`, `.tmp-observability-test/`. The local `.env` exists for private secrets and was not read into this summary.

## Root and Project Metadata

| File | Responsibility |
| --- | --- |
| `.env` | Local private environment file, currently used for secrets such as DeepSeek API keys; ignored and not safe to commit. |
| `.env.example` | Public environment template showing the required `DEEPSEEK_API_KEY` variable without exposing a real key. |
| `.gitignore` | Defines ignored generated, runtime, log, and local-secret files. |
| `.github/workflows/ci.yml` | GitHub Actions CI: typecheck/test/build on push/PR and scheduled/manual worker-reviewer DeepSeek eval. |
| `AGENT-ARCHITECTURE.md` | Design note for the pluggable agent profile architecture and how external agents integrate. |
| `construction.md` | Broad Chinese architecture document covering harness layers, data flow, tooling, config, and tests. |
| `docker-compose.yml` | Local service composition, mainly shared PostgreSQL infrastructure for DB-backed modules. |
| `package.json` | Node package manifest, exports, CLI bin, scripts, dependencies, and supported Node version. |
| `package-lock.json` | Locked npm dependency graph for reproducible installs. |
| `PLAN.md` | Production-readiness plan for phases 7-12. |
| `PLAN-agents.md` | Customized agent plan covering phases 13-18. |
| `PLAN-cache-pruning.md` | Plan for relevance-based context pruning and cache recovery. |
| `PLAN-repair.md` | Repair plan for security, evidence, runtime, memory, context, and integration-test hardening. |
| `README.md` | User-facing install, quickstart, profiles, configuration, and REPL command documentation. |
| `tsconfig.json` | TypeScript development/typecheck configuration. |
| `tsconfig.build.json` | TypeScript build configuration for emitted package output. |

## Source: Public Entry Points and Core Harness

| File | Responsibility |
| --- | --- |
| `src/index.ts` | Main public barrel export for library consumers. |
| `src/harness.ts` | Core `GenericHarness`: model/session setup, prompt execution, lifecycle integration, retries/model-failure classification, compaction, pruning, cost/budget/event logging, cache reports, and default tool wiring. |
| `src/config.ts` | Harness configuration types, defaults, permission policy defaults, run-policy cloning, and config resolution. |
| `src/config-file.ts` | Loads layered project/user config files, validates schema, rejects secret-bearing unsafe config, and merges overrides. |
| `src/model-resolver.ts` | Resolves provider/model IDs to pi-ai model definitions and reports model resolution errors. |

## Source: Agents and Profiles

| File | Responsibility |
| --- | --- |
| `src/agents/profile.ts` | Core `AgentProfile` contract: model defaults, tools, prompts, policies, skills, templates, and install hooks. |
| `src/agents/merge.ts` | Merges profile config with runtime overrides, system prompts, and stricter permission policies. |
| `src/agents/registry.ts` | Global named profile registry with register/get/list/test-clear helpers. |
| `src/agents/create-agent.ts` | Builds a `GenericHarness` from an `AgentProfile`, resolves profile tools, installs permissions, evidence, review loop runtime, checkpointing, and reviewer spawning. |
| `src/agents/profiles/index.ts` | Registers and re-exports built-in profiles. |
| `src/agents/profiles/_template/README.md` | Template instructions for adding a new built-in profile. |
| `src/agents/profiles/_template/profile.ts` | Skeleton profile object for new agents. |
| `src/agents/profiles/_template/prompt.ts` | Skeleton system prompt for new agents. |
| `src/agents/profiles/coding/profile.ts` | Coding profile definition and its tool registrations. |
| `src/agents/profiles/coding/prompt.ts` | Coding agent system prompt. |
| `src/agents/profiles/coding/skills/fix-tests.ts` | Built-in coding skill card for fixing failing tests. |
| `src/agents/profiles/coding/skills/review.ts` | Built-in coding skill card for code review. |
| `src/agents/profiles/research/profile.ts` | Research profile definition and read/network-oriented tool registrations. |
| `src/agents/profiles/research/prompt.ts` | Research agent system prompt. |
| `src/agents/profiles/data-analysis/profile.ts` | Data-analysis profile and output-scoped tool registrations. |
| `src/agents/profiles/data-analysis/prompt.ts` | Data-analysis agent system prompt. |
| `src/agents/profiles/compass-health/profile.ts` | Compass Health profile wrapper and export. |
| `src/agents/profiles/compass-health/prompt.ts` | Compass Health agent system prompt. |
| `src/agents/profiles/compass-health/tools.ts` | Compass Health tool-context bridge and tool registration factory. |

## Source: Cache, Context, and Compaction

| File | Responsibility |
| --- | --- |
| `src/cache/types.ts` | Cache strategy types and decision contracts. |
| `src/cache/profiles.ts` | Provider/model cache capability profiles. |
| `src/cache/strategy-engine.ts` | Applies cache-retention strategy decisions to provider stream options. |
| `src/context/token-estimator.ts` | Shared token estimator with CJK-aware text counting and structural lower bounds. |
| `src/context/token-budget.ts` | Computes token budget partitions from context-window ratios. |
| `src/context/compaction-policy.ts` | Decides when conversation compaction should run. |
| `src/context/manager.ts` | Binds context-window checks into harness turn lifecycle and trims to valid provider message starts. |
| `src/context/lifecycle.ts` | Defines context tiers, tombstones, frozen prefix invariants, and full-compaction summary structure. |
| `src/context/jit-loader.ts` | Loads just-in-time dynamic skill/tool suffix bodies while preserving prefix stability. |
| `src/context/relevance.ts` | Detects prunable spans such as superseded or oversized tool results and explicit dead-end branches. |
| `src/context/prune-planner.ts` | Builds and applies economic prune plans from relevance candidates. |
| `src/context/prune-executor.ts` | Executes pruning at turn boundaries, prewarms cache, and emits pruning telemetry. |

## Source: Contracts, Runtime, and Request Lifecycle

| File | Responsibility |
| --- | --- |
| `src/contract/index.ts` | Barrel export for task contract, plan package, runtime contract, store, and validation APIs. |
| `src/contract/types.ts` | Plan lint result and error types. |
| `src/contract/store.ts` | JSONL append/read store helpers for contract records. |
| `src/contract/plan-validator.ts` | Validates plan packages for dependency and task consistency. |
| `src/contract/schemas/task-contract.ts` | TypeBox schema for task contracts, constraints, and gate tiers. |
| `src/contract/schemas/plan-package.ts` | TypeBox schema for plan packages and task dependencies. |
| `src/contract/schemas/runtime-contracts.ts` | TypeBox schemas for memory candidates, plan amendments, and domain handoff packages. |
| `src/runtime/types.ts` | Generic executor/runtime adapter contracts. |
| `src/runtime/pi-adapter.ts` | Adapts a pi harness into the generic runtime adapter interface, reports capabilities from merged tool metadata, and maps typed model failures into normalized results. |
| `src/runtime/index.ts` | Barrel export for runtime adapters and normalized result schemas. |
| `src/runtime/schemas/normalized-result.ts` | TypeBox schema for normalized execution/test/usage results, including typed model-failure errors. |
| `src/lifecycle/types.ts` | Request lifecycle input, harness, trace, memory, loop, model-failure, and result types. |
| `src/lifecycle/defaults.ts` | Builds default lifecycle dependencies, skill registry cards, runtime options, and declared tool prefix metadata. |
| `src/lifecycle/entry.ts` | Main request pipeline: intake, routing, skill selection, memory recall/write, task-contract execution, explicit done-claim protocol, receipts, and worker-reviewer loop. |
| `src/lifecycle/index.ts` | Barrel export for lifecycle entry, defaults, and types. |
| `src/intake/index.ts` | Extracts hard constraints and determines whether raw requests need clarification. |
| `src/routing/index.ts` | Routes raw requests or task contracts to execution paths and skill candidates. |

## Source: Tools, Policy, Execution, Evidence

| File | Responsibility |
| --- | --- |
| `src/tools/types.ts` | Tool registration, access level, permission policy, and tool-call event types. |
| `src/tools/registry.ts` | Stores tool registrations and converts them into pi-agent tools. |
| `src/tools/metadata.ts` | Merges configured tool surfaces for metadata consumers, preserving profile registrations and config tools with name de-duplication. |
| `src/tools/sandbox.ts` | Path sandbox helpers, writable/existing path resolution, root normalization, and text truncation. |
| `src/tools/permission.ts` | Authoritative permission gate wrappers and decision store for enforcing tool policies at dispatch time. |
| `src/tools/permission-store.ts` | Persists user permission choices into project config. |
| `src/tools/builtin/index.ts` | Creates and exports the default built-in tool registry. |
| `src/tools/builtin/bash.ts` | Sandboxed shell command tool with command rules, timeout, and evidence capture. |
| `src/tools/builtin/read.ts` | Sandboxed file read tool with truncation and path checks. |
| `src/tools/builtin/write.ts` | Sandboxed file write tool with checkpoint/evidence capture. |
| `src/tools/builtin/edit.ts` | Sandboxed search/replace edit tool with evidence capture. |
| `src/tools/builtin/ls.ts` | Sandboxed directory listing tool. |
| `src/tools/builtin/glob.ts` | Sandboxed glob file discovery tool. |
| `src/tools/builtin/grep.ts` | Sandboxed text search tool. |
| `src/tools/builtin/fetch.ts` | Network GET tool with size limits and injectable fetch implementation. |
| `src/tools/builtin/echo.ts` | Simple typed echo tool used for examples/tests. |
| `src/tools/builtin/spawn-agent.ts` | Delegation tool that spawns child agents under inherited policy, depth, task contract, and write-scope constraints. |
| `src/policy/types.ts` | Subject-scoped policy type definitions. |
| `src/policy/subject.ts` | Resolves tool-call arguments into policy subjects such as paths, commands, or URLs. |
| `src/policy/decide.ts` | Applies scoped policy rules and subject glob matching. |
| `src/policy/profiles.ts` | Defines permission profiles, command rules, run policies, and command-rule evaluation. |
| `src/policy/index.ts` | Barrel export for policy APIs. |
| `src/execution/types.ts` | Worktree, process, lease, write-scope, and guard interfaces. |
| `src/execution/write-scope.ts` | Normalizes and validates write scopes and path containment. |
| `src/execution/git-diff-source.ts` | Builds redacted and bounded git diffs for write-scoped worker-reviewer attempts, including staged, unstaged, and untracked files. |
| `src/execution/worktree-provider.ts` | Creates temporary worktrees and process guards for sandboxed worker execution. |
| `src/execution/null-worktree-provider.ts` | No-op worktree provider for cases where isolation is disabled or delegated elsewhere. |
| `src/execution/index.ts` | Barrel export for execution abstractions. |
| `src/evidence/types.ts` | Evidence gateway, manifest, command/output capture, and attribution types. |
| `src/evidence/gateway.ts` | Captures command/output evidence, redacts and UTF-8-safely truncates output, hashes persisted bytes, and appends evidence manifests as JSONL. |
| `src/evidence/manifest.ts` | Append-only JSONL evidence manifest writer and reader with legacy JSON-array fallback. |
| `src/evidence/receipt-collector.ts` | Collects evidence receipts per worker-reviewer attempt. |
| `src/evidence/redactor.ts` | Applies shared secret redaction to command output and detects binary-like output. |
| `src/evidence/index.ts` | Barrel export for evidence APIs. |
| `src/checkpoint/types.ts` | Checkpoint store contracts, including per-attempt write-scope baselines. |
| `src/checkpoint/store.ts` | In-memory and execution-env checkpoint stores, pre-attempt baselines, restore/delete handling, and safe checkpoint path helpers. |
| `src/checkpoint/index.ts` | Barrel export for checkpoint APIs. |

## Source: Review, Orchestration, Trace, Memory, Feedback

| File | Responsibility |
| --- | --- |
| `src/review/verdict.ts` | Review verdict schemas, diff-origin metadata, types, and validation. |
| `src/review/types.ts` | Review target, blind reviewer, cross-checker, and gate interfaces. |
| `src/review/review-gate.ts` | Composes blind review and cross-check review into a review gate. |
| `src/review/reviewer-agent.ts` | Reviewer agent implementations, including prompt-based spawned reviewer parsing/coercion/fallback behavior and diff-injection hardening. |
| `src/review/evidence-cross-check.ts` | Evidence cross-checker that verifies supported criteria and demotes uncheckable PASS claims for human review. |
| `src/review/acceptance-criteria.ts` | Parses string-encoded structured acceptance criteria (exit-zero, file-exists, test-command, contains) for the evidence cross-check. |
| `src/review/index.ts` | Barrel export for review APIs. |
| `src/orchestration/states.ts` | Worker-reviewer run states, legal transitions, and transition-log validation. |
| `src/orchestration/coordinator.ts` | Worker-reviewer repair loop coordinator with completion gate, budget checks, retries, review, diff-origin stamping, checkpoint baseline/restore, and human gate. |
| `src/orchestration/human-gate-decisions.ts` | Human-gate decision schema, sanitized parser warnings, and exact request-id decision matching. |
| `src/orchestration/persistence.ts` | Redacted file-backed loop persistence for human-gate requests/decisions and loop artifacts. |
| `src/orchestration/runtime-adapter.ts` | Re-export bridge for runtime adapter contracts. |
| `src/orchestration/index.ts` | Barrel export for orchestration APIs. |
| `src/trace/types.ts` | TypeBox trace event schema and trace sink contracts. |
| `src/trace/sink.ts` | In-memory and file trace sink implementations. |
| `src/trace/index.ts` | Barrel export for trace APIs. |
| `src/feedback/ledger.ts` | Receipt ledger and completion gate for verifying explicit done claims have supporting evidence. |
| `src/feedback/index.ts` | Barrel export for feedback APIs. |
| `src/memory/schemas/user-memory.ts` | User-memory TypeBox schema and trust enum. |
| `src/memory/store.ts` | In-memory user-memory store with trust upgrading, validity refresh, duplicate upsert handling, and expiry deletion. |
| `src/memory/pipeline.ts` | Writes and recalls user memory records with scope/trust filtering and expired-memory cleanup. |
| `src/memory/default-extractor.ts` | Heuristic extractor for explicit user preference/memory candidates with linked evidence receipt validation. |
| `src/memory/index.ts` | Barrel export for memory APIs. |

## Source: Observability and Resilience

| File | Responsibility |
| --- | --- |
| `src/observability/types.ts` | Cost, usage, turn, and harness event type definitions. |
| `src/observability/redact.ts` | Observability-facing wrapper over the shared secret redaction core. |
| `src/observability/formatter.ts` | Formatting helpers for USD, percentages, token usage, turn costs, and session costs. |
| `src/observability/event-log.ts` | JSONL event log writer with session-safe paths and redacted payloads. |
| `src/observability/cost-tracker.ts` | Tracks per-turn and aggregate token/cost/cache usage from harness events. |
| `src/observability/cache-report.ts` | Records explicit-turn cache decisions, cache-hit drops, pruning events, and renders cache reports. |
| `src/observability/budget.ts` | Enforces/warns on per-turn/session budget limits from usage events. |
| `src/resilience/errors.ts` | Classifies provider errors, retry-after hints, and API-key error messaging. |
| `src/resilience/retry.ts` | Generic retry helper with attempts, backoff, retry events, and abort handling. |
| `src/redaction/core.ts` | Shared redaction engine for secret-pattern masking, registered known-secret masking, and structured payload redaction. |
| `types/compass-health-agent/*.d.ts` | Fallback type stubs for the optional compass-health-agent package, resolved via tsconfig paths when the real package is absent. |

## Source: CLI, Sessions, DB, Notifications, Scheduler, Skills

| File | Responsibility |
| --- | --- |
| `src/cli/index.ts` | CLI argument parsing, help/list output, harness construction, and main CLI entry. |
| `src/cli/repl.ts` | Interactive REPL command loop and slash-command handling. |
| `src/cli/renderer.ts` | CLI rendering for assistant messages, tools, and status output. |
| `src/cli/cost-display.ts` | Formats and writes session cost display information. |
| `src/cli/permission-prompt.ts` | Interactive permission prompts and persistent allow/deny behavior. |
| `src/cli/signals.ts` | SIGINT handling for abort-vs-exit behavior in REPL. |
| `src/session/factory.ts` | Creates, opens, and lists JSONL-backed sessions and execution environments. |
| `src/session/recovery.ts` | Repairs truncated/corrupt JSONL session tails. |
| `src/session/domain-session.ts` | File-backed domain decision/question session store. |
| `src/db/schema.ts` | Drizzle schema for agent events and notifications tables. |
| `src/db/connection.ts` | PostgreSQL pool and database connection creation. |
| `src/db/migrate.ts` | Programmatic migration runner. |
| `src/db/index.ts` | Barrel export for DB schema, connection, and migration APIs. |
| `src/notifications/types.ts` | Notification severity, channel, message, and store interfaces. |
| `src/notifications/manager.ts` | Notification delivery manager and delivery error handling. |
| `src/notifications/channels/console.ts` | Console notification channel implementation. |
| `src/notifications/channels/file-log.ts` | File-log notification channel implementation. |
| `src/notifications/index.ts` | Barrel export for notification APIs. |
| `src/scheduler/types.ts` | Scheduled task and cron-like schedule types. |
| `src/scheduler/scheduler.ts` | Scheduler for profile-based recurring tasks and notification delivery. |
| `src/scheduler/index.ts` | Barrel export for scheduler APIs. |
| `src/skills/types.ts` | Skill-card registry and prefix-index types. |
| `src/skills/registry.ts` | Skill-card registry creation, publish, lookup, prefix index, and matching. |
| `src/skills/schemas/skill-card.ts` | TypeBox schema for skill cards. |
| `src/skills/index.ts` | Barrel export for skill registry and schema APIs. |
| `src/specializations/types.ts` | Legacy specialization framework types and merge helpers. |
| `src/specializations/coding.ts` | Legacy coding specialization helper. |
| `src/model-profiles/types.ts` | ModelProfile seam contract: window, tool-calling mode, prompt dialect, failure signatures, cost, cache hint, strengths. |
| `src/model-profiles/deepseek-v4-pro.ts` | First ModelProfile: all DeepSeek-specific operating assumptions as data. |
| `src/model-profiles/registry.ts` | Model-profile registry: register/get/list/find (exact identity and match hints), default profile. |
| `src/model-profiles/index.ts` | Barrel export for model profiles. |
| `src/model-adapters/failure-classifier.ts` | Classifies model output against bounded profile failure signatures, detects repeated-output loops, and maps kinds onto the retry policy. |
| `src/model-adapters/prompted-json.ts` | Prompted-JSON tool-calling fallback: instruction rendering, strict fenced-JSON envelope parsing, one-shot repair prompt, ToolCall coercion, dispatch loop. |
| `src/model-adapters/index.ts` | Barrel export for model adapters. |
| `src/conformance/types.ts` | Conformance task/outcome/report contracts and mock tool behavior type. |
| `src/conformance/tasks.ts` | Canned conformance tasks (zh-summarization, extraction, tool-use, coding) plus honesty and write-boundary probes with goldens/counterexamples. |
| `src/conformance/runner.ts` | Conformance runner: prompt protocol, self-report parsing, grading, eligibility report. |
| `src/conformance/live-client.ts` | Opt-in real-model conformance client over the prompted-JSON tool loop. |
| `src/conformance/index.ts` | Barrel export for conformance APIs. |
| `src/routing/model-priors.ts` | Declared-strengths prior lookup for routing (no auto-routing). |
| `src/feedback/verdict-digest.ts` | Severity-ordered, deduped failure digest from review verdicts and gate failures for the next worker attempt. |
| `src/feedback/lessons.ts` | Persists blocker findings as per-skill lesson memories and recalls/renders them for prompts. |

## Evals, Schemas, Scripts, Examples, Experiments

| File | Responsibility |
| --- | --- |
| `evals/types.ts` | Eval task, fixture, assertions, executor, and result types. |
| `evals/runner.ts` | Eval runner: fixture preparation, executor invocation, assertions, limits, write-root checks, and markdown result rendering. |
| `evals/fixtures/README.md` | Placeholder/readme for file-based eval fixtures. |
| `evals/coding/tasks/fix-failing-test.json` | Golden eval task for coding agent fixing a failing test. |
| `evals/data-analysis/tasks/outputs-only.json` | Golden eval task for data-analysis output behavior. |
| `evals/research/tasks/citations.json` | Golden eval task for research/citation behavior. |
| `evals/worker-reviewer/run-deepseek.mjs` | Real DeepSeek eval harness for worker-reviewer loop tasks. |
| `evals/worker-reviewer/tasks/correct-task-passes-after-review.json` | Eval that expects a correct repair to reach DONE/PASS with evidence. |
| `evals/worker-reviewer/tasks/seeded-fail-escalates.json` | Eval that expects unsupported completion to escalate to human review. |
| `schemas/domain-handoff-package.schema.json` | Generated JSON schema for domain handoff packages. |
| `schemas/memory-candidate.schema.json` | Generated JSON schema for memory candidate records. |
| `schemas/normalized-result.schema.json` | Generated JSON schema for normalized runtime results. |
| `schemas/plan-amendment.schema.json` | Generated JSON schema for plan amendments. |
| `schemas/plan-package.schema.json` | Generated JSON schema for plan packages. |
| `schemas/skill-card.schema.json` | Generated JSON schema for skill cards. |
| `schemas/task-contract.schema.json` | Generated JSON schema for task contracts. |
| `schemas/trace-event.schema.json` | Generated JSON schema for trace events. |
| `schemas/user-memory.schema.json` | Generated JSON schema for user memory records. |
| `scripts/emit-schemas.mjs` | Emits TypeBox schemas into `schemas/`. |
| `scripts/new-agent.mjs` | Scaffolds a new agent profile from the template and registers it. |
| `examples/custom-tool.ts` | Minimal custom local tool example. |
| `examples/one-shot.ts` | Example that invokes the CLI for a single prompt. |
| `experiments/cache-prune-probe.mjs` | Experimental probe for cache-pruning/provider behavior. |
| `experiments/results/probe-2026-06-12.txt` | Captured output from an earlier cache-prune experiment. |

## Documentation Files

| File | Responsibility |
| --- | --- |
| `docs/agent-design-guide.md` | Practical guide for defining new agent profiles. |
| `docs/context-cache-design.md` | Design note for context eviction, cache recovery, and tool-set stability. |
| `docs/file-responsibility-summary.md` | This inventory of file responsibilities. |
| `docs/harness-engineering-framework.md` | General harness-engineering framework and principles. |
| `docs/harness-engineering-and-improvement-plan.md` | Combined technical framework, shortcomings analysis, and improved plan. |
| `docs/phase-18-completion.md` | Completion report for travel-assistant/pi-harness Phase 18 integration work. |
| `docs/pi-harness-improvement-plan.md` | Detailed pi-harness improvement plan. |
| `docs/pi-harness-improvement-execution-log.md` | Execution log for the improvement plan. |
| `docs/pi-harness-m0-readiness-plan.md` | M0 readiness fix plan. |
| `docs/pi-harness-m0-readiness-execution-log.md` | Execution log for M0 readiness work. |
| `docs/pi-harness-remaining-plan.md` | Remaining execution plan to finish PI executor responsibilities. |
| `docs/pi-harness-remaining-execution-log.md` | Execution log for remaining-plan work. |
| `docs/pi-harness-shortcomings.md` | Current shortcomings audit. |
| `docs/request-lifecycle-architecture.md` | Architecture document for the request lifecycle. |
| `docs/request-lifecycle-execution-log.md` | Execution log for request lifecycle implementation. |
| `docs/request-lifecycle-integration-plan.md` | Plan for integrating lifecycle components into the harness. |
| `docs/request-lifecycle-integration-execution-log.md` | Execution log for request lifecycle integration. |
| `docs/specialization-guide.md` | Guide for defining specializations: job, tools, policy, prompt, observability, tests. |
| `docs/worker-reviewer-loop-plan.md` | Worker-reviewer loop execution plan. |
| `docs/worker-reviewer-loop-execution-log.md` | Execution log for worker-reviewer loop implementation. |
| `docs/worker-reviewer-loop-repair-plan.md` | Repair plan for real-eval worker-reviewer findings. |
| `docs/worker-reviewer-loop-repair-completion.md` | Completion/review report for worker-reviewer repair work. |

## Test Files

| File | Responsibility |
| --- | --- |
| `test/agent-profiles-builtins.test.ts` | Verifies built-in agent profile defaults and tool registration factories. |
| `test/agents-profile.test.ts` | Tests profile merging, registry behavior, `createAgent`, and CLI agent selection. |
| `test/builtin-tools.test.ts` | Tests sandbox path resolution and built-in read/write/edit/ls/bash/fetch/default toolset behavior. |
| `test/cache-report-pruning.test.ts` | Tests cache-report telemetry for pruning, explicit turn-index decision alignment, and cache-hit recovery warnings. |
| `test/checkpoint-store.test.ts` | Tests checkpoint store behavior and safe checkpoint paths. |
| `test/config-framework-capabilities.test.ts` | Tests framework capability configuration exposure. |
| `test/context-cache.test.ts` | Tests context manager, CJK-aware estimates, valid trimmed context starts, and cache strategy behavior. |
| `test/context-lifecycle.test.ts` | Tests context tiers, compaction summaries, prefix invariants, and JIT loader behavior. |
| `test/contract/emit-schemas.test.ts` | Tests schema emission into an explicit output directory. |
| `test/contract/plan-validator.test.ts` | Tests plan-package validation rules. |
| `test/contract/runtime-contract-schemas.test.ts` | Tests runtime contract schema emission. |
| `test/contract/store.test.ts` | Tests contract JSONL store read/write helpers. |
| `test/db/connection.test.ts` | Tests DB connection configuration; skipped unless DB environment is configured. |
| `test/evals-runner.test.ts` | Tests eval parsing, fixture setup, output matching, forbidden tools, budgets, turns, and write-root assertions. |
| `test/evidence/gateway.test.ts` | Tests evidence capture, UTF-8-safe truncation, persisted-byte hashes, redaction, and manifest behavior. |
| `test/evidence/manifest.test.ts` | Tests append-only JSONL evidence manifest write/read behavior and legacy manifest compatibility. |
| `test/evidence/redactor.test.ts` | Tests command-output redaction and binary output detection. |
| `test/execution/null-worktree-provider.test.ts` | Tests no-op worktree provider behavior. |
| `test/execution/git-diff-source.test.ts` | Tests redacted real git diff collection for staged, unstaged, and untracked write-scope changes. |
| `test/execution/worktree-provider.test.ts` | Tests worktree provider, process guard, and contained worktree path resolution. |
| `test/execution/write-scope.test.ts` | Tests write-scope normalization, overlap checks, and path containment. |
| `test/feedback-ledger.test.ts` | Tests receipt ledger and completion gate behavior. |
| `test/feedback/lessons.test.ts` | Tests persisted review lessons, TTL filtering, and prompt rendering. |
| `test/harness.test.ts` | Tests `GenericHarness` core prompting, config, lifecycle, event/cost behavior, and resources. |
| `test/integration/real-agent-harness.test.ts` | Real `AgentHarness` integration tier over local faux provider covering gate denial, hook override hardening, context trimming, cache patches, and retry rewind. |
| `test/lifecycle/default-review-loop.test.ts` | Tests default worker-reviewer loop bootstrapping and reviewer profile resolution. |
| `test/lifecycle/exit-criteria.e2e.test.ts` | Single-run end-to-end tests for PLAN-repair exit criteria: seeded-secret artifact sweep and FAIL→rewind→PASS repair through default wiring. |
| `test/memory/default-extractor.test.ts` | Tests default user-memory candidate extraction. |
| `test/memory/user-memory.test.ts` | Tests user-memory schema and memory pipeline. |
| `test/model-adapters/failure-classifier.test.ts` | Tests ModelProfile failure classification, bounded regex behavior, and repeated-output detection. |
| `test/model-adapters/prompted-json.test.ts` | Tests prompted-JSON parsing/coercion, repair prompts, permissions, and dispatch loop behavior. |
| `test/notifications/manager.test.ts` | Tests notification manager plus console and file-log channels. |
| `test/observability-hardening.test.ts` | Tests redaction, event logging, budget tracking, and cost tracking hardening. |
| `test/observability-specialization.test.ts` | Tests observability helpers, legacy specializations, and CLI args. |
| `test/orchestration/human-gate.test.ts` | Tests human-gate behavior in the worker-reviewer loop. |
| `test/orchestration/loop-persistence.test.ts` | Tests persisted loop artifacts and decisions. |
| `test/orchestration/runtime-adapter.test.ts` | Tests runtime adapter creation. |
| `test/orchestration/states.test.ts` | Tests state transitions and transition-log validation. |
| `test/policy/decide.test.ts` | Tests subject-glob policy matching and scoped decisions. |
| `test/policy/profiles.test.ts` | Tests permission profiles, command rules, and run-policy resolution. |
| `test/policy/subject.test.ts` | Tests subject extraction from tool arguments. |
| `test/prune-executor.test.ts` | Tests pruning executor decisions, rewrites, and telemetry. |
| `test/prune-planner.test.ts` | Tests relevance detection and prune planning. |
| `test/request-lifecycle-front-pipeline.test.ts` | Tests intake/routing front pipeline behavior. |
| `test/request-lifecycle-integration.test.ts` | Tests integrated lifecycle request execution, memory, skills, and task contracts. |
| `test/resilience.test.ts` | Tests provider error classification, retry helper, REPL SIGINT, and JSONL recovery. |
| `test/review/review-gate.test.ts` | Tests review gate behavior and verdict validation. |
| `test/review/reviewer-agent.test.ts` | Tests spawned reviewer agent parsing, coercion, and fallback behavior. |
| `test/runtime/normalized-result.test.ts` | Tests normalized result schema emission. |
| `test/runtime/pi-adapter.test.ts` | Tests pi runtime adapter behavior. |
| `test/scheduler/scheduler.test.ts` | Tests scheduled task execution and notification behavior. |
| `test/session/domain-session.test.ts` | Tests domain-session file store. |
| `test/session-config-permission.test.ts` | Tests JSONL session helpers, layered config, and permission store. |
| `test/skills/registry.test.ts` | Tests skill-card schema, registry matching, and skill-to-card conversion. |
| `test/tools/spawn-agent.test.ts` | Tests `spawn_agent` delegation, policy inheritance, scopes, depth, and tool constraints. |
| `test/tools.test.ts` | Tests tool registry and permission gate. |
| `test/trace-sink.test.ts` | Tests in-memory and file trace sinks. |
| `test/worker-reviewer-loop.test.ts` | Tests worker-reviewer loop control flow, repair attempts, review, and completion gate. |

## AI Checkpoint Notes

All files under `.ai/checkpoints/` are implementation checkpoint notes, not runtime code. Each file records a step checkpoint for the named plan/phase:

| File | Responsibility |
| --- | --- |
| `.ai/checkpoints/cache-pruning-planner.md` | Cache-pruning planner checkpoint. |
| `.ai/checkpoints/phase-7-build-packaging-ci/step-1.md` | Phase 7 build/packaging/CI checkpoint. |
| `.ai/checkpoints/phase-8-real-compaction/step-1.md` | Phase 8 compaction checkpoint. |
| `.ai/checkpoints/phase-8-real-compaction/step-2.md` | Phase 8 follow-up compaction checkpoint. |
| `.ai/checkpoints/phase-9-builtin-tools/step-1.md` | Phase 9 built-in tools checkpoint. |
| `.ai/checkpoints/phase-10-resilience/step-1.md` | Phase 10 resilience checkpoint. |
| `.ai/checkpoints/phase-11-session-config-permission/step-1.md` | Phase 11 session/config/permission checkpoint. |
| `.ai/checkpoints/phase-12-observability-docs/step-1.md` | Phase 12 observability/docs checkpoint. |
| `.ai/checkpoints/phase-12-observability-docs/step-2.md` | Phase 12 follow-up checkpoint. |
| `.ai/checkpoints/phase13-core/step-1.md` | Phase 13 core checkpoint. |
| `.ai/checkpoints/phase14-scaffold/step-1.md` | Phase 14 scaffold checkpoint. |
| `.ai/checkpoints/phase15-16-profiles/step-1.md` | Phase 15/16 profile checkpoint. |
| `.ai/checkpoints/phase17-evals/step-1.md` | Phase 17 eval checkpoint. |
| `.ai/checkpoints/phase18-completion-doc/step-1.md` | Phase 18 completion doc checkpoint. |
| `.ai/checkpoints/phase18-db-config/step-1.md` | Phase 18 DB config checkpoint. |
| `.ai/checkpoints/phase18-db-config/step-2.md` | Phase 18 DB config follow-up checkpoint. |
| `.ai/checkpoints/phase18-notifications/step-1.md` | Phase 18 notifications checkpoint. |
| `.ai/checkpoints/phase18-notifications-fix/step-1.md` | Phase 18 notifications fix checkpoint. |
| `.ai/checkpoints/phase18-notifications-fix/step-2.md` | Phase 18 notifications fix follow-up checkpoint. |
| `.ai/checkpoints/phase18-notifications-fix/step-3.md` | Phase 18 notifications fix final checkpoint. |
| `.ai/checkpoints/phase18-plan-exports/step-1.md` | Phase 18 plan/export checkpoint. |
| `.ai/checkpoints/phase18-plan-exports/step-2.md` | Phase 18 plan/export follow-up checkpoint. |
| `.ai/checkpoints/phase18-plan-exports/step-3.md` | Phase 18 plan/export final checkpoint. |
| `.ai/checkpoints/phase18-scheduler/step-1.md` | Phase 18 scheduler checkpoint. |
| `.ai/checkpoints/phase18-scheduler/step-2.md` | Phase 18 scheduler follow-up checkpoint. |
| `.ai/checkpoints/phase18-scheduler/step-3.md` | Phase 18 scheduler final checkpoint. |
| `.ai/checkpoints/phase18-spawn-agent/step-1.md` | Phase 18 spawn-agent checkpoint. |
| `.ai/checkpoints/phase18-spawn-agent/step-2.md` | Phase 18 spawn-agent follow-up checkpoint. |
| `.ai/checkpoints/phase18-spawn-fix/step-1.md` | Phase 18 spawn fix checkpoint. |
| `.ai/checkpoints/phase18-spawn-fix/step-2.md` | Phase 18 spawn fix follow-up checkpoint. |
| `.ai/checkpoints/phase18-spawn-fix/step-3.md` | Phase 18 spawn fix final checkpoint. |
| `.ai/checkpoints/worker-cli-observability/step-1.md` | Worker CLI observability checkpoint. |
| `.ai/checkpoints/worker-context-cache/step-1.md` | Worker context/cache checkpoint. |
| `.ai/checkpoints/worker-context-cache/step-2.md` | Worker context/cache follow-up checkpoint. |
| `.ai/checkpoints/worker-context-cache/step-3.md` | Worker context/cache final checkpoint. |
| `.ai/checkpoints/worker-core/step-1.md` | Worker core checkpoint. |
| `.ai/checkpoints/worker-tools/step-1.md` | Worker tools checkpoint. |
