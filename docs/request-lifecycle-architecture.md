# pi-harness — Request Lifecycle Architecture

> The end-to-end lifecycle an agent runs for a request: **intake → route → skill-select → plan/execute →
> context lifecycle → memory**. It wraps the already-built execution core (authorize → execute → evidence → review)
> with a front-end (stages 1–4) and a tail-end (stages 5–6).
> Companion docs: `harness-engineering-framework.md` (the seven pillars), `pi-harness-shortcomings.md`,
> `pi-harness-improvement-plan.md` (engineering standards: typebox source-of-truth, naming, folder structure).
> Synthesized from the design discussion; decisions dated 2026-06-24.

---

## 1. Purpose & positioning

Every agent owns the **complete** lifecycle. What differs is **where it enters**:

- **Standalone** (raw user input) → run all six stages.
- **Delegated** (a Task Contract from the orchestration layer) → the orchestrator already did intake, routing,
  skill-selection, and planning, so the agent **resumes at execution** (stage 5).

The front (stages 1–4) and back (stages 5–6) are therefore **separable modules**, and the front must be cleanly
bypassable. The same front-end + matcher are **shared code with two callers** (the orchestrator and a standalone
agent) — they are not duplicated.

## 2. The lifecycle at a glance

```
┌─ INTAKE (stage 1) ─────────────────────────────────────────────┐
│  1a preserve raw (immutable)                                    │
│  1b extract hard constraints  ← from raw; defines completeness  │
│  1c rewrite / complete  ← only if constraint slots are missing  │
├─ ROUTE (stage 2) ──────────────────────────────────────────────┤
│  2a deterministic routing → 2b semantic matching  (cost ladder) │
│     hard constraints filter eligible routes / skills            │
├─ SKILL-SELECT (stage 3) ───────────────────────────────────────┤
│  pick skill from the published skill-card registry              │
├─ BRANCH (stage 4) ─────────────────────────────────────────────┤
│  simple → execute directly   |   complex → generate a plan      │
├─ EXECUTE + CONTEXT LIFECYCLE (stage 5) ────────────────────────┤
│  authorize → run → evidence → review     (already built)        │
│  context: split-on-input · age-out to disk · cache-aware        │
│  tombstone compaction · protect recent · 9-section full-compact │
│  stable prefix (system prompt + tool index) NEVER changes       │
│  skills + tools: index in prefix, bodies loaded JIT into suffix │
├─ MEMORY (stage 6) ─────────────────────────────────────────────┤
│  bitemporal (observedAt / lastConfirmedAt) + trust tiers        │
│  hybrid scope · trust-then-recency · flag + confirm inferred    │
└─────────────────────────────────────────────────────────────────┘

Re-entry:  raw user input ─────────────────────────► run stages 1–6
           delegated Task Contract (1–4 done) ──────► resume at stage 5
```

## 3. Re-entrancy & the orchestrator/agent contract

The **presence of a Task Contract is the skip signal.** A raw `UserRequest` runs the whole pipeline; a `TaskContract`
(already normalized, routed, with a skill assigned, possibly one node of a plan) enters at stage 5.

Today `spawn_agent` passes only a free-text `prompt`. To make delegation real it must carry a `TaskContract`:

```ts
// src/contract/schemas/task-contract.ts  (typebox is the single source of truth)
export const taskContractSchema = Type.Object({
  id: Type.String(),
  goal: Type.String(),
  rawRequest: Type.String(),                       // stage-1a raw, preserved end-to-end
  hardConstraints: Type.Array(constraintSchema),   // stage-1b, must-hold
  assignedSkill: Type.String(),                    // orchestrator chose it (stage 3)
  writeScope: Type.Array(Type.String()),           // feeds stage-5 authorization
  gateTier: Type.Union([Type.Literal("G0"), Type.Literal("G1"), Type.Literal("G2"),
                        Type.Literal("G3"), Type.Literal("G4")]),
  planNodeId: Type.Optional(Type.String()),        // set when this task is one node of a plan
});
export type TaskContract = Static<typeof taskContractSchema>;
```

**Ownership when delegating:** the orchestrator runs stages 1–4 (intake, route, **skill-select**, plan); the agent
runs stages 5–6. A standalone agent runs 1–6 itself.

## 4. Stage 1 — Intake

| Step | What | Why |
|---|---|---|
| **1a Preserve raw** | Store the original input immutably (in context *and* on disk; carried in `TaskContract.rawRequest`). | Restorable/auditable even after rewriting; feeds stage-5 disk tiers and stage-6 provenance. |
| **1b Extract hard constraints** | From the **raw** text, before any rewrite, extract must-hold constraints (required slots, entities, guards). | The rewrite can't silently distort them; they become an immutable checklist. |
| **1c Rewrite / complete** | **Only when incomplete** — "incomplete" = required constraint slots from 1b are missing. LLM rewrites or asks a clarifying question. | Cheap path: complete requests skip the LLM entirely. |

Hard constraints are **the definition of completeness** (1c trigger) and a **filter on eligibility** in stage 2.

## 5. Stage 2 — Route

A **cost ladder**, cheapest first:

1. **2a Deterministic routing** — exact/rule dispatch (patterns, command prefixes, explicit triggers).
2. **2b Semantic matching** — embedding similarity, only as fallback when deterministic misses.

Both are constrained: a route/skill is a candidate **only if it can satisfy the stage-1b hard constraints**.

## 6. Stage 3 — Skill selection + the Skill Card

Skills are a **published registry of cards** the orchestrator (and a standalone agent's own stage 3) matches against.
Each card is a *selection contract* designed to prevent mis-routing:

```ts
// src/skills/schemas/skill-card.ts
export const skillCardSchema = Type.Object({
  name: Type.String(),
  responsibility: Type.String(),          // what RESULT this skill owns
  whenToUse: Type.String(),               // trigger conditions
  effects: Type.String(),                 // output / consequence it produces
  adjacentFalseTriggers: Type.Array(Type.String()),  // nearby scenarios it must NOT grab
  positiveExamples: Type.Array(Type.String()),
  negativeExamples: Type.Array(Type.String()),
});
export type SkillCard = Static<typeof skillCardSchema>;
```

Because the **orchestrator** selects the skill (it chose `assignedSkill` in the Task Contract), every agent must
**publish its cards upward** so the orchestrator can match. The same card set feeds an agent's own stage 3 when it
runs standalone. Skill *bodies* (full instructions) are **not** in the prefix — only the card index is; bodies load
just-in-time (see §8).

## 7. Stage 4 — Branch

After a skill is selected, classify the task:

- **Simple** → execute directly (skip planning).
- **Complex** → generate a **plan** (decompose into tasks; each task → an agent + an assigned skill, emitted as a
  `TaskContract`, validated by the existing `src/contract/plan-validator.ts` deterministic lint).

Note: **plan comes *after* skill-selection**, not before.

## 8. Stage 5 — Execute + context lifecycle

Execution itself is the already-built core: **authorize (policy + write-scope) → run (tools) → evidence (manifest) →
review (verdict)**. New here is the **context lifecycle**, an instance of **Pinned / Warm / Cold tiers** with a
**stable prefix / dynamic suffix** split.

### 8.1 Context lifecycle rules

| # | Rule | Tier behavior |
|---|---|---|
| 1 | **On first input, split** — keep a strategic/high-level part hot, move the rest to disk (retrievable). | Warm reference in context, Cold body on disk |
| 2 | **Unused for a time window → summarize to disk, still retrievable.** | Warm → Cold aging |
| 3 | **Single-message compaction: announce *what* will be erased first**, leaving a retrievable **tombstone/anchor**, while preserving cache hits. | cache-aware eviction |
| 4 | **Summarize only old/unused context; never touch recent turns.** | Recent = Pinned |
| 5 | **Window full → full auto-compaction** into the fixed 9-section schema (below), keeping the summary **plus the last N recent turns verbatim**. | summarize → reinitialize |
| 6 | **System prompt + tool definitions never change.** | stable prefix (the cache invariant) |

### 8.2 The 9-section full-compaction schema

1. Main request & user intent
2. Key technical concepts
3. Files & code
4. Pitfalls encountered & fixes
5. Problem-solving process
6. All user information, itemized
7. Pending tasks
8. What is currently being worked on
9. The user's **original wording** for the next step (raw-preserved, per stage 1a)

### 8.3 Skills & tools — just-in-time, cache-safe

Skills and tools both carry descriptions, so neither sits fully in context until needed. Reconciling JIT loading with
rule 6 (stable prefix):

- **Prefix (frozen):** system prompt + the fixed declared-tool set + a compact **skill-card index** (name + one-line
  `whenToUse`).
- **Dynamic suffix (on demand):** full skill bodies, detailed tool docs, retrieved data — loaded into user/tool
  messages via a `load_skill` / `get_doc` meta-tool. The declared tool schemas never change, so the prefix cache holds.

## 9. Stage 6 — User memory

Persistent, cross-session memory about the user — **bitemporal + provenance-tagged**.

```ts
// src/memory/schemas/user-memory.ts
export const userMemorySchema = Type.Object({
  key: Type.String(),
  value: Type.String(),
  category: Type.Union([Type.Literal("preference"), Type.Literal("profile"),
                        Type.Literal("project"), Type.Literal("reference")]),
  trust: Type.Union([Type.Literal("user_confirmed"), Type.Literal("tool_evidenced"),
                     Type.Literal("model_inferred")]),
  observedAt: Type.Number(),        // set once, when first learned
  lastConfirmedAt: Type.Number(),   // bumped on restate / re-evidence
  sourceRef: Type.Optional(Type.String()),   // turn id / evidence manifest ref
  scope: Type.String(),             // "global" | "<domain>"
});
export type UserMemory = Static<typeof userMemorySchema>;
```

### 9.1 Decisions

| Dimension | Decision |
|---|---|
| **Dual-time** | `observedAt` (first learned) vs `lastConfirmedAt` (last reaffirmed). Staleness = `now − lastConfirmedAt`. |
| **Scope** | **Hybrid** — a global profile + preferences readable by all agents, plus per-domain memories each agent owns. |
| **Conflict resolution** | **Trust-tier first** (`user_confirmed > tool_evidenced > model_inferred`), **then recency** (`lastConfirmedAt`). |
| **Inferred handling** | `model_inferred` is **flagged and never acted on as fact until the user confirms it**; stale + low-trust memories are flagged for re-confirmation (aging, like rule 2). |

### 9.2 Write pipeline (post-execution)

`extract candidate memories → assign trust by source (user said it / a tool proved it / model guessed it) → dedup
(update an existing memory's lastConfirmedAt, don't duplicate; on contradiction resolve by trust → recency) →
redact secrets before persist (reuse the evidence redactor) → write.`

### 9.3 Read / recall

On a new request, load only the **relevant** memories into the **dynamic suffix** (per §8.3 JIT), surfaced as
**background context, not instructions**, carrying their dual-time so the model knows freshness.

> **Working reference:** the Claude Code memory system is ~80% of this design already — frontmatter (`description`
> for recall, `type` = user/feedback/project/reference), a crude dual-time (the "*this memory is N days old — verify
> before asserting*" staleness flag), an index file (`MEMORY.md`, the §8.3 lightweight-identifier pattern), and the
> update-not-duplicate write discipline. Stage 6 formalizes its staleness and provenance.

## 10. Cross-cutting invariants

- **Raw preserved everywhere** — stage 1a → carried in the Task Contract → on disk in stage 5 → as the 9th
  compaction section → as stage-6 provenance.
- **Cache-stable prefix** — system prompt + declared tools + skill-card index never mutate (rule 6 + §8.3).
- **Hard constraints are load-bearing** — defined once (1b), gate completeness (1c) and eligibility (stage 2).
- **Redaction before any persistence** — context offload (stage 5) and memory writes (stage 6) both pass the
  evidence redactor; no secret in any stored artifact.
- **Provenance/dual-time** — evidence manifests (what ran) and user memory (what we believe) both carry source +
  time so claims are traceable and ageable.

## 11. Map to existing pi-harness modules

| Stage | New / extends | Existing primitives to reuse |
|---|---|---|
| 1 Intake | **new** `src/intake/` (raw store, constraint extractor, rewrite gate) | `src/evidence/redactor` (raw store redaction) |
| 2 Route | **new** `src/routing/` (deterministic + semantic matchers) | — |
| 3 Skill-select + cards | **new** `src/skills/` (card schema, registry, matcher) | `src/agents/profiles/*/skills/*` (thin skills to upgrade to cards) |
| 4 Branch / plan | **extend** `src/contract/` (Task Contract), reuse plan-validator | `src/contract/plan-validator.ts` |
| 5 Execute | built | `src/policy/**`, `src/execution/**`, `src/evidence/**`, `src/review/**` |
| 5 Context lifecycle | **extend** `src/context/` (tombstone rule 3, 9-section rule 5), JIT loader | `src/context/{manager,prune-planner,prune-executor,compaction-policy,relevance,token-budget}`, `src/cache/strategy-engine` |
| 6 Memory | **new** `src/memory/` (bitemporal store, write/recall pipelines) | `src/db/**` (a `memory` pgSchema) or markdown+frontmatter files; `src/evidence/redactor` |

## 12. Suggested build order

1. **Task Contract** — extend `src/contract/` so delegation carries `{rawRequest, hardConstraints, assignedSkill,
   writeScope, gateTier}`; make `spawn_agent` accept it. (Unblocks the re-entry contract.)
2. **Skill-card registry** — `src/skills/`: card schema + a publish/lookup registry. (Cross-cutting prerequisite for
   orchestrator skill-selection and stage 3.)
3. **Front pipeline** — `src/intake/` then `src/routing/`, wired as the standalone entry; reuse them in the
   orchestrator.
4. **Context-lifecycle policy** — extend `src/context/` with the tombstone (rule 3), the 9-section compaction
   (rule 5), and the JIT skill/tool loader (§8.3); enforce the rule-6 prefix invariant.
5. **User-memory store** — `src/memory/`: bitemporal record + write/recall pipelines + trust/conflict rules.

Each lands as a typebox-first module under the conventions in `pi-harness-improvement-plan.md` §0 (kebab-case files,
`create…` factories, union-literal enums, `index.ts` + `types.ts` per module, `vitest` tests mirroring `src/`).

## 13. Status

Design complete (all six stages specified, 2026-06-24). Nothing in this doc is implemented yet beyond the stage-5
execution core (policy/execution/evidence/review) and the contract/orchestration libraries already in `src/`.
