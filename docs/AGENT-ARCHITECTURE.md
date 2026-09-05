# Pi-Harness Pluggable Agent Architecture

## Core Idea

Pi-harness is a **framework** (the host). Each **domain agent** (travel, coding, research...) is an **external package** that plugs in by exporting an `AgentProfile` object. The framework handles LLM conversation, session persistence, permissions, cost tracking, context management, and scheduling — the agent only provides domain-specific tools and behavior.

## The Contract: `AgentProfile`

Every agent implements one interface (`src/agents/profile.ts`):

```typescript
interface AgentProfile {
  name: string;                    // unique identifier, e.g. "travel"
  description: string;             // shown in agent list
  systemPrompt: string;            // domain instructions for the LLM
  tools?: AgentToolDefinition[];   // static registrations OR factory functions
  policy?: PermissionPolicy;       // per-access-level defaults + per-tool overrides
  model?: { provider, modelId };   // default LLM (can be overridden by CLI/config)
  thinkingLevel?: ThinkingLevel;
  context?: { ratios?, compactionInstructions? };
  skills?: Skill[];
  scheduledTasks?: ScheduledTaskDefinition[];   // periodic background tasks
  proactiveCheck?: (ctx) => Promise<string>;    // called by scheduler, no LLM
  install?: (harness) => Promise<disposer>;     // lifecycle hook: migrations, pool init
}
```

## Tool Registration Pattern

Each tool is a `{ tool, accessLevel }` pair. `accessLevel` is one of `"read-only" | "write" | "destructive" | "network"`, and the framework's `PermissionPolicy` maps each level to `"allow" | "ask" | "deny"`.

Tools can be defined two ways:

1. **Static** — a `ToolRegistration` object directly in the `tools` array
2. **Factory** — a function `(context: { env, config }) => ToolRegistration[]` that receives runtime context (env vars, resolved config with DB url, etc.) and builds tools dynamically

The travel agent uses a factory (`travelToolFactory`) because it needs API keys and database connections at construction time.

### Tool source: in-process or MCP

A profile's tools can also come from an MCP server instead of its own factories.
The `toolSource` config field selects the route:

| value | meaning |
| --- | --- |
| `"in-process"` | Build tools from the profile's factories. **Default.** |
| `"mcp"` | Spawn the profile's MCP server, list its tools, and adapt each one. |

`toolSource` is accepted at the top level of a config file and per agent under
`agents.<name>`, and can be set for a single run with `PI_HARNESS_TOOL_SOURCE`.
Precedence is config field, then env var, then `"in-process"`.

MCP tools **replace** the in-process ones rather than joining them, because the
tool registry rejects duplicate names.

**Fallback is automatic.** If the server cannot be spawned, the handshake fails,
or the opening sequence errors, the profile logs a warning naming the cause and
continues with its in-process tools. A missing MCP server degrades the agent's
reach, never its ability to boot.

**Run ledger.** compass-health requires every call to carry a run handle. The
adapter performs the ritual once per session and threads the result into each
call whose schema declares it:

1. `health_get_system_status` — liveness, before anything is written.
2. `health_begin_run` — mints the `runHandle`.
3. Every adapted call receives that handle plus a fresh `idempotencyKey`. Both
   are stripped from the schema the model sees, so they cannot be hallucinated.
4. `health_end_run` on close, with `outcome: "completed"`.

The two ledger tools are driven by the adapter and never exposed to the model.

**Environment.** The server inherits this process's environment; these are
merged over it, and an already-set variable always wins:

| variable | default |
| --- | --- |
| `COMPASS_HEALTH_ACTOR` | `pi-harness` |
| `COMPASS_HEALTH_ACTOR_TYPE` | `agent` |
| `COMPASS_HEALTH_RUNTIME_NAME` | `pi-harness` |
| `COMPASS_HEALTH_ALLOW_USER_PROVISIONING` | `false` |
| `COMPASS_HEALTH_MEDIA_RUNTIME` | `embedded` |
| `COMPASS_HEALTH_PROJECTION_WORKER_MODE` | `embedded` |
| `COMPASS_HEALTH_USER_BINDING` | `default-user` |
| `DATABASE_URL` | `COMPASS_HEALTH_DATABASE_URL`, else the ambient `DATABASE_URL` |

Where the server lives is overridable too: `PI_HARNESS_HEALTH_MCP_ENTRY` (the
script, default `../compass-health-agent/dist/mcp/stdio.js` relative to this
repo), `PI_HARNESS_HEALTH_MCP_COMMAND` (default: this Node binary), and
`PI_HARNESS_HEALTH_MCP_CWD`.

The client pins protocol revision `2026-07-28`, which compass-health serves
natively; it never falls back to the 2025 handshake. A failed startup quotes the
server's own last stderr lines, so causes like an unreachable database name
themselves instead of surfacing as an opaque negotiation error.

The integration test that exercises the real server is gated:

```bash
PI_HARNESS_MCP_INTEGRATION=1 \
DATABASE_URL=postgres://compass:compass@localhost:5433/compass_health \
npx vitest --run test/integration/mcp-health-tool-source.test.ts
```

## How an Agent Boots

```
CLI: pi-harness --agent travel --scheduler
       |
       v
  1. registerBuiltInProfiles()     <- registers coding, research, data-analysis
  2. registerProfile(travelAgent)  <- external agent registers itself
  3. getProfile("travel")          <- look up by name
  4. createAgent(profile, config)
       |
       +-- mergeAgentProfileConfig()  <- merge profile defaults with CLI/config overrides
       +-- resolveHarnessConfig()     <- fill in defaults, resolve DATABASE_URL
       +-- resolveToolDefinition()    <- call factory functions with { env, config }
       +-- PermissionGate.install()   <- wire up permission checking
       +-- profile.install(harness)   <- run migrations, init pools, return disposer
       +-- installScheduler()         <- collect scheduledTasks, start timer loop
```

## How to Build a New Agent

### Step 1: Create a separate package

```
my-new-agent/
+-- package.json          # exports: { ".": "./src/profile/agent.ts" }
+-- src/
|   +-- profile/
|   |   +-- agent.ts      # exports AgentProfile
|   |   +-- tool-factory.ts
|   |   +-- install.ts
|   +-- tools/
|   |   +-- my-tool-a.ts  # AgentTool<TParams, TDetails>
|   |   +-- my-tool-b.ts
|   +-- services/          # external API wrappers
|   +-- engine/            # domain logic (no LLM dependency)
|   +-- db/
|   |   +-- schema.ts     # Drizzle tables in YOUR pgSchema
|   +-- store/             # typed store interfaces + Postgres implementations
+-- docker/
    +-- init.sql           # CREATE SCHEMA IF NOT EXISTS my_schema;
```

### Step 2: Define your tool(s)

```typescript
// src/tools/my-tool.ts
import { Type } from "@sinclair/typebox";

const MyToolParams = Type.Object({
  action: Type.Union([Type.Literal("list"), Type.Literal("run")]),
  target: Type.Optional(Type.String()),
});

export function createMyTool(service: MyService): AgentTool<typeof MyToolParams, MyDetails> {
  return {
    name: "my_tool",
    label: "My Tool",
    description: "Does the thing.",
    parameters: MyToolParams,
    async execute(_toolCallId, params) {
      // call your service, return { content, details }
    },
  };
}
```

### Step 3: Write the tool factory

```typescript
// src/profile/tool-factory.ts
export function myToolFactory(context: AgentToolFactoryContext): ToolRegistration[] {
  const apiKey = context.env.SOME_API_KEY;
  const dbUrl = context.config.database?.url;
  // build services, stores, etc.
  return [
    { tool: createMyTool(service), accessLevel: "network" },
    { tool: createMyOtherTool(store), accessLevel: "write" },
  ];
}
```

### Step 4: Export the profile

```typescript
// src/profile/agent.ts
export const myAgentProfile: AgentProfile = {
  name: "my-agent",
  description: "Does X for Y",
  systemPrompt: "...",
  tools: [myToolFactory],
  policy: {
    defaults: { "read-only": "allow", network: "allow", write: "ask", destructive: "deny" },
  },
  model: { provider: "deepseek", modelId: "deepseek-chat" },
  install: myInstallHook,        // optional: migrations
  proactiveCheck: myCheck,       // optional: background checks
  scheduledTasks: [{ ... }],     // optional: periodic triggers
};
```

### Step 5: Register with pi-harness

Add to `pi-harness/src/agents/profiles/index.ts`:

```typescript
import { myAgentProfile } from "my-new-agent";
// add to builtInProfiles array
```

Or register dynamically before boot:

```typescript
registerProfile(myAgentProfile);
```

## Key Patterns

| Pattern | What it gives you |
|---|---|
| **Tool factory function** | Runtime context (env vars, DB url) injected at boot, not hardcoded |
| **Separate pgSchema per agent** | Agents share one Postgres but own their tables. No collisions. |
| **Fallback stores** | In-memory implementations let tests run without Docker |
| **Install hook + disposer** | Run migrations on boot, close DB pool on shutdown |
| **`proactiveCheck` (no LLM)** | Pure function for scheduled background work — cheap, fast, testable |
| **Lightweight tools export** | Let other agents use a subset of your tools without full infrastructure |
| **Policy merge (stricter wins)** | `spawn_agent` can't escalate permissions beyond its parent |
| **`package.json` exports map** | Multiple entry points: full profile, tools only, lightweight |

## Database Architecture

```
PostgreSQL (pi_agents)
+-- public schema        <- pi-harness core: agent_events, notifications
+-- travel schema        <- travel-assistant: schedules, trips, route_preferences
+-- <your_schema>        <- your new agent's tables
```

Each agent defines its own `pgSchema("name")` in its Drizzle schema. The `docker/init.sql` creates the schema. Pi-harness's `install` hook runs Drizzle migrations at boot.

## Running

```bash
# Start shared DB
docker compose up -d

# Boot a specific agent
pi-harness --agent travel

# Boot with scheduler (proactive checks)
pi-harness --agent travel --scheduler

# Delegate from one agent to another (in conversation)
# The coding agent can use spawn_agent tool to call travel agent
pi-harness --agent coding
```

## Reference Implementation

The travel-assistant at `G:\travel-assistant` is the first complete external agent. Key files:

- `src/profile/travel-agent.ts` — full AgentProfile with all optional fields
- `src/profile/tool-factory.ts` — factory building 5 tools from env/config
- `src/profile/install.ts` — Drizzle migration hook with disposer
- `src/profile/lightweight-tools.ts` — subset export for other agents
- `src/profile/fallback-stores.ts` — in-memory stores for testing without DB
- `src/db/schema.ts` — Drizzle schema in `travel` pgSchema
- `src/tools/` — 5 tools (travel_analyze, weather_query, trip_manage, trip_check, schedule_manage)
- `src/engine/` — domain logic: advisor, route-selector, schedule-runner, proactive-check
