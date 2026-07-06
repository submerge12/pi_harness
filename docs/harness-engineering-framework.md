# Harness Engineering — Technical Framework

> Synthesized from three reference harnesses — **CodeWhale** (`github.com/Hmbown/CodeWhale`), **DeepSeek-Reasonix**
> (`github.com/esengine/DeepSeek-Reasonix`, read from a local clone at `G:\DeepSeek-Reasonix`), and **claw-code**
> (`github.com/ultraworkers/claw-code`) — together with the Anthropic, OpenAI, and Google engineering blogs on agent
> harnesses and context engineering. Every pillar cites concrete, independently re-verified evidence.
> Date: 2026-06-24.

## The core question

A harness exists to answer Anthropic's framing — *"what configuration of context is most likely to generate the
model's desired behavior?"* — by wrapping the model in a **controllable, observable, recoverable** loop. The seven
pillars below are the load-bearing structure shared (in part or whole) by every serious harness surveyed.

---

## Pillar 1 — Config-/registry-driven core (no hardcoded model/tool switches)

- **DeepSeek-Reasonix** `docs/SPEC.md:9-19,64-79,83-85`: "Config- and plugin-driven core. The core knows only
  interfaces… No hardcoded `switch model`." Providers self-register via `Register(kind, Factory)`; "DeepSeek and MiMo
  are not code — they are config instances of `kind="openai"`."
- **CodeWhale**: multi-provider routing switchable mid-session via `/provider` and `/model`, keyed from
  `~/.codewhale/config.toml`.

*Why it's a pillar:* one harness serves many backends/tools without becoming a fork-per-model codebase.

## Pillar 2 — Tool design discipline (narrow, unambiguous, token-efficient)

- **Anthropic, "Writing tools for agents"**: "more tools don't always lead to better outcomes"; parameters should be
  "unambiguously named… `user_id`" not `user`; build in pagination/filtering/truncation with sensible defaults and
  "instructive, actionable" error messages instead of opaque codes/tracebacks.
- **DeepSeek-Reasonix** `docs/SPEC.md:100-114`: `Tool` interface (`Name/Description/Schema/Execute`); "`Execute` parses
  raw JSON args itself. Errors are returned, not fatal — the agent feeds them back so the model can self-correct."

*Why it's a pillar:* tool-surface quality is the single largest lever on agent reliability.

## Pillar 3 — Context engineering (window management, compaction, sub-agents, memory)

- **Anthropic, "Effective context engineering for AI agents"**: just-in-time retrieval via lightweight identifiers;
  compaction (summarize a near-full window → reinitialize with the summary); structured note-taking persisted outside
  the context window; sub-agent architectures where "specialized sub-agents handle focused tasks with clean context
  windows" and report condensed summaries.
- **DeepSeek-Reasonix** `internal/agent/coordinator.go:25-36` (+ `compact.go`, `compact_test.go`,
  `compact_loop_e2e_test.go`): a two-model Coordinator runs planner and executor in **separate sessions** "to keep each
  one's prompt prefix cache-stable… neither model's prefix is disturbed by the other's turns" — a concrete
  prefix-cache-aware implementation of the clean-context principle.

*Why it's a pillar:* uncontrolled context growth is the dominant failure mode for long-horizon agents.

## Pillar 4 — Permission/policy engine with subject-level scoping

- **DeepSeek-Reasonix** `internal/permission/permission.go:14-128`: a pure `Policy.Decide(toolName, readOnly, args)`
  with **deny > ask > allow > fallback** precedence; rules scoped to a glob-matched **subject** extracted from call
  args (`subjectKeys:151`, `Subject():156`). A separate `Gate` (`217-261`) wraps the pure policy with an I/O-performing
  `Approver`, explicitly to keep "rule evaluation pure… trivially testable." An "always allow" choice persists a narrow
  rule pinned to the exact subject (`rememberRule:263-271`). *(`isReadOnlyBashSubject` is defined in
  `internal/permission/bash_readonly.go:63`; `permission.go:233-237` is its call site.)*
- **CodeWhale**: `.codewhale/hooks.toml` provides allow/deny/ask per tool call; Plan/Agent/YOLO modes shift the global
  default ask-policy.

*Why it's a pillar:* a policy that knows only tool *names* cannot express "allow read everywhere, deny write outside
`src/`, ask before any git push" — the policy shape real engineering teams need.

## Pillar 5 — Sandboxing / execution isolation beyond path checks

- **CodeWhale**: OS-level sandboxing via **bwrap, Landlock, Seatbelt, seccomp** — kernel/OS-enforced isolation, not
  application-level path validation.
- **agent-orchestration-harness** `docs/tasks/P0/P0-03/worktree-probe-result.md` (a load-bearing empirical finding):
  git worktree create/branch/commit **cannot** run inside a worker sandbox because a `.git = "read"` deny-write ACE
  blocks them; worktree lifecycle must run at the harness/Coordinator layer **outside** the worker sandbox.

*Why it's a pillar:* the isolation boundary must not depend on the LLM (or the harness's own code) behaving correctly.

## Pillar 6 — Evidence capture, redaction, and auditability

- **claw-code**: a documented event/report contract (`g004-events-reports-contract.md`) and a JSON-RPC status contract
  for ACP/Zed integration. *(Caveat: the ACP/Zed daemon is documented but **not yet implemented** per claw-code's own
  README — the contract is aspirational, not shipped.)*
- **agent-orchestration-harness** `docs/tasks/P0/P0-04/result.md`: `scripts/capture-command.mjs` captures stdout/stderr
  as buffers (no shell redirection), redacts secrets **before** persistence, detects binary output, bounds oversized
  output, and emits a per-command manifest with **SHA-256** hashes — proven by a planted-secret demo with zero leakage
  (4/4 tests).

*Why it's a pillar:* a reviewer/auditor cannot trust "tests passed" without a tamper-evident record of what ran.

## Pillar 7 — Multi-agent orchestration patterns + human-in-the-loop gates

- **Anthropic, "Building effective agents"**: distinguishes workflows from agents; names the **orchestrator-workers**
  pattern ("a central LLM dynamically breaks down subtasks and delegates to worker LLMs, then synthesizes results") and
  **evaluator-optimizer** pattern (one LLM generates, another evaluates in a loop); guardrails = sandboxed testing,
  pausing "for human feedback at checkpoints," and explicit stopping conditions.
- **OpenAI, "A practical guide to building agents"**: the **manager** pattern (central agent calls specialists as
  tools) and the **decentralized** pattern (peer handoff); layered guardrails added "as you uncover new
  vulnerabilities." *(Evidence tier: weak — direct PDF fetch failed; recovered via search snippets.)*
- **Google ADK, "Developer's guide to multi-agent patterns"**: eight named, composable patterns — Sequential Pipeline,
  Coordinator/Dispatcher, Parallel Fan-Out/Gather, Hierarchical Decomposition, Generator-and-Critic, Iterative
  Refinement, Human-in-the-Loop, Composite; shared `session.state` via a unique `output_key` per agent to avoid race
  conditions.
- **DeepSeek-Reasonix** `coordinator.go:29-66`: a concrete **2-role, 1-handoff** orchestrator-workers instance — a
  non-tool planner hands a formatted plan to a tool-using executor. Deliberately minimal, not a state machine.

*Why it's a pillar:* none of the primary sources describe orchestration as a generic large state machine. They
describe a **small catalog of named, composable patterns** chosen per task shape, plus human checkpoints as a
*guardrail* — not as milestone-numbering ceremony.

---

## Summary table

| Pillar | One-line test | Strongest evidence |
|---|---|---|
| 1 Config-driven core | "Can I add a provider with config, not code?" | Reasonix `SPEC.md`; CodeWhale `/provider` |
| 2 Tool discipline | "Is each tool distinct, named unambiguously, error-instructive?" | Anthropic *Writing tools*; Reasonix `Tool` |
| 3 Context engineering | "What happens when the window fills?" | Anthropic *Context engineering*; Reasonix dual-session |
| 4 Subject-scoped policy | "Can policy scope by path/glob, not just tool name?" | Reasonix `permission.go` |
| 5 OS-level isolation | "Is the boundary enforced below my own code?" | CodeWhale bwrap/Landlock; AOH P0-03 |
| 6 Evidence & audit | "Can I prove what ran without trusting the worker?" | AOH `capture-command.mjs` (SHA-256) |
| 7 Orchestration + gates | "Smallest pattern that fits + human checkpoints?" | Anthropic/OpenAI/ADK patterns; Reasonix Coordinator |

## Sources

CodeWhale `github.com/Hmbown/CodeWhale` · DeepSeek-Reasonix `github.com/esengine/DeepSeek-Reasonix` (+ local clone) ·
claw-code `github.com/ultraworkers/claw-code` · Anthropic *Effective context engineering for AI agents* / *Writing
tools for agents* / *Building effective agents* · OpenAI *A practical guide to building agents* · Google ADK
*Developer's guide to multi-agent patterns*.
