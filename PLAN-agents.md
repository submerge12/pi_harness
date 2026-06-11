# pi-harness Customized Agents Plan (Phases 13–18)

Assumes Phases 1–12 are complete (generic harness, real tools, compaction, resilience,
config layering, observability). This plan covers turning the generic harness into a
family of profession-specific agents (coding, research, data analysis, …) without forking
the core.

## Guiding principle

A specialized agent is a **profile, not a subclass**:

```
AgentProfile = system prompt + tool set + permission policy + model/thinking defaults
             + context/cache tuning + skills/templates + (optional) programmatic hooks
             + an eval suite
```

The framework's job is to make a new profession cost ~200 lines of mostly-declarative
code plus a prompt. If a new profile needs core changes, that's a framework bug.

## Audit findings in the current specialization layer

`src/specializations/types.ts` works but is disconnected from the rest of the codebase:

1. `ToolRegistration` is `{ name, description?, value?: unknown }` — a stand-in. The real
   registration type lives in `src/tools/registry.ts` (tool + `accessLevel` +
   `permissionOverride`). A profile's tools currently can't be fed to `ToolRegistry`
   without casting.
2. `HarnessPolicy = Record<string, unknown>` — the real `PermissionPolicy` type exists in
   `src/tools/types.ts` and isn't used here.
3. `defaultModel?: unknown` / `model?: unknown` — discards `Model<Api>` / provider+modelId.
4. `createSpecializedHarness()` returns a merged config *blob*, not a `GenericHarness`,
   and the blob's shape (`SpecializableHarnessConfig`) is not `HarnessConfig` — the caller
   has to bridge the two by hand.
5. No way for a profile to carry context tuning (budget ratios, compaction instructions),
   skills/prompt templates (which `AgentHarness.skill()` / `promptFromTemplate()` already
   support), or hook installation (e.g. a profile that injects domain data via the
   `context` hook).

---

## Phase 13: Specialization Framework v2  (P0 — everything else builds on it)

**Goal**: A strongly-typed `AgentProfile` that produces a ready `GenericHarness`, plus a
profile registry wired into the CLI and config system.

**Files**:
```
src/agents/profile.ts           # AgentProfile type (replaces specializations/types.ts)
src/agents/create-agent.ts      # createAgent(profile, overrides) -> GenericHarness
src/agents/registry.ts          # named profile registry
src/agents/merge.ts             # precedence + conflict rules (move/fix existing merge)
src/cli/index.ts                # --agent <name>, `pi-harness agents` subcommand
src/config.ts                   # `agent?: string` + per-agent overrides in config file
```

**Key design**:

```typescript
interface AgentProfile {
  name: string;
  description: string;
  systemPrompt: SystemPrompt;                 // see Phase 14 prompt architecture
  tools: HarnessToolRegistration[];           // the REAL ToolRegistry registration type
  policy?: PermissionPolicy;                  // the REAL type from tools/types.ts
  model?: { provider: KnownProvider; modelId: string };
  thinkingLevel?: ThinkingLevel;
  context?: {
    ratios?: TokenBudgetRatios;
    compactionInstructions?: string;          // passed to harness.compact()
  };
  skills?: SkillDefinition[];                 // surfaced via AgentHarness.skill()
  templates?: PromptTemplateDefinition[];     // via promptFromTemplate()
  install?: (harness: GenericHarness) => (() => void) | void;  // programmatic escape hatch
}
```

- `createAgent(profile, overrides?)`: merges profile into `ResolvedHarnessConfig`
  (precedence: built-in defaults < profile < project config file < CLI flags/overrides),
  builds the harness via `createGenericHarness()`, registers tools through `ToolRegistry`
  (name collisions throw — registry already enforces this), installs `PermissionGate`,
  `ContextManager` (with profile ratios), `CacheStrategyEngine`, then calls
  `profile.install?.(harness)` last and keeps its disposer for shutdown.
- Profile registry: `registerProfile(profile)` / `getProfile(name)`; CLI `--agent coding`
  resolves through it; `pi-harness agents` lists name + description. Config file gains
  `"agent": "coding"` and an `"agents": { "coding": { …overrides } }` section.
- System-prompt merging keeps the existing `mergeSystemPrompts()` semantics (string concat,
  async-fn composition) but moves base-vs-profile ordering rule into `merge.ts` with tests.
- Keep `src/specializations/` as deprecated re-exports for one release, then delete.

**Verification**: unit tests for precedence (profile model beaten by CLI `--model`),
tool collision error, install/dispose symmetry; CLI test that `--agent coding` boots with
the coding toolset visible in `/help`.

---

## Phase 14: Agent Design Template — the "new profession" checklist  (P0, docs + scaffold)

**Goal**: A repeatable design procedure so each new profession is a fill-in exercise,
plus a scaffold generator.

**Files**:
```
docs/agent-design-guide.md
src/agents/profiles/_template/profile.ts    # scaffold with TODO sections
scripts/new-agent.mjs                       # `npm run new-agent -- research`
```

**The checklist every profile must answer** (this is the heart of the whole plan):

1. **Mission & boundaries** — what it does, what it explicitly refuses, what "done" means.
2. **Prompt architecture (cache-aware)** — fixed section order so the prefix stays stable:
   identity → hard rules → domain reference material → output format. Volatile data
   (dates, file listings, per-task context) goes in user/tool messages, never the system
   prompt — a changed system prompt invalidates the entire prefix cache every turn.
3. **Tool inventory** — each tool with `accessLevel`; risk-profile policy: what is
   `allow` / `ask` / `deny` *for this profession* (a research agent allows `network` and
   denies `write`; a coding agent is the reverse).
4. **Model & thinking economics** — per-profession defaults with rationale (coding →
   `high` thinking; a summarizer → `off`; note DeepSeek V4 Pro maps high/xhigh only).
5. **Context tuning** — budget ratios and *domain compaction instructions*: what must
   survive summarization (coding: file paths, decisions, unresolved errors; research:
   sources and claims with attribution; data analysis: dataset schemas, derived metrics).
6. **Skills & templates** — recurring workflows shipped as skills (`/review`, `/cite`).
7. **Golden tasks** — 3–10 eval tasks defined *at design time* (consumed by Phase 17).

`new-agent.mjs` copies `_template/`, renames, and registers the profile in the registry.

---

## Phase 15: Flagship Profile — Coding Agent  (P1)

**Goal**: Take the existing `createCodingSpecialization()` stub from a one-line prompt to
a production profile that exercises every framework feature, so it serves as the reference
implementation.

**Files**:
```
src/agents/profiles/coding/profile.ts
src/agents/profiles/coding/prompt.ts
src/agents/profiles/coding/skills/        # review.ts, fix-tests.ts
evals/coding/tasks/*.json
```

**Key design**:
- Tools: the Phase 9 builtins (read/ls/grep/glob → `read-only`, write/edit → `write`,
  bash → `destructive`, fetch → `network`); optionally upgrade to
  `@earendil-works/pi-coding-agent` tools via dynamic import when installed.
- Policy: read-only `allow`; write `ask` (persisted "always" per Phase 11);
  destructive `ask`; network `ask`.
- Prompt per the Phase 14 architecture: small reviewed diffs, match repo conventions,
  verify behavior before reporting completion, never fabricate test results.
- Context: compaction instructions preserving file paths, decisions, and failing-test
  state; default thinking `high`.
- Skills: `/review` (diff review against the conventions section), `/fix-tests`
  (run → diagnose → patch → re-run loop).

**Verification**: golden tasks against fixture repos — "fix the failing test in this
workspace", "rename this function across files" — asserting final file state, max turns,
and max cost.

---

## Phase 16: Prove Generality — Research + Data-Analysis Profiles  (P1)

**Goal**: Two profiles with *opposite* risk profiles to validate that Phase 13 generalizes.
Any framework change these force is a Phase 13 bug to fix now, while it's cheap.

- **Research agent**: tools = fetch/web-search + read-only fs; policy network `allow`,
  write `deny`; prompt enforces source attribution and claim/evidence separation;
  compaction preserves citations; thinking `medium`; heavier cold-tier ratio (long
  documents page through context).
- **Data-analysis agent**: read-only local inspection plus writes restricted to
  `./outputs`; generic shell/python execution is deferred until the harness can provide
  hard no-network and output-root isolation. Dataset schemas are pinned in the prompt's
  domain section; deterministic output format (tables/JSON); compaction preserves schemas
  and derived metrics.

Each profile should land in ≤ ~200 lines plus prompt text. **Files**: mirror the coding
profile layout under `src/agents/profiles/{research,data-analysis}/`.

**Verification**: research golden task with a canned fetch fixture asserting citations
present and zero write-tool calls; data-analysis task asserting output lands only in
`./outputs` and matches the declared format.

---

## Phase 17: Per-Profile Evaluation Harness  (P2 — quality regression net)

**Goal**: Golden-task evals so prompt/profile changes are measurable, not vibes.

**Files**:
```
evals/runner.ts                 # loads task JSON, runs agent, checks assertions
evals/<agent>/tasks/*.json      # prompt + fixture workspace + assertions
evals/<agent>/fixtures/
```

**Key design**:
- Task schema: `{ prompt, fixture, assertions: { files?, outputMatch?, forbiddenTools?,
  maxTurns?, maxUsd? } }`. Fixture workspaces are copied to a temp dir per run.
- Two tiers: **framework evals** on the mock transport (offline, run in CI on every PR —
  catches "profile no longer boots", "policy stopped blocking writes"); **quality evals**
  against the real provider (gated by `DEEPSEEK_API_KEY`, nightly), reporting pass rate +
  cost + cache hit rate per task (joins the Phase 12 cache report).
- Output: a markdown summary per run committed to `evals/reports/` or posted to CI.

---

## Phase 18: Distribution & Composition  (P2/optional, after ≥3 profiles exist)

- **Profiles as packages**: convention `pi-harness-agent-<name>` exporting
  `default: AgentProfile`; CLI `--agent <name>` falls back to dynamic-importing that
  package when the name isn't in the built-in registry.
- **Profile overlays**: compose two profiles (e.g. coding + security-reviewer) with
  explicit rules — tool collision is an error, policies merge by `stricterPermission()`,
  prompts append in declared order. Only build this when a real need appears; overlays
  multiply the eval matrix.
- **Sub-agents**: a `spawn_agent` tool that runs another profile as a child
  `GenericHarness` in the same process (researcher sub-agent inside the coding agent).
  Requires: cost roll-up into the parent's `CostTracker`, depth limit (default 1),
  child inherits the parent's *stricter* policy, child events tagged into the parent's
  event log.

---

## Suggested order and effort split

13 → 14 → 15 → 16 → 17 → 18. Phase 13+14 together are the investment (framework + design
discipline); 15 is the proof; 16 is the generality check that should be cheap — if it
isn't, loop back to 13. Phase 18 only when there's a second consumer or a real
multi-profile need.
