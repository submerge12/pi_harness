import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolResultMessage, Usage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { detectPruningCandidates } from "../src/context/relevance.ts";
import { planContextPrune } from "../src/context/prune-planner.ts";

const usage: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function userMessage(text: string, overrides: Record<string, unknown> = {}): AgentMessage {
	return {
		role: "user",
		content: text,
		timestamp: 1,
		...overrides,
	} as AgentMessage;
}

function assistantMessage(text: string): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-completions",
		provider: "openai",
		model: "test-model",
		usage,
		stopReason: "stop",
		timestamp: 1,
	} satisfies AssistantMessage as AgentMessage;
}

function assistantToolCallMessage(id: string, toolName: string, args: Record<string, unknown>): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id, name: toolName, arguments: args }],
		api: "openai-completions",
		provider: "openai",
		model: "test-model",
		usage,
		stopReason: "toolUse",
		timestamp: 1,
	} satisfies AssistantMessage as AgentMessage;
}

function assistantMultiToolCallMessage(
	calls: Array<{ id: string; toolName: string; args: Record<string, unknown> }>,
): AgentMessage {
	return {
		role: "assistant",
		content: calls.map((call) => ({
			type: "toolCall",
			id: call.id,
			name: call.toolName,
			arguments: call.args,
		})),
		api: "openai-completions",
		provider: "openai",
		model: "test-model",
		usage,
		stopReason: "toolUse",
		timestamp: 1,
	} satisfies AssistantMessage as AgentMessage;
}

function toolResultMessage(
	id: string,
	toolName: string,
	text: string,
	overrides: Record<string, unknown> = {},
): AgentMessage {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName,
		content: [{ type: "text", text }],
		isError: false,
		timestamp: 1,
		...overrides,
	} satisfies ToolResultMessage<unknown> as AgentMessage;
}

describe("cache-pruning relevance detection", () => {
	it("marks a superseded tool result as a tombstone span without removing the paired call", () => {
		const messages = [
			userMessage("read the config"),
			assistantToolCallMessage("read-1", "read", { path: "src/config.ts" }),
			toolResultMessage("read-1", "read", "old config contents ".repeat(20)),
			userMessage("read it again"),
			assistantToolCallMessage("read-2", "read", { path: "src/config.ts" }),
			toolResultMessage("read-2", "read", "new config contents"),
			userMessage("recent work"),
		];

		const candidates = detectPruningCandidates(messages, { minTurnsKept: 1 });

		expect(candidates).toHaveLength(1);
		expect(candidates[0]).toMatchObject({
			action: "tombstone_tool_result",
			reason: "superseded_tool_result",
			start: 2,
			end: 2,
			pairedToolCallIndex: 1,
		});
	});

	it("marks oversized unreferenced tool results but leaves referenced results intact", () => {
		const messages = [
			userMessage("inspect logs"),
			assistantToolCallMessage("logs-1", "read", { path: "logs/app.log" }),
			toolResultMessage("logs-1", "read", `UNREFERENCED_${"x".repeat(80)}`),
			userMessage("inspect details"),
			assistantToolCallMessage("details-1", "read", { path: "details.txt" }),
			toolResultMessage("details-1", "read", `IMPORTANT_SENTINEL_${"y".repeat(80)}`),
			userMessage("keep IMPORTANT_SENTINEL for the summary"),
		];

		const candidates = detectPruningCandidates(messages, { maxResultTokens: 1, minTurnsKept: 1 });

		expect(candidates.map((candidate) => candidate.reason)).toEqual(["oversized_unreferenced_tool_result"]);
		expect(candidates[0]?.start).toBe(2);
	});

	it("marks explicit dead-end branches as whole-message spans", () => {
		const messages = [
			userMessage("try the throwaway approach"),
			assistantMessage("draft throwaway answer"),
			userMessage("actually, forget that"),
			userMessage("use the final approach"),
		];

		const candidates = detectPruningCandidates(messages, { minTurnsKept: 0 });

		expect(candidates).toHaveLength(1);
		expect(candidates[0]).toMatchObject({
			action: "remove_messages",
			reason: "dead_end_branch_marker",
			start: 0,
			end: 1,
		});
	});

	it("does not treat reminders like don't forget that as dead-end branch markers", () => {
		const messages = [
			userMessage("write the repair plan"),
			assistantMessage("draft plan with tests"),
			userMessage("don't forget that the plan needs verification"),
			userMessage("continue with implementation"),
		];

		const candidates = detectPruningCandidates(messages, { minTurnsKept: 0 });

		expect(candidates).toEqual([]);
	});

	it("does not mark user-pinned content", () => {
		const messages = [
			userMessage("read the config"),
			assistantToolCallMessage("read-1", "read", { path: "src/config.ts" }),
			toolResultMessage("read-1", "read", "old config contents", { metadata: { userPinned: true } }),
			userMessage("read it again"),
			assistantToolCallMessage("read-2", "read", { path: "src/config.ts" }),
			toolResultMessage("read-2", "read", "new config contents"),
			userMessage("recent work"),
		];

		expect(detectPruningCandidates(messages, { minTurnsKept: 1 })).toEqual([]);
	});

	it("does not tombstone multi-tool batches because one candidate would detach the batch", () => {
		const messages = [
			userMessage("read both files"),
			assistantMultiToolCallMessage([
				{ id: "read-a-1", toolName: "read", args: { path: "src/a.ts" } },
				{ id: "read-b-1", toolName: "read", args: { path: "src/b.ts" } },
			]),
			toolResultMessage("read-a-1", "read", "a contents ".repeat(20)),
			toolResultMessage("read-b-1", "read", "old b contents ".repeat(20)),
			userMessage("read b again"),
			assistantToolCallMessage("read-b-2", "read", { path: "src/b.ts" }),
			toolResultMessage("read-b-2", "read", "new b contents"),
			userMessage("recent work"),
		];

		expect(detectPruningCandidates(messages, { minTurnsKept: 1 })).toEqual([]);
	});
});

describe("cache-pruning planner", () => {
	it("is idempotent when tool results are already tombstoned", () => {
		const messages = [
			userMessage("read the config"),
			assistantToolCallMessage("read-1", "read", { path: "src/config.ts" }),
			toolResultMessage("read-1", "read", "[result pruned: superseded by turn 4]"),
			userMessage("read it again"),
			assistantToolCallMessage("read-2", "read", { path: "src/config.ts" }),
			toolResultMessage("read-2", "read", "new config contents"),
			userMessage("recent work"),
		];

		expect(planContextPrune(messages, { minTurnsKept: 1, expectedFutureTurns: 100 })).toMatchObject({
			spans: [],
			firstPrunePoint: null,
			tokensRemoved: 0,
			tokensAfterPrunePoint: 0,
			decision: "skip_no_candidates",
			shouldPrune: false,
		});
	});

	it("protects the last ten turns by default", () => {
		const messages = [
			userMessage("read the config"),
			assistantToolCallMessage("read-1", "read", { path: "src/config.ts" }),
			toolResultMessage("read-1", "read", "old config contents"),
			userMessage("read it again"),
			assistantToolCallMessage("read-2", "read", { path: "src/config.ts" }),
			toolResultMessage("read-2", "read", "new config contents"),
		];

		expect(planContextPrune(messages, { expectedFutureTurns: 100 }).spans).toEqual([]);
	});

	it("uses expected future turns for deterministic prune decisions", () => {
		const messages = [
			userMessage("read the config"),
			assistantToolCallMessage("read-1", "read", { path: "src/config.ts" }),
			toolResultMessage("read-1", "read", "old config contents ".repeat(120)),
			userMessage("read it again"),
			assistantToolCallMessage("read-2", "read", { path: "src/config.ts" }),
			toolResultMessage("read-2", "read", "new config contents"),
			userMessage("large suffix ".repeat(1200)),
			userMessage("recent work"),
		];

		const skipped = planContextPrune(messages, { minTurnsKept: 1, expectedFutureTurns: 1 });
		const accepted = planContextPrune(messages, { minTurnsKept: 1, expectedFutureTurns: 20 });

		expect(skipped.tokensRemoved).toBeGreaterThan(0);
		expect(skipped.tokensAfterPrunePoint).toBeGreaterThan(skipped.tokensRemoved);
		expect(skipped).toMatchObject({ decision: "skip_not_economic", shouldPrune: false });
		expect(accepted).toMatchObject({ decision: "prune", shouldPrune: true });
		expect(accepted.tokensRemoved * accepted.expectedFutureTurns).toBeGreaterThan(accepted.tokensAfterPrunePoint);
	});
});
