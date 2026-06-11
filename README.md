# pi-harness

`pi-harness` is a small TypeScript harness for running PI Agent sessions with provider
selection, session persistence, cost tracking, cache strategy helpers, and agent profile
scaffolding.

## Install

```bash
npm install
npm run check
```

The package requires Node.js 22.19 or newer. Set the provider API key in the environment
before running prompts. The default provider is DeepSeek, so local development typically
uses:

```bash
export DEEPSEEK_API_KEY="..."
```

On PowerShell:

```powershell
$env:DEEPSEEK_API_KEY = "..."
```

## Quickstart

Run the interactive REPL:

```bash
npx pi-harness
```

Run a one-shot prompt from this repository:

```bash
node --experimental-strip-types examples/one-shot.ts "Say exactly: ok"
```

Use a custom tool pattern:

```bash
node --experimental-strip-types examples/custom-tool.ts
```

## Agent Profiles

Design new profiles with `docs/agent-design-guide.md`, then scaffold one with:

```bash
npm run new-agent -- research
```

The script copies the profile template into `src/agents/profiles/<name>/` and registers it
in `src/agents/profiles/index.ts`.

## Configuration Reference

Programmatic configuration is resolved with `resolveHarnessConfig`.

| Field | Default | Description |
| --- | --- | --- |
| `cwd` | `process.cwd()` | Working directory for session and tool context. |
| `sessionsRoot` | `.pi-harness/sessions` | JSONL session storage root. |
| `provider` | `deepseek` | Provider identifier. |
| `modelId` | `deepseek-v4-pro` | Provider model id. |
| `apiKey` | `undefined` | API key supplied by caller or environment wiring. |
| `apiHeaders` | `undefined` | Extra provider headers. Do not store secrets in files. |
| `thinkingLevel` | `off` | Reasoning effort passed to the harness. |
| `streamOptions` | `undefined` | Provider stream options, including cache retention. |
| `systemPrompt` | `undefined` | Additional system prompt text. |
| `tools` | `undefined` | Tool definitions made available to the harness. |
| `activeToolNames` | `undefined` | Restricts active tools by name. |

Observability helpers are exported and wired through the harness:

| Module | Purpose |
| --- | --- |
| `src/observability/event-log.ts` | Append redacted harness events to session JSONL. |
| `src/observability/redact.ts` | Mask secret-looking keys and Bearer tokens. |
| `src/observability/cache-report.ts` | Compare cache strategy decisions with actual cache hit rates. |
| `src/observability/budget.ts` | Track session spend and return warn/refuse decisions. |

## REPL Commands

| Command | Description |
| --- | --- |
| `/cost` | Print session cost and cache hit summary. |
| `/cache` | Print expected cache strategy and actual cache hit summary. |
| `/sessions` | List persisted sessions for the configured working directory. |
| `/model` | Show the current model. |
| `/model <provider>/<model>` | Change provider and model when supported by the harness. |
| `/thinking` | Show the current thinking level. |
| `/thinking off|minimal|low|medium|high|xhigh` | Change thinking level when supported. |
| `/compact [instructions]` | Compact context when supported. |
| `/quit`, `/q`, `/exit` | Exit the REPL. |
