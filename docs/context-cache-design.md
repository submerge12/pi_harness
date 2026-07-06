# Context & Cache Design — Eviction Policy and Tool-Set Stability

Design notes for pi-harness's cache-aware context management. Companion to
`PLAN.md` (Phase 8: compaction, Phase 12: cache report), `PLAN-cache-pruning.md`
(prune-then-rehit workflow), and `docs/` interview material.

## 0. The constraint everything follows from

Provider prefix caches (DeepSeek automatic prefix cache, Anthropic explicit
breakpoints, OpenAI session-affinity caching) are **exact byte-prefix matches**.
The render order is `tools → system → messages`. A change at byte position K
re-prices everything after K at full input cost. On DeepSeek V4 Pro the price
gap is 120x (input $0.435/M vs cacheRead $0.003625/M), so cache eligibility —
not model choice — dominates the cost of long agentic sessions.

Two design rules fall out:

- **Stability-ordered layout**: pinned (never mutates) → warm (append-only) →
  volatile (last). The three tiers are invariants, not storage buckets.
- **Every history rewrite is a paid event**: compaction, pruning, and tool-list
  changes each invalidate the prefix once. Batch them; never let them happen
  accidentally (nondeterministic serialization) or per-turn (trim-on-overflow).

---

## 1. Eviction policy

Eviction is a protection list plus a priority order, executed at batch
boundaries (compaction / prune episodes), never incrementally per request.

### Never evicted

- System prompt and tool definitions (pinned tier).
- The most recent K turns (config `minTurnsKept`, default 10) — recency is the
  strongest relevance signal.
- Anything explicitly pinned by the user or a specialization profile.
- Half of a tool-call / tool-result pair — providers reject orphaned pairs
  with a 400. Pairs are evicted or kept atomically (a pruned result keeps the
  call stub plus a tombstone).

### Eviction priority order

1. **Superseded tool results** — a `read` of a file that was later re-read or
   edited; stale directory listings; failed attempts whose retry succeeded.
   Highest volume in agentic sessions, lowest risk.
2. **Large unreferenced tool results** — outputs above a size threshold
   (config `maxResultTokens`, default ~2K) that no later turn references.
3. **Dead-end branches** the user explicitly abandoned (explicit markers only;
   do not infer intent).
4. **Oldest-first via summarizing compaction** — the last resort, and it goes
   through `harness.compact()` with domain compaction instructions, never raw
   deletion.

### Eviction replaces, it does not erase

- A pruned tool result becomes a **tombstone stub**:
  `[result pruned: read of src/parser.ts at turn 3 — re-read the file if needed]`.
- Bulk-evicted spans become a **compaction summary** written under
  per-specialization instructions (coding agent: preserve file paths, decisions,
  unresolved errors; research agent: preserve sources and claims).

The index of what existed always survives; only payloads are dropped. The model
must always be able to *know* something was evicted — silent gaps are the one
forbidden failure mode.

### The recovery scenario ("round 20 needs round 3's file")

Tool results are **re-derivable: the environment, not the transcript, is the
source of truth.** The file from round 3 is still on disk. The model sees the
tombstone (or the path in the compaction summary), issues one `read` call, and
continues. Recovery cost: one cheap tool round-trip — versus carrying every
historical read forever, which bills on every turn. (This is the same rationale
behind Anthropic's context-editing feature targeting old tool results, and why
Claude Code re-reads files after compaction.)

**Non-re-derivable content** (user-pasted one-off data, ephemeral API
responses) is classified differently: summarized rather than tombstoned, and
last in the eviction order. Worst case is graceful — the model asks the user to
re-share a detail — never silent wrongness.

---

## 2. Tool-set changes vs the frozen prefix

Tools render at position 0: any add/remove/reorder invalidates 100% of the
cache, history included. There is no trick that makes this free. Three
techniques, ordered by how often they apply:

### Technique 1 — Superset registration + permission gating

**Mental model: visibility and permission are two separate layers.**

| Layer | Lives in | Cache impact |
|---|---|---|
| What the model can **see** | `tools` array in the request payload (position 0 of the prefix) | Frozen for the session |
| What the model may **execute** | `PermissionGate`'s in-memory policy map, consulted by `on("tool_call")` after generation, before execution | None — not in the payload |

Register every tool the session could plausibly need at session start.
"Enabling a tool midway" is then a policy flip (`deny → allow`) on the gate —
no payload field changes, the prefix stays byte-identical.

Timeline of a mid-session enable:

1. **Turn 1**: all 12 schemas registered; gate policy has `web_fetch: deny`.
2. **Turn 5**: model calls `web_fetch`. Gate blocks with
   `{ block: true, reason: "web_fetch is disabled. Ask the user to enable it." }`.
   The reason returns as an ordinary tool result — *appended* to history,
   cache-safe. The model relays the situation to the user.
3. **Turn 6**: user agrees. Harness flips the in-memory map entry. Optionally
   append a note ("web_fetch is now enabled") so the model needn't rediscover
   it — appending is also cache-safe.
4. **Turn 7**: model calls `web_fetch`, gate allows, it executes. Full cache
   hit on the entire history.

**Economics** (DeepSeek V4 Pro): 10 disabled tools × ~250 tokens = 2,500
tokens carried in the cached prefix ≈ **$0.000009/turn** at cacheRead rates.
The alternative — adding the tool to the array at turn 6 with a 150K-token
history — re-prices the whole prefix once: 150,000 × $0.435/M ≈ **$0.065**,
roughly the cost of carrying the disabled schemas for tens of thousands of
turns. The same arithmetic kills mid-session tool-list *trimming*: it saves a
few K schema tokens once and re-prices the entire history for the privilege.

**Limitation**: the superset must be plausible at session start. A tool whose
schema didn't exist at turn 1 (e.g. an MCP server connecting mid-session) has
nothing pre-registered to flip → Technique 2.

### Technique 2 — Generic dispatch tool for unbounded/dynamic tools

**Mental model: move tool calls from the protocol layer into the data layer.**
The `tools` array is protocol — it lives at position 0 of the prefix and must
stay frozen. Messages are data — append-only and cache-free. The dispatcher is
one ordinary, permanently-registered tool whose own schema never changes, but
whose purpose is to carry calls to *other* tools as data:

```json
{
  "name": "invoke_dynamic_tool",
  "description": "Call a tool that became available after the session started. Available dynamic tools and their argument schemas are documented in the conversation. Pass the target tool's arguments as a JSON string matching its documented schema.",
  "input_schema": {
    "type": "object",
    "properties": {
      "name":      { "type": "string", "description": "Dynamic tool to invoke" },
      "args_json": { "type": "string", "description": "JSON-encoded arguments for that tool" }
    },
    "required": ["name", "args_json"]
  }
}
```

The schema names no specific tool — `name` and `args_json` are just strings —
so the set of tools reachable through it grows without a byte of the prefix
changing.

Timeline (MCP server connects mid-session):

1. **Turn 1**: tools array = `[read, write, bash, …, invoke_dynamic_tool]`.
   Frozen.
2. **Turn 8**: user connects a Linear MCP server. The harness (a) registers
   `linear_create_issue` in an internal `dynamicTools` map (real schema, real
   executor), and (b) **appends a message** documenting it for the model —
   name, description, argument schema. Appends are cache-safe; the tools array
   is untouched.
3. **Turn 9**: the model emits a *native* call to the dispatcher (its schema
   is in the tools array): `invoke_dynamic_tool(name="linear_create_issue",
   args_json="{\"title\": \"…\", \"team\": \"ENG\"}")`.
4. **Execution**: the dispatcher executor looks up the inner tool, parses
   `args_json`, validates against the *real* typebox schema — invalid args
   return an error tool result and the model retries; valid args execute the
   MCP call. The `PermissionGate` resolves permission for the **inner** tool
   name, not the dispatcher. Every step was an append → full cache hits.

**Why argument adherence is weaker** (the trade-off, precisely): with a native
tool the provider can enforce the schema *during generation* (constrained
decoding), so arguments arrive valid by construction. Through the dispatcher,
the provider enforces only "two strings" — the inner schema is reconstructed by
the model from a documentation message possibly many turns back, JSON-encoded
inside JSON. Validity is enforced **after generation by the harness** via a
validate-and-retry loop: it works, but costs occasional retry round-trips and
higher error rates on complex schemas.

Mitigations, in order: feed validation errors back verbatim so retries
converge; re-append a failing tool's schema doc near the recent turns; and
**promote** a demonstrably hot dynamic tool into the real tools array at the
next Technique-3 boundary, where the prefix rebuild is already paid for —
making it first-class with generation-time enforcement.

Same shape as Anthropic's tool-search tool, which appends discovered tool
information rather than swapping the tool list, specifically to preserve the
cache.

### Technique 3 — Batch unavoidable changes at compaction boundaries

Compaction already invalidates the prefix — a paid-for rebuild. Queue real
tool-list changes (adds, removals, promotions from the dispatcher) and apply
them at the next compaction, collapsing two invalidations into one. Same
amortization logic as the prune-then-rehit workflow in `PLAN-cache-pruning.md`.

### Operational note — the accidental killer

The most common tool-related cache destroyer in practice is not a deliberate
change but **nondeterministic serialization**: tools emitted from an unordered
map, so their byte order varies per request and silently invalidates the whole
prefix every turn. Mitigations already in / planned for the harness:

- `ToolRegistry.toAgentTools()` must emit tools in a deterministic (sorted or
  insertion-stable) order — guard with a unit test.
- The Phase 12 cache report alarms when hit rate drops sharply turn-over-turn —
  the signature of prefix invalidation, and the regression detector for this
  whole document's invariants.

---

## 3. One-line summaries

- **Eviction**: evict re-derivable content first, replace it with tombstones so
  the model knows what it can recover; recovery is one tool call, because the
  environment — not the transcript — is the source of truth.
- **Tool sets**: the tools array defines what the model can *see*; the
  permission gate defines what it may *do*. Only visibility lives in the cached
  prefix — so freeze visibility at session start and make all mid-session
  capability changes on the policy side, where they're free.
