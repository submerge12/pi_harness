import type { AgentMessage, Session } from "@earendil-works/pi-agent-core";
import { InMemorySessionRepo } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { DEFAULT_PRUNING_CONFIG, PruneExecutor } from "../src/context/prune-executor.ts";

function userMessage(text: string): AgentMessage {
	return {
		role: "user",
		content: text,
		timestamp: 0,
	};
}

function assistantToolCallMessage(id: string, path: string): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id, name: "read", arguments: { path } }],
		api: "openai-completions",
		provider: "openai",
		model: "test-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: 0,
	} satisfies AssistantMessage as AgentMessage;
}

function toolResultMessage(id: string, text: string): AgentMessage {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: "read",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: 0,
	} satisfies ToolResultMessage as AgentMessage;
}

function prunableMessages(): AgentMessage[] {
	const staleResult = `stale:${"x".repeat(8000)}`;
	return [
		userMessage("read src/a.ts"),
		assistantToolCallMessage("call-1", "src/a.ts"),
		toolResultMessage("call-1", staleResult),
		userMessage("read src/a.ts again"),
		assistantToolCallMessage("call-2", "src/a.ts"),
		toolResultMessage("call-2", "fresh result"),
	];
}

async function createSession(messages: AgentMessage[]): Promise<Session> {
	const session = await new InMemorySessionRepo().create();
	for (const message of messages) {
		await session.appendMessage(message);
	}
	return session;
}

describe("PruneExecutor", () => {
	it("test_turn_end_appends_custom_prune_entry_and_rewrites_context_prefix", async () => {
		const messages = prunableMessages();
		const session = await createSession(messages);
		const executor = new PruneExecutor({
			config: { ...DEFAULT_PRUNING_CONFIG, enabled: true, expectedFutureTurns: 100, minTurnsKept: 0 },
			session,
		});

		const pruned = await executor.handleTurnEnd();
		const context = executor.rewriteContext([...messages, userMessage("next request")]);
		const customEntries = await session.getStorage().findEntries("custom");

		expect(pruned).toBe(true);
		expect(context).toContain(messages[0]);
		expect(context).toContain(messages[3]);
		expect(context).toContain(messages[4]);
		expect(context).toContain(messages[5]);
		expect(context).toContainEqual(userMessage("next request"));
		expect(context).not.toContain(messages[2]);
		if (context.includes(messages[1])) {
			expect(context).toContainEqual(expect.objectContaining({ role: "toolResult", toolCallId: "call-1" }));
		}
		expect(customEntries).toHaveLength(1);
		expect(customEntries[0]).toMatchObject({
			customType: "prune",
			data: {
				predictedOneTimeCostTokens: expect.any(Number),
				sourceMessageCount: messages.length,
				spans: [expect.objectContaining({ reason: expect.stringContaining("superseded") })],
				tokensRemoved: expect.any(Number),
			},
		});
	});

	it("test_turn_end_does_not_reapply_when_pruned_context_has_no_plan", async () => {
		const messages = prunableMessages();
		const session = await createSession(messages);
		const executor = new PruneExecutor({
			config: { ...DEFAULT_PRUNING_CONFIG, enabled: true, expectedFutureTurns: 100, minTurnsKept: 0 },
			session,
		});

		await executor.handleTurnEnd();
		const secondPruned = await executor.handleTurnEnd();
		const customEntries = await session.getStorage().findEntries("custom");

		expect(secondPruned).toBe(false);
		expect(customEntries).toHaveLength(1);
	});

	it("test_prewarm_skips_when_user_turn_is_queued", async () => {
		const messages = prunableMessages();
		let prewarmCalls = 0;
		const session = await createSession(messages);
		const executor = new PruneExecutor({
			config: {
				...DEFAULT_PRUNING_CONFIG,
				enabled: true,
				expectedFutureTurns: 100,
				minTurnsKept: 0,
				prewarmAfterPrune: true,
			},
			prewarm: async () => {
				prewarmCalls++;
			},
			session,
		});

		executor.handleQueueUpdate({ followUp: [userMessage("queued")], nextTurn: [], steer: [] });
		await executor.handleTurnEnd();

		expect(prewarmCalls).toBe(0);
	});
});
