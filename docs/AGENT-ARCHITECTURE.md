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
