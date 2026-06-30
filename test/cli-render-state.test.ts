import { describe, expect, it } from "vitest";
import { createCliRenderState, reduceCliEvent } from "../src/cli/render-state.ts";
import type { UsageLike } from "../src/observability/types.ts";

function usage(): UsageLike {
	return {
		input: 100,
		output: 25,
		cacheRead: 40,
		cacheWrite: 5,
		totalTokens: 170,
		cost: { input: 0.001, output: 0.002, cacheRead: 0.0002, cacheWrite: 0.0001, total: 0.0033 },
	};
}

function assistantMessage(text: string, messageUsage: UsageLike = usage()): unknown {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		usage: messageUsage,
	};
}

describe("CLI render state reducer", () => {
	it("streams text deltas to classic output and live assistant text", () => {
		const result = reduceCliEvent(createCliRenderState(), {
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", delta: "hello" },
		});

		expect(result.classicChunks).toEqual(["hello"]);
		expect(result.state.liveAssistantText).toBe("hello");
		expect(result.state.lastAssistantText).toBe("hello");
	});

	it("streams thinking deltas only when showThinking is enabled", () => {
		const hidden = reduceCliEvent(createCliRenderState(), {
			type: "message_update",
			assistantMessageEvent: { type: "thinking_delta", delta: "hmm" },
		});
		const shown = reduceCliEvent(createCliRenderState(), {
			type: "message_update",
			assistantMessageEvent: { type: "thinking_delta", delta: "hmm" },
		}, { showThinking: true });

		expect(hidden.classicChunks).toEqual([]);
		expect(hidden.state.liveAssistantText).toBe("");
		expect(shown.classicChunks).toEqual(["hmm"]);
		expect(shown.state.liveAssistantText).toBe("hmm");
	});

	it("falls back to full assistant message diffing", () => {
		const first = reduceCliEvent(createCliRenderState(), {
			type: "message_update",
			message: assistantMessage("hello"),
		});
		const second = reduceCliEvent(first.state, {
			type: "message_update",
			message: assistantMessage("hello world"),
		});

		expect(first.classicChunks).toEqual(["hello"]);
		expect(second.classicChunks).toEqual([" world"]);
		expect(second.state.liveAssistantText).toBe("hello world");
	});

	it("records tool start and end lines for classic output and TUI status", () => {
		const started = reduceCliEvent(createCliRenderState(), {
			type: "tool_execution_start",
			toolName: "read",
			toolCallId: "call-1",
		});
		const ended = reduceCliEvent(started.state, {
			type: "tool_execution_end",
			toolName: "read",
			toolCallId: "call-1",
			isError: true,
		});

		expect(started.classicChunks).toEqual(["\n[tool:start] read call-1\n"]);
		expect(ended.classicChunks).toEqual(["\n[tool:end] read call-1 error\n"]);
		expect(ended.state.toolLines).toEqual([
			{ id: "call-1", text: "[tool:start] read call-1", tone: "running" },
			{ id: "call-1", text: "[tool:end] read call-1 error", tone: "error" },
		]);
		expect(ended.state.statusText).toBe("read call-1 error");
	});

	it("records retry notices", () => {
		const result = reduceCliEvent(createCliRenderState(), {
			type: "retry",
			attempt: 2,
			attempts: 4,
			delayMs: 1250,
		});

		expect(result.classicChunks).toEqual(["\n[retry] attempt 2/4; retrying in 1.3s\n"]);
		expect(result.state.noticeLines).toEqual(["[retry] attempt 2/4; retrying in 1.3s"]);
		expect(result.state.statusText).toBe("retrying in 1.3s");
	});

	it("commits assistant text, writes cost footer, and resets streaming state on turn end", () => {
		const streamed = reduceCliEvent(createCliRenderState(), {
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", delta: "done" },
		});
		const result = reduceCliEvent(streamed.state, {
			type: "turn_end",
			message: assistantMessage("done"),
		});

		expect(result.classicChunks).toEqual([
			"\nturn: $0.003300 | tokens 100 in, 25 out, 40 cache read, 5 cache write | cache hit 27.6%\n",
		]);
		expect(result.state.transcript).toEqual([{ role: "assistant", text: "done" }]);
		expect(result.state.liveAssistantText).toBe("");
		expect(result.state.lastAssistantText).toBe("");
		expect(result.state.footerText).toBe(
			"turn: $0.003300 | tokens 100 in, 25 out, 40 cache read, 5 cache write | cache hit 27.6%",
		);
	});
});
