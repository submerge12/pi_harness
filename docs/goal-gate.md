# Automatic goal verification

`GenericHarness.prompt()` and `runRequest({ rawRequest })` can opt into completion verification through `requestLifecycle.goalGate`. TaskContracts continue through their existing receipt and worker–reviewer path. Direct `skill()`, template, and inner-runtime calls do not use this gate.

The worker promise settles before verification starts. A host observation first checks current artifacts, receipts, and pending jobs. Only a `ready` observation reaches an independent semantic judge. A successful judgment is accepted only after a second observation confirms that the evidence remains unchanged.

```typescript
import {
  createAgent, codingProfile, createModelGoalJudge,
  resolveHarnessConfig, resolveHarnessModel,
  type GoalObservation,
} from "pi-harness";

// Implement this against your product's current artifacts and verification records.
declare function inspectWork(goal: string, signal: AbortSignal): Promise<GoalObservation>;

const agent = await createAgent(codingProfile, {
  requestLifecycle: {
    goalGate: {
      observe: ({ goal, signal }) => inspectWork(goal, signal),
      judge: createModelGoalJudge({
        model: resolveHarnessModel(resolveHarnessConfig({})),
        streamOptions: { maxTokens: 800 },
      }),
      maxContinuations: 2,
      checkTimeoutMs: 30_000,
    },
  },
});

try {
  const result = await agent.runRequest({ rawRequest: "Complete and verify the deliverable" });
  if (result.entryStage === "execute") console.log(result.goal);
} finally {
  await agent.dispose();
}
```

The host returns `ready`, `incomplete`, `pending`, or `blocked`, with a `summary`. The summary must include stable evidence versions or artifact fingerprints; a changed artifact with an identical summary cannot be detected. Do not derive `ready` from a worker completion claim. Pending jobs return WAITING without calling the judge or repeatedly prompting the worker. Incomplete evidence requests a bounded continuation. Blocked evidence returns NEEDS_HUMAN.

The result contains `goal.state`, `goal.reason`, and `goal.continuations`. States are COMPLETE, WAITING, NEEDS_HUMAN, CANCELLED, LIMIT_REACHED, and FAILED. Non-complete outcomes return an explicit status message and skip memory extraction. Worker errors, aborted responses, unfinished tool use, and output limits cannot count as completion. Invalid or timed-out verification fails closed.

When enabled, requests share one session queue. New input invalidates older automatic continuations; an already-running worker finishes before the next request starts. `abort()` also calls Pi's abort. `dispose()` cancels verification before releasing resources. Host observation and judge callbacks must honor their AbortSignal; late results are discarded, but arbitrary external code cannot be forcibly stopped.

`createModelGoalJudge` makes a fresh `completeSimple` call with no tools and no worker session history. Its authentication can use the model provider's environment configuration or `streamOptions.apiKey`. Judge usage is separate from the worker BudgetTracker; account for it in the host's total budget. The gate's defaults are two additional worker runs and a 30-second timeout for each observation or judge call.

Goal state is scoped to one request and held in memory. A trace sink receives a terminal `stage` event with `data.stage = "goal-gate"`. It is not a durable task store. WAITING does not install a background listener; after a real completion event, the host owns resubmission with current evidence and any cross-request budget. Existing permissions, task-contract gates, and evidence capture remain authoritative.

## Strict PowerShell 7 sessions

On Windows, opt into PowerShell 7 when creating or opening a session:

```typescript
import { createJsonlSession, createAgent, codingProfile } from "pi-harness";

const { env, session } = await createJsonlSession({
  cwd: process.cwd(),
  sessionsRoot: ".sessions",
  shellMode: "powershell7",
});
const agent = await createAgent(codingProfile, { env, session });
```

The factory resolves the actual `pwsh.exe` process through Get-Command and verifies its major version before constructing Pi's execution environment. Missing executables and Windows PowerShell paths fail without fallback. An optional `shellPath` must name `pwsh.exe`. The default session factory shell remains unchanged.

Pi 0.76 invokes an explicit shell using `-c`, which PowerShell 7 supports. The environment retains Pi's output streaming, exit codes, AbortSignal, timeouts, and Windows process-tree termination. Only the version probe uses `-NoProfile`; execution retains Pi's startup arguments. Commands must use PowerShell syntax. The existing tool name remains `bash` and its description refers to a shell command. This option does not add an OS sandbox or deletion filtering.
