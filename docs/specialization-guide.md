# Specialization Guide

This guide shows how to shape `pi-harness` into a focused agent by combining tools,
permission policy, and prompt specialization.

## 1. Define the Job

Start with one concrete workflow. For example, a research agent might:

- Read local notes.
- Search a limited workspace.
- Summarize findings with citations.
- Refuse writes and shell execution.

Keep the first version narrow. Add capabilities only after the current loop is observable
and testable.

## 2. Choose Tools

Tools should expose small, predictable actions. Each tool needs:

- A stable name.
- A concise description.
- A typed input schema.
- A deterministic result shape.
- A permission level that matches risk.

Recommended starting set:

| Tool | Access | Use |
| --- | --- | --- |
| `read` | read-only | Read one file inside the project root. |
| `grep` | read-only | Search text in allowed roots. |
| `fetch` | network | Fetch approved HTTP resources. |
| `write` | write | Save generated artifacts when explicitly allowed. |
| `bash` | destructive | Run commands only behind an ask policy. |

## 3. Set Policy

Policy should default to least privilege.

```ts
const policy = {
	defaults: {
		"read-only": "allow",
		write: "ask",
		destructive: "ask",
		network: "ask",
	},
	tools: {
		read: "allow",
		grep: "allow",
		fetch: "ask",
		write: "ask",
		bash: "ask",
	},
};
```

Use `ask` for actions that spend money, touch the network, write files, or run commands.
Use `deny` for tools outside the specialization's job.

## 4. Write the Prompt

The prompt should describe the role, scope, output contract, and refusal rules.

```ts
const researchPrompt = `
You are a research agent for this repository.
Use local files first. Cite paths for claims about source code.
Do not write files unless the user asks for an artifact.
When evidence is missing, say what you checked and what remains unknown.
`;
```

Avoid long capability lists. The tool registry and policy define capability; the prompt
defines judgment.

## 5. Add Observability

Wire the Phase 12 helpers at the harness boundary:

- `EventLog` records one redacted JSON event per line.
- `BudgetTracker` checks whether a new turn is allowed before calling `prompt`.
- `CacheReportTracker` records cache strategy decisions and turn usage.
- `redact` should be applied before writing event payloads or debug logs.

Do not write raw provider headers, tool args, or authorization values to logs.

## 6. Test the Specialization

Add focused tests for:

- Allowed tools execute.
- Denied tools do not execute.
- Ask-policy tools surface a decision point.
- Event logs are valid JSONL and contain no secrets.
- Budget caps refuse new turns without exiting the process.

For interactive validation, run the REPL and test the intended workflow end to end.
