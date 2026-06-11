# Plan: Prune-Then-Rehit — Local Relevance Trimming with Cache Recovery

Goal: validate and then productionize this workflow on DeepSeek:

1. **Hot information** is appended directly to history (normal warm-tier append-only path).
2. Before a request, the harness **locally detects irrelevant spans** of conversation history.
3. The harness **submits the trimmed history once** (the "trim submission"), accepting a
   one-time partial cache miss.
4. All subsequent turns run on the pruned history and **hit the cache again**.

## The physics this plan lives under

DeepSeek's context cache is an automatic server-side **prefix** cache (64-token block
granularity, hits/misses reported per response as `prompt_cache_hit_tokens` /
`prompt_cache_miss_tokens`). Two consequences fix the design space:

- Removing content at position K invalidates the cache for **everything after K**. There is
  no way to prune mid-history and keep a full hit on the same request — the best possible
  outcome is: hit up to the prune point, pay full price once for the rest, then hit again
  from the next turn onward. The workflow is therefore an **amortization bet**, not free.
- The decision rule:

  ```
  prune is worth it  iff
  tokens_removed × expected_future_turns  >  tokens_after_first_prune_point
  ```

  (both sides at full input price; the right side is the one-time re-prefill the trim
  submission pays). Corollaries: **batch prunes** — N separate prune events pay N
  re-prefills, one combined event pays one; and **late prune points are cheap, early ones
  are expensive** — removing something near the head of a long history re-prices almost
  the whole conversation.

- The "submit the trimming first" step does **not** save money over just sending the next
  real turn on the pruned history — the miss costs the same either way. What it buys is
  **latency**: the re-prefill happens in the gap while the user is idle (or thinking),
  so their next turn streams from a warm cache. Treat pre-warming as a UX feature with
  cost-neutral economics.

---

## Stage 1: API validation probe  (built: `experiments/cache-prune-probe.mjs`)

Four-request sequence against the live API, one run nonce per execution so runs never
share cache:

| Request | What it does | Pass criterion |
|---|---|---|
| R1 | Cold build: system + 4 doc pairs + Q1 | hit ≈ 0% |
| R2 | Append-only next turn | hit ≥ ~80% of prompt (validates warm-tier invariant) |
| R3 | **Trim submission**: DOC-2 pair removed mid-history | hit ≈ tokens of system+DOC-1 only; everything after the prune point misses |
| R4 | Next turn on pruned history | hit ≥ ~80% again (cache re-established on new prefix) |

Run: `$env:DEEPSEEK_API_KEY = "sk-..."; node experiments/cache-prune-probe.mjs`
(env overrides: `DEEPSEEK_MODEL`, `DEEPSEEK_BASE_URL`). Cost: <1 cent.

**Extra measurements worth one follow-up run each:**
- Prune at the tail vs the head of history → confirm the cost asymmetry empirically.
- Two prunes submitted separately vs combined → confirm the batching rule.
- Delay sensitivity: re-run R4 after 1/5/15 minutes to observe cache retention (DeepSeek's
  retention is server-managed; knowing the practical window bounds how long a pre-warm
  stays useful).

**Failure modes to watch:** zero hits everywhere (account/model not serving the cache —
try `deepseek-chat`); hits not at 64-token multiples of expectations (granularity drift);
R4 low (server evicted between requests — increase probe pacing).

## Stage 2: Relevance detection (the "locally detected as irrelevant" part)

The harness needs a deterministic, conservative scorer for "this span will not be needed
again." Start rule-based; only add model-scored relevance later if rules underperform.

**Files**: `src/context/relevance.ts`, `src/context/prune-planner.ts`

High-confidence prunable spans (in priority order):
1. **Superseded tool results** — an old `read` of a file that was later re-read or edited;
   old directory listings; failed attempts that were retried successfully. Keep the
   tool-call stub, replace the result body with a one-line tombstone
   (`[result pruned: superseded by turn N]`).
2. **Oversized tool results past their use** — results larger than a threshold (e.g. 2K
   tokens) that no later turn references (string-match on salient identifiers).
3. **Dead-end branches** — user said "actually, forget that"; detect via explicit markers
   only (don't infer intent heuristically).

Hard safety rules: never separate a tool-call from its (possibly tombstoned) result;
never prune the system prompt, the last K turns (configurable, default 10), or anything
the user pinned; pruning must be deterministic given the same history (idempotent
re-planning, no flapping).

`prune-planner.ts` turns the scorer output into a **prune plan**: list of spans, the
first prune point, `tokensRemoved`, `tokensAfterPrunePoint`, and the decision-rule
verdict using a configurable `expectedFutureTurns` estimate (default: rolling average of
session turn count).

## Stage 3: Harness integration

**Files**: `src/context/prune-executor.ts`, changes to `src/context/manager.ts`

- Pruning is a **history rewrite**, so it belongs beside compaction, not inside the
  per-request `on("context")` hook. Execute at turn boundaries (subscribe to `turn_end`):
  evaluate the prune plan; if the decision rule passes, rewrite once and record a
  `prune` event (spans, tokens, predicted one-time cost) to the session log.
- Coexistence with compaction (PLAN.md Phase 8): pruning runs **first** (it's cheaper and
  lossless-ish — tombstones preserve structure); compaction remains the fallback when
  pruning can't free enough. Both are batched at the same high-water trigger so the
  prefix is invalidated at most once per episode.
- **Pre-warm option** (`prewarmAfterPrune: boolean`, default off): immediately after a
  rewrite, fire one minimal request (`max_tokens=1`, the pruned history verbatim) in the
  background so the user's next turn streams warm. Skip if a user turn is already queued.
- Config: `pruning: { enabled, minTurnsKept, maxResultTokens, expectedFutureTurns?,
  prewarmAfterPrune }` on `HarnessConfig`.

## Stage 4: Verification & telemetry

- Unit tests: scorer marks superseded reads and not recent ones; planner decision rule
  arithmetic; executor never splits call/result pairs; idempotence (re-running the
  planner on pruned history yields an empty plan).
- Integration test with mock transport: 30-turn synthetic session asserting exactly one
  prefix invalidation per prune episode (each request's messages share a prefix with the
  previous request except across the rewrite boundary).
- Live telemetry (joins PLAN.md Phase 12 cache report): per-turn hit rate annotated with
  prune events. Expected signature: dip on the trim submission, recovery within one turn.
  **Alarm** if hit rate stays low for >2 turns after a prune — that means the rewrite is
  unstable (non-deterministic serialization) and is silently burning money.
- A/B harness run: same scripted session with pruning on vs off; compare total input
  cost and final-answer quality (spot-check that tombstoned content wasn't needed).

## Order & effort

Stage 1 is runnable now (script exists; needs only the API key). Stage 2 is the design
risk — start with only rule #1 (superseded tool results), which is the highest-volume,
lowest-risk span type in agentic sessions. Stages 3–4 are mechanical once 2 is settled.
If Stage 1's R4 fails (no rehit after rewrite), stop: the workflow's premise doesn't
hold on the provider, and only compaction-style strategies remain viable.
