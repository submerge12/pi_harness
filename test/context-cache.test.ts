import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { CacheStrategyEngine } from "../src/cache/strategy-engine.ts";
import { getProviderCacheProfile } from "../src/cache/profiles.ts";
import { CompactionPolicy, type CompactionPolicyHarness } from "../src/context/compaction-policy.ts";
import { ContextManager } from "../src/context/manager.ts";
import { estimateTextTokens } from "../src/context/token-estimator.ts";
import { computeTokenBudget } from "../src/context/token-budget.ts";

function userMessage(text: string): AgentMessage {
	return {
		role: "user",
		content: text,
		timestamp: Date.now(),
	};
}

function assistantMessage(text: string): AgentMessage {
	return {
		role: "assistant",
		content: text,
		timestamp: Date.now(),
	} as unknown as AgentMessage;
}

function assistantToolCallMessage(id: string, text: string): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }, { type: "toolCall", id, name: "lookup", arguments: {} }],
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
		timestamp: Date.now(),
	} satisfies AssistantMessage as AgentMessage;
}

function toolResultMessage(id: string, text: string): AgentMessage {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: "lookup",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: Date.now(),
	} satisfies ToolResultMessage as AgentMessage;
}

function model(overrides: Partial<Model<Api>>): Model<Api> {
	return {
		id: "test-model",
		name: "Test Model",
		api: "openai-completions",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 1, output: 1, cacheRead: 0.1, cacheWrite: 0 },
		contextWindow: 100000,
		maxTokens: 4096,
		...overrides,
	};
}

describe("context and cache management", () => {
	it("computes token budgets from validated ratios", () => {
		expect(computeTokenBudget(100000)).toEqual({
			contextWindow: 100000,
			pinned: 0,
			warm: 75000,
			cold: 25000,
		});
		expect(() => computeTokenBudget(100000, { pinned: 0.1, warm: 0.8, cold: 0.2 })).toThrow(
			"Token budget ratios must sum to 1",
		);
		expect(() => computeTokenBudget(100000, { pinned: 0, warm: -0.1, cold: 1.1 })).toThrow(
			"Token budget ratio warm must be between 0 and 1",
		);
	});

	it("returns the original messages when context is below the warm budget", () => {
		const messages = [userMessage("short"), userMessage("still short")];
		const manager = new ContextManager({ contextWindow: 1000 });

		const result = manager.handleContext({ messages });

		expect(result.messages).toBe(messages);
	});

	it("does not trim warm-budget overflow before the hard context limit", () => {
		const messages = [userMessage("x".repeat(40)), userMessage("y".repeat(40))];
		const manager = new ContextManager({
			contextWindow: 100,
			ratios: { pinned: 0, warm: 0.1, cold: 0.9 },
		});

		const result = manager.handleContext({ messages });

		expect(result.messages).toBe(messages);
	});

	it("trims to a recent ordered suffix when context exceeds the hard budget", () => {
		const messages = Array.from({ length: 10 }, (_, index) => userMessage(`${index}:${"x".repeat(20)}`));
		const manager = new ContextManager({
			contextWindow: 30,
		});

		const result = manager.handleContext({ messages });

		expect(result.messages.length).toBeLessThan(messages.length);
		expect(result.messages).toEqual(messages.slice(-5));
		expect(result.messages.map((message) => (message as { content: string }).content)).toEqual([
			"5:xxxxxxxxxxxxxxxxxxxx",
			"6:xxxxxxxxxxxxxxxxxxxx",
			"7:xxxxxxxxxxxxxxxxxxxx",
			"8:xxxxxxxxxxxxxxxxxxxx",
			"9:xxxxxxxxxxxxxxxxxxxx",
		]);
	});

	it("keeps the recent suffix stable when older prefix messages change", () => {
		const suffix = Array.from({ length: 5 }, (_, index) => userMessage(`suffix-${index}:${"x".repeat(20)}`));
		const expectedSuffix = suffix.slice(-3);
		const manager = new ContextManager({
			contextWindow: 30,
		});

		const first = manager.handleContext({
			messages: [userMessage("old-a"), userMessage("old-b"), ...suffix],
		});
		const second = manager.handleContext({
			messages: [
				userMessage("older-a"),
				userMessage("older-b"),
				userMessage("older-c"),
				userMessage("older-d"),
				...suffix,
			],
		});

		expect(second.messages).toEqual(first.messages);
		expect(second.messages).toEqual(expectedSuffix);
	});

	it("preserves assistant tool-call and tool-result pairs while trimming", () => {
		const previousUser = userMessage(`old-b:${"x".repeat(2000)}`);
		const toolCall = assistantToolCallMessage("call-1", `call:${"x".repeat(20)}`);
		const toolResult = toolResultMessage("call-1", `result:${"x".repeat(20)}`);
		const finalAnswer = assistantMessage(`done:${"x".repeat(20)}`);
		const manager = new ContextManager({
			contextWindow: 3,
		});

		const result = manager.handleContext({
			messages: [
				userMessage(`old-a:${"x".repeat(2000)}`),
				previousUser,
				toolCall,
				toolResult,
				finalAnswer,
			],
		});

		expect(result.messages).toEqual([previousUser, toolCall, toolResult, finalAnswer]);
	});

	it("never starts a trimmed context with assistant or tool-result messages", () => {
		const recentUser = userMessage("continue from the latest instruction");
		const manager = new ContextManager({
			contextWindow: 3,
		});

		const result = manager.handleContext({
			messages: [
				userMessage(`old:${"x".repeat(2000)}`),
				assistantToolCallMessage("call-1", `call:${"x".repeat(20)}`),
				toolResultMessage("call-1", `result:${"x".repeat(20)}`),
				assistantMessage(`done:${"x".repeat(20)}`),
				recentUser,
			],
		});

		expect(result.messages.at(0)?.role).toBe("user");
		expect(result.messages).toContain(recentUser);
	});

	it("compacts after turn end when high-water policy is exceeded", async () => {
		let turnEndHandler: ((event: { messages: AgentMessage[] }) => Promise<void> | void) | undefined;
		let compactInstructions: string | undefined;
		const harness: CompactionPolicyHarness = {
			on(type, handler) {
				expect(type).toBe("turn_end");
				turnEndHandler = handler;
				return () => {
					turnEndHandler = undefined;
				};
			},
			async compact(customInstructions) {
				compactInstructions = customInstructions;
			},
		};
		const policy = new CompactionPolicy({
			contextWindow: 100,
			highWaterRatio: 0.5,
			customInstructions: "keep tool outputs summarized",
		});

		policy.bind(harness);
		await turnEndHandler?.({
			messages: [userMessage("short"), userMessage("x".repeat(1000))],
		});

		expect(compactInstructions).toBe("keep tool outputs summarized");
	});

	it("calibrates CJK text against real-tokenizer bounds instead of chars/4", () => {
		// Varied zh transcript (not a repeated char, which BPE tokenizers collapse).
		// Mainstream tokenizers emit ~0.6 (DeepSeek) to ~1.7 (cl100k) tokens per Chinese
		// character; the estimator must land inside that bracket, and never anywhere near
		// the legacy chars/4 heuristic that undercounted zh sessions 3-4x.
		const sentences = [
			"今天的午餐计划包括潮汕牛肉汤和一份糙米饭。",
			"用户偏好低钠饮食，每日钠摄入需要控制在两千毫克以内。",
			"蛋白质目标是每天一百四十克，主要来源为鱼类和豆制品。",
			"晚餐建议清蒸鲈鱼配西兰花，热量大约五百二十千卡。",
			"如果周末外出就餐，应提前查看菜单并估算营养成分。",
			"本周的采购清单已经根据七天的膳食计划自动生成。",
			"运动日的碳水化合物配比可以适当上调百分之十左右。",
			"睡前两小时避免进食，有助于维持稳定的血糖水平。",
		];
		const transcript = Array.from({ length: 50 }, (_, index) => sentences[index % sentences.length]).join("");
		const charCount = Array.from(transcript).length;
		const estimate = estimateTextTokens(transcript);
		const legacyCharsOver4 = Math.ceil(transcript.length / 4);

		expect(estimate).toBeGreaterThanOrEqual(charCount * 0.5);
		expect(estimate).toBeLessThanOrEqual(charCount * 1.8);
		expect(estimate).toBeGreaterThanOrEqual(legacyCharsOver4 * 3);
	});

	it("compacts CJK-heavy sessions at the intended budget", async () => {
		let turnEndHandler: ((event: { messages: AgentMessage[] }) => Promise<void> | void) | undefined;
		let compactCalls = 0;
		const harness: CompactionPolicyHarness = {
			on(_type, handler) {
				turnEndHandler = handler;
				return () => {
					turnEndHandler = undefined;
				};
			},
			async compact() {
				compactCalls += 1;
			},
		};
		const policy = new CompactionPolicy({
			contextWindow: 12_000,
			highWaterRatio: 0.85,
		});

		policy.bind(harness);
		await turnEndHandler?.({
			messages: [userMessage("汉".repeat(10_000))],
		});

		expect(compactCalls).toBe(1);
	});

	it("does not compact when disabled", async () => {
		let turnEndHandler: ((event: { messages: AgentMessage[] }) => Promise<void> | void) | undefined;
		let compactCalls = 0;
		const harness: CompactionPolicyHarness = {
			on(_type, handler) {
				turnEndHandler = handler;
				return () => {
					turnEndHandler = undefined;
				};
			},
			async compact() {
				compactCalls++;
			},
		};
		const policy = new CompactionPolicy({
			contextWindow: 100,
			enabled: false,
			highWaterRatio: 0.5,
		});

		policy.bind(harness);
		await turnEndHandler?.({
			messages: [userMessage("x".repeat(1000))],
		});

		expect(compactCalls).toBe(0);
	});

	it("selects a server-managed automatic-prefix profile for DeepSeek", () => {
		const deepseekModel = model({
			provider: "deepseek",
			baseUrl: "https://api.deepseek.com",
			compat: { thinkingFormat: "deepseek" },
		});
		const profile = getProviderCacheProfile(deepseekModel);
		const result = new CacheStrategyEngine().handleBeforeProviderRequest({
			type: "before_provider_request",
			model: deepseekModel,
			sessionId: "session-1",
			streamOptions: {},
		});

		expect(profile.strategy).toBe("automatic-prefix");
		expect(result.streamOptions).toEqual({ cacheRetention: "short" });
	});

	it("requests long explicit breakpoints for Anthropic when supported", () => {
		const anthropicModel = model({
			api: "anthropic-messages",
			provider: "anthropic",
			baseUrl: "https://api.anthropic.com",
			compat: { supportsLongCacheRetention: true },
		});
		const result = new CacheStrategyEngine({ cacheRetention: "long" }).handleBeforeProviderRequest({
			type: "before_provider_request",
			model: anthropicModel,
			sessionId: "session-1",
			streamOptions: {},
		});

		expect(result.streamOptions).toEqual({ cacheRetention: "long" });
	});

	it("adds OpenAI session affinity only with a session id and enabled caching", () => {
		const openaiModel = model({ api: "openai-responses", provider: "openai" });
		const engine = new CacheStrategyEngine();

		const withSession = engine.handleBeforeProviderRequest({
			type: "before_provider_request",
			model: openaiModel,
			sessionId: "session-1",
			streamOptions: {},
		});
		const withoutSession = engine.handleBeforeProviderRequest({
			type: "before_provider_request",
			model: openaiModel,
			sessionId: "",
			streamOptions: {},
		});
		const disabled = new CacheStrategyEngine({ cacheRetention: "none" }).handleBeforeProviderRequest({
			type: "before_provider_request",
			model: openaiModel,
			sessionId: "session-1",
			streamOptions: {},
		});

		expect(withSession.streamOptions?.headers).toEqual({
			session_id: "session-1",
			"x-client-request-id": "session-1",
			"x-session-affinity": "session-1",
		});
		expect(withSession.streamOptions?.metadata).toEqual({
			"pi.cache.sessionId": "session-1",
			"pi.cache.strategy": "session-affinity",
		});
		expect(withoutSession.streamOptions).toEqual({ cacheRetention: "short" });
		expect(disabled.streamOptions).toEqual({ cacheRetention: "none" });
	});

	it("falls back to no-cache for unsupported providers", () => {
		const result = new CacheStrategyEngine().handleBeforeProviderRequest({
			type: "before_provider_request",
			model: model({ provider: "unknown-provider", cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } }),
			sessionId: "session-1",
			streamOptions: {},
		});

		expect(result.streamOptions).toEqual({ cacheRetention: "none" });
	});
});
