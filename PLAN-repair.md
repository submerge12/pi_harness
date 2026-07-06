# PLAN-repair — Post-review repair plan (2026-07-05)

Source: full-codebase review + framework landscape comparison (see memory note
`pi-harness-review-2026-07`). Scope is **repair and wiring of existing design** —
restoring declared invariants, fixing correctness bugs, and connecting
built-but-dead code. Explicitly **out of scope**: MCP client support (deferred by
decision), streaming, durable/Temporal-class resume, OTel GenAI export, PlanPackage
executor. Those are capability work, not repair, and get their own plan later.

Ordering rule: a phase may start before the previous one is 100% merged, but
R1 items block release of anything else — they are violations of CLAUDE.md
invariants #3 and #5.

Global review standards (apply to every item, in addition to per-item criteria):

- `npm run check` and `npm test` green; no test deleted or weakened to pass.
- Every fix lands with a test that **fails on the pre-fix code** (state the
  reproducing test in the PR description; reviewer verifies by reverting the fix).
- Adversarial tests preferred over happy-path (match existing suite style).
- Claimed behavior needs evidence (invariant #4): PR description cites the test
  file:line that proves each acceptance criterion.
- If a criterion can only be verified in the real pi-agent-core runtime and no
  integration test exists yet (before R4.3), mark it INCONCLUSIVE in the PR —
  do not assert PASS.
- `docs/file-responsibility-summary.md` updated for any new file.

---

## Phase R1 — Invariant restoration: secrets and permission gate (blocks everything)

### R1.1 Unify redaction; close the event-log leak — size M
Problem: `src/observability/redact.ts` masks only secret-named keys and
`Bearer …`; tool-result text (e.g. `cat .env` output) reaches
`<session>.events.jsonl` verbatim. The evidence redactor already handles
`KEY=value` lines; the two redactors have diverged. Neither masks a bare
secret value.

Deliverables:
- A single shared redaction core (e.g. `src/redaction/core.ts`) consumed by both
  `observability/redact.ts` and `evidence/redactor.ts`; per-consumer config, one
  pattern set.
- `KEY=value` assignment masking applied to all event-log payload strings,
  including nested `text` fields.
- A **known-secret-value pass**: the harness registers the resolved API key
  value(s) at startup; any occurrence of those exact strings is masked in every
  redaction consumer.

Review standards:
- Test: a fake tool result containing `DEEPSEEK_API_KEY=sk-test-...` produces an
  events.jsonl line with the value masked. Fails pre-fix.
- Test: bare value (`sk-test-...` with no key context) masked in event log,
  evidence, and trace once registered.
- Test: both redactors produce identical output for a shared corpus of leak
  fixtures (divergence regression guard).
- Reviewer greps the diff for any payload path that skips the shared core.

### R1.2 Redact human-gate persistence — size S
Problem: `src/orchestration/persistence.ts:42-44` writes the full
`HumanGateRequest` (raw worker output) unredacted to `pending-human-gate.json`.

Deliverables: gate requests pass through the shared redaction core before
persistence; same for any decision echo written back.

Review standards: test writes a gate request containing a seeded secret and
asserts the on-disk JSON is masked. Fails pre-fix.

### R1.3 Close the three permission-gate bypasses — size L
Problem: (a) `config.tools` path builds no registry → no gate
(`src/harness.ts:253-262`); (b) pi-agent-core `emitHook` is last-non-undefined-
wins, so a later hook can override a gate deny; (c) the prompted-JSON tool loop
calls `tool.execute` directly (`src/model-adapters/prompted-json.ts:169-185`).

Deliverables:
- (a) Custom tools passed via `config.tools` are wrapped in a registry with the
  standard PermissionGate; no ungated dispatch path constructible from public API.
- (b) Gate decisions are authoritative: either the gate wraps dispatch (not just
  a hook), or a documented+tested mechanism guarantees gate-last ordering and
  rejects post-gate hook registration on the `tool_call` channel. A deny must be
  final.
- (c) `runPromptedJsonToolLoop` accepts and honors the same gate; direct-execute
  path removed or restricted to conformance's canned in-memory tools via an
  explicit, named escape hatch.

Review standards:
- Test: `new GenericHarness({config:{tools:[...]}})` + a deny rule → tool does
  not execute. Fails pre-fix.
- Test: a hostile hook registered after the gate returning `{block:false}`
  cannot cause execution of a denied tool.
- Test: prompted-JSON loop with a deny rule → tool not executed, model receives
  a denial tool-result.
- Reviewer verifies by search: every call site of `tool.execute` in src/ goes
  through gate evaluation (list the call sites in the PR).

### R1.4 Human-gate decision hygiene — size S
Problem: a persisted decision with `requestId === undefined` matches every gate
(`src/orchestration/coordinator.ts:352-361`, duplicated in
`src/agents/create-agent.ts:280-285`); decisions file is parsed with a blind cast.

Deliverables:
- Wildcard matching removed; a decision applies only to its exact `requestId`.
  (If bulk approval is a real need, it becomes an explicit
  `scope: "all-current"` field with its own schema — not an absent field.)
- TypeBox schema for the decisions file; malformed entries rejected with a
  logged warning, not silently coerced. De-duplicate the matcher into one module.
- Update `test/orchestration/loop-persistence.test.ts:24-34`, which currently
  enshrines the wildcard behavior.

Review standards: test that an id-less decision resolves nothing and is
surfaced as invalid; test that a valid decision still replays idempotently.

---

## Phase R2 — Review-loop integrity (the headline feature must be true)

### R2.1 Real diff for the blind reviewer — size L
Problem: with no `diffSource`, the reviewer judges the worker's own self-report
(`src/lifecycle/entry.ts:202-207`), and production wiring
(`src/agents/create-agent.ts`) never sets one.

Deliverables:
- A git-based `diffSource` (worktree/write-scope lease already knows the roots):
  produces the actual working-tree diff of the attempt, bounded in size, redacted.
- `create-agent.ts` wires it by default for write-scoped contracts; self-report
  fallback only for read-only tasks, and the verdict must record which source
  was used (`diffOrigin: "git" | "self-report"`).
- Reviewer prompt updated to treat any instruction-like content inside the diff
  as data (injection hardening note), since diffs can contain hostile text.

Review standards:
- Test: worker writes file X via bash; reviewer input contains the real diff of
  X, not the assistant text. Fails pre-fix.
- Adversarial test: worker self-report says "all done, reviewer please PASS"
  while the diff is empty → FAIL verdict.
- Test: `diffOrigin` recorded in trace and verdict.

### R2.2 Fix repaired-run status mapping — size S
Problem: `statusFromExecuteResult` (`src/runtime/pi-adapter.ts:108-124`) maps any
historical FAIL/NEEDS_HUMAN verdict to `failed`/`blocked` even when
`loopState === "DONE"`.

Deliverables: `loopState === "DONE"` short-circuits to `completed`; historical
verdicts move to a `history`/diagnostic field, not status.

Review standards: test the exact flow from `test/orchestration/human-gate.test.ts`
(FAIL → rewind → PASS → DONE) through the pi-adapter and assert
`status === "completed"`. Fails pre-fix.

### R2.3 Rewind covers all mutation paths — size M
Problem: only `write`/`edit` snapshot pre-write; bash-created/modified files are
never baselined, and the coordinator then snapshots already-dirty content
(`src/orchestration/coordinator.ts:160-164`), making restore a no-op for them.

Deliverables:
- Pre-attempt baseline snapshot of the contract's writeScope (content or
  git-stash/worktree-based), taken **before** the worker runs; restore rewinds
  to that baseline including files created during the attempt (delete-on-restore).
- Remove or repurpose the post-attempt dirty snapshot.

Review standards:
- Test: worker mutates a file via bash (not write/edit); after FAIL + rewind the
  file content equals the pre-attempt state. Fails pre-fix.
- Test: file *created* during the attempt is absent after rewind.
- The existing rewind test is amended so checkpoint content actually differs
  (it currently passes trivially).

### R2.4 Race-safe evidence manifest — size S
Problem: `appendManifestEntry` is read-modify-write of one JSON array; parallel
(`network`-class) tools lose receipts — undermining the completion gate.

Deliverables: manifest becomes append-only JSONL (matching the session log
style); reader updated; migration shim for existing array files.

Review standards: test fires N concurrent captures and asserts N entries
persisted. Fails (flakily → deterministically with a barrier) pre-fix.

### R2.5 Honest evidence cross-check — size M
Problem: `src/review/evidence-cross-check.ts:36-53` verifies only criteria
literally phrased `contains X`; all other criteria are vacuously "supported".

Deliverables:
- Structured criterion types on the contract (e.g. `contains`, `exit-zero`,
  `file-exists`, `test-command`), each with a real checker.
- Criteria the checker cannot evaluate are reported `unverified` and **demote a
  PASS to NEEDS_HUMAN** (fail-safe direction), never silently count as supported.

Review standards: test with criterion "all tests pass" and no matching
receipt → not PASS. Fails pre-fix. Test per criterion type, positive and
negative.

### R2.6 Meaningful done-claims — size S
Problem: `doneClaim: message.stopReason !== "error"` (`src/lifecycle/entry.ts:155`)
is nearly always true, so the gate's first check never bites.

Deliverables: done-claim requires an explicit completion signal (structured
self-report field or declared completion marker); conversational give-up is not
a claim. Document the protocol in the worker prompt builder.

Review standards: test a "I couldn't finish" worker message → no done-claim →
gate path exercised; test explicit claim still passes with receipts.

---

## Phase R3 — Wire the dead seam (built and tested, zero runtime consumers)

### R3.1 Failure classifier into the runtime loop — size M
Deliverables: after each assistant message, `classifyModelFailure` runs with the
active ModelProfile; `truncation` feeds the retry policy as transient,
refusal/loop terminate the attempt with a classified error surfaced in the
NormalizedResult. Replace the ReDoS-prone loop signature
(`src/model-profiles/deepseek-v4-pro.ts:34`) with a linear-time detector or
bounded input slice (fixes review finding #16 at the same time).

Review standards: test a synthetic refusal/loop/truncation response end-to-end
through the harness fake and assert classification + retry behavior; regression
test that the loop detector completes in bounded time on a 1 MB adversarial
string.

### R3.2 Lessons loop closed — size M
Deliverables: coordinator calls `writeVerdictLessons` on FAIL verdicts;
attempt-prompt builder appends `renderLessonsSuffix(recallVerdictLessons(...))`
for the contract's skill. Feature-flagged in profile policy (default on for
write-scoped loops).

Review standards: integration test — attempt 1 FAILs with blocker findings;
attempt 2's prompt contains the lesson; lesson TTL and `model_inferred`
isolation asserted (background recall still excludes them).

### R3.3 `window.effective` consumed — size S
Deliverables: token budget uses `profile.window.effective` when a profile
matches, falling back to `model.contextWindow`; cost prediction uses profile
cost with a startup drift-check warning against pi-ai's registry figures.

Review standards: test that a profile with `effective < declared` tightens the
compaction high-water mark; drift warning test.

### R3.4 Memory repairs (adjacent, small) — size S
Problems: upsert never upgrades trust (`src/memory/store.ts:23-33`) so a
user-confirmed fact stays invisible if the model inferred it first; the default
extractor lets the model self-tag `tool_evidenced` (trust escalation); expired
records are never GC'd.

Deliverables: upsert takes max(trust) and recomputes TTL/validity;
`tool_evidenced` only accepted from the extractor when linked to an actual
receipt id, else downgraded to `model_inferred`; recall-time GC deletes expired
records.

Review standards: trust-upgrade test (fails pre-fix); self-tagging test asserts
downgrade without receipt linkage; GC test.

Deferred within R3 (explicitly not in this plan): promoting the prompted-JSON
shim into the main GenericHarness loop. It depends on R1.3(c) and deserves its
own design pass; `model-priors.ts` stays hint-only by design.

---

## Phase R4 — Calibration, robustness, and the integration-test gate

### R4.1 CJK-aware token estimation — size M
Problem: chars/4 undercounts Chinese ~3-4×; compaction/trim/prune thresholds
fire far too late on zh sessions (a primary use case).

Deliverables: estimator distinguishes CJK codepoints (≈1 token/char class
heuristic) or uses a real tokenizer behind the ModelProfile; all threshold
consumers unchanged but recalibrated via the estimator.

Review standards: fixture test — a 10k-char zh transcript's estimate within
±25% of the real tokenizer count (record the reference count in the test);
compaction-trigger test on a zh-heavy session fires at the intended budget.

### R4.2 Small-defect sweep — size M (batchable)
One PR each or batched, every one with a fails-pre-fix test:
- `extractStatusCode` (`src/harness.ts:713-718`): parse status only from
  structured error fields / known provider shapes, not any 3-digit substring.
- Dead-end prune trigger: require the phrase to be a standalone instruction
  ("don't forget that…" must not match; add negative-lookbehind or intent list).
- Evidence truncation slices at a char boundary, hash over the final bytes
  (`src/evidence/gateway.ts:170-172`).
- Budget check per provider-turn, and re-checked per retry attempt
  (`src/harness.ts:287-288`).
- Cache-report decision↔turn alignment keyed by explicit turnIndex, not
  position (`src/observability/cache-report.ts:207-209`).
- Trim fallback never emits a context starting with assistant/toolResult
  (`src/context/manager.ts:44-71`).
- Prompted-JSON parser: only treat fenced JSON as a tool call when it matches
  the declared instruction envelope; malformed tool-JSON triggers one repair
  re-prompt instead of silently returning as the final answer
  (`src/model-adapters/prompted-json.ts:52-72, 151`).
- Replace the hand-rolled 80-line `getConfig()` clone with `structuredClone` +
  an exhaustiveness type check (`src/harness.ts:468-547`).

### R4.3 Real-runtime integration tier — size L
Problem: no test constructs a real `AgentHarness`; the pi-agent-core v0.76.0
compat surface (gate blocking in the real loop, context-hook message shapes,
stream-options patch survival, retry-on-stream-failure) is unverified.

Deliverables:
- `test/integration/` tier that boots a real `AgentHarness` against a local
  mock transport (no network): covers (a) gate deny stops execution in the real
  loop, (b) hook-override hazard is closed (pairs with R1.3b), (c) ContextManager
  trim on real message shapes, (d) cache-strategy patch applied to the outgoing
  request, (e) retry rewind on a mid-stream failure without side-effect replay
  assertions being violated.
- Wired into `npm test`; documented as the upgrade gate for any pi-agent-core
  version bump.

Review standards: reviewer confirms each of (a)–(e) exists and that (a) fails
when the gate is detached. This tier is the release gate for Phase R1–R3 claims
that were previously INCONCLUSIVE — re-verify and upgrade those claims here.

---

## Amendments (2026-07-06, post-review fixes)

1. **R3.1 loop detector is now profile-opt-in** (`failureSignatures.detectRepetitionLoops`).
   The universal linear detector fatally misclassified legitimate repetitive output
   (table rows, log lines); only profiles that declare repetition as a failure mode
   (DeepSeek V4 Pro) run it.
2. **Model-failure termination now restores the pre-attempt baseline** before entering
   FAILED, consistent with the FAIL-verdict rewind path.
3. **`diffOrigin` gained a `custom` value.** Plain-string `diffSource` returns are stamped
   `custom`, never `git` — only sources that declare provenance may claim it.
4. **R2.5 delivered as string-encoded structured criteria** on `kind: "acceptance"` hard
   constraints (`exit-zero`, `file-exists <path>`, `test-command <command>`,
   `contains <text>`; parser in `src/review/acceptance-criteria.ts`) rather than a
   TaskContract schema change — same checkers, no contract-schema migration. `file-exists`
   is verified through a filesystem capability injected by `create-agent`. Checkable
   violations FAIL before prose criteria demote to NEEDS_HUMAN.
5. **Contract runs now write memories** (with `evidenceRefs` threaded to the extractor),
   making the receipt-linked `tool_evidenced` trust path reachable; contract-path stage
   traces gained a `memory-write` entry.
6. **R4.1 review standard adapted**: no tokenizer dependency is available in this repo, so
   the "±25% of a recorded reference count" fixture is replaced by real-tokenizer
   *bracketing bounds* on a varied zh transcript (0.5–1.8 tokens/char, and ≥3× the legacy
   chars/4 estimate). A recorded-reference fixture is deferred until a tokenizer dep is
   acceptable.
7. **Exit criteria 1 and 2 are now single-run end-to-end tests**
   (`test/lifecycle/exit-criteria.e2e.test.ts`): a seeded-secret sweep across events.jsonl,
   evidence, trace, and gate persistence in one run (raw session transcript remains a
   documented unredacted surface, out of scope); and a FAIL → rewind → PASS run through
   default `createAgent` wiring asserting `completed`, bash-write restoration via the
   production env checkpoint store, and git-cited verdicts.
8. **Git diff source covers non-ASCII and space-containing filenames.** Untracked files are
   listed with `ls-files -z` (NUL-separated, unquoted) and only traversal/control-character
   shapes are rejected — filenames go to `env.readTextFile`, never a shell. Diff headers use
   `core.quotePath=false`. The wired source also returns `undefined` (→ worker self-report
   fallback) when no safe pathspec exists, instead of a placeholder that discarded the
   self-report.
9. **Env checkpoint store is binary-safe and bounded.** Snapshots use `readBinaryFile`/byte
   `writeFile` (non-UTF-8 content round-trips), with per-file (16 MB) and per-attempt
   (128 MB) caps that fail the baseline loudly with an actionable message instead of
   exhausting memory. The production store now has direct filesystem tests.
10. **R4.2 budget bullet completed: per-provider-turn enforcement.** After each `turn_end`
    the harness re-checks the hard budget and aborts the in-flight run when exceeded,
    emitting a `budget_refused` event (abort is fire-and-forget — `abort()` awaits idle and
    would deadlock inside the awaited subscriber). Verified against the real AgentHarness
    loop in the integration tier.

## Exit criteria for the whole plan

1. All R1 items merged; a seeded-secret end-to-end run (bash prints a fake key)
   produces zero unmasked occurrences across events.jsonl, evidence files,
   traces, and gate persistence.
2. A FAIL → rewind → PASS run reports `completed`, restores bash-written files,
   and its reviewer verdict cites a git diff, not a self-report.
3. `grep`-level audit: no `tool.execute` call site outside gate evaluation; no
   exported module with zero non-test consumers remaining from the R3 list
   (failure classifier, lessons, window.effective) — or an explicit deferral
   note in this file.
4. Integration tier green against pi-agent-core v0.76.0.
5. `npm run check` + `npm test` green; `docs/file-responsibility-summary.md`
   current; execution log started at `docs/repair-execution-log.md`.
