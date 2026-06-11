import { InMemorySessionRepo } from "@earendil-works/pi-agent-core";
import type { AgentMessage, ExecutionEnv, FileInfo, Session } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, Model, ToolResultMessage, Usage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CacheStrategyDecision } from "../src/cache/types.ts";
import {
	AuthenticationError,
	GenericHarness,
	buildPrewarmStreamOptions,
	type GenericHarnessInner,
	resolveApiKeyAndHeaders,
	resolveHarnessConfig,
	resolveHarnessModel,
} from "../src/index.ts";
import type { TurnCost } from "../src/observability/types.ts";

function assistantMessage(stopReason: AssistantMessage["stopReason"], errorMessage?: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: stopReason === "error" ? "failed" : "ok" }],
		api: "openai-completions",
		provider: "deepseek",
		model: "deepseek-v4-pro",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		errorMessage,
		timestamp: 0,
	};
}

function usage(input = 0, cacheRead = 0): Usage {
	return {
		input,
		output: 0,
		cacheRead,
		cacheWrite: 0,
		totalTokens: input + cacheRead,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function userAgentMessage(text: string): AgentMessage {
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
		usage: usage(),
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

async function createSession(messages: AgentMessage[]): Promise<Session> {
	const session = await new InMemorySessionRepo().create();
	for (const message of messages) await session.appendMessage(message);
	return session;
}

function noopInner(): GenericHarnessInner {
	return {
		abort: async () => ({ clearedSteer: [], clearedFollowUp: [] }),
		on: () => () => undefined,
		prompt: async () => assistantMessage("stop"),
		subscribe: () => () => undefined,
	};
}

function fakeEnv(): ExecutionEnv {
	const info: FileInfo = { kind: "directory", name: ".", path: ".", size: 0, mtimeMs: 0 };
	return {
		cwd: ".",
		absolutePath: async () => ({ ok: true, value: "." }),
		appendFile: async () => ({ ok: true, value: undefined }),
		canonicalPath: async () => ({ ok: true, value: "." }),
		cleanup: async () => undefined,
		createDir: async () => ({ ok: true, value: undefined }),
		createTempDir: async () => ({ ok: true, value: "." }),
		createTempFile: async () => ({ ok: true, value: "." }),
		exec: async () => ({ ok: true, value: { stdout: "", stderr: "", exitCode: 0 } }),
		exists: async () => ({ ok: true, value: true }),
		fileInfo: async () => ({ ok: true, value: info }),
		joinPath: async (parts: string[]) => ({ ok: true, value: parts.join("/") }),
		listDir: async () => ({ ok: true, value: [] }),
		readBinaryFile: async () => ({ ok: true, value: new Uint8Array() }),
		readTextFile: async () => ({ ok: true, value: "" }),
		readTextLines: async () => ({ ok: true, value: [] }),
		remove: async () => ({ ok: true, value: undefined }),
		writeFile: async () => ({ ok: true, value: undefined }),
	};
}

function decision(strategy: CacheStrategyDecision["profile"]["strategy"]): CacheStrategyDecision {
	return {
		profile: {
			strategy,
			supportsLongCacheRetention: false,
		},
		streamOptions: {},
	};
}

function openAiCompletionsModel(): Model<Api> {
	return {
		api: "openai-completions",
		baseUrl: "https://api.openai.com/v1",
		contextWindow: 128000,
		cost: { input: 1, output: 1, cacheRead: 0.5, cacheWrite: 0 },
		id: "gpt-test",
		input: ["text"],
		maxTokens: 4096,
		name: "GPT Test",
		provider: "openai",
		reasoning: false,
	};
}

describe("GenericHarness core", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("resolves DeepSeek V4 Pro as the default model", () => {
		const config = resolveHarnessConfig({ cwd: "G:/pi-harness" });
		const model = resolveHarnessModel(config);

		expect(model.provider).toBe("deepseek");
		expect(model.id).toBe("deepseek-v4-pro");
		expect(model.name).toBe("DeepSeek V4 Pro");
	});

	it("builds prewarm stream options with the cache strategy session metadata", () => {
		const options = buildPrewarmStreamOptions({
			auth: {
				apiKey: "config-key",
				headers: { authorization: "Bearer config-key" },
			},
			config: resolveHarnessConfig({
				cache: { cacheRetention: "long" },
				streamOptions: {
					headers: { "x-base": "yes" },
					metadata: { existing: true },
				},
				thinkingLevel: "high",
			}),
			model: openAiCompletionsModel(),
			sessionId: "session-1",
		});

		expect(options).toMatchObject({
			apiKey: "config-key",
			cacheRetention: "long",
			headers: {
				authorization: "Bearer config-key",
				session_id: "session-1",
				"x-base": "yes",
				"x-client-request-id": "session-1",
				"x-session-affinity": "session-1",
			},
			maxTokens: 1,
			metadata: {
				existing: true,
				"pi.cache.sessionId": "session-1",
				"pi.cache.strategy": "session-affinity",
			},
			reasoning: "high",
			sessionId: "session-1",
		});
	});

	it("uses config api key before provider environment keys", async () => {
		vi.stubEnv("DEEPSEEK_API_KEY", "env-key");

		const auth = await resolveApiKeyAndHeaders({
			apiKey: "config-key",
			apiHeaders: { "x-test": "yes" },
			provider: "deepseek",
		});

		expect(auth).toEqual({
			apiKey: "config-key",
			headers: { "x-test": "yes" },
		});
	});

	it("uses provider environment key when config api key is absent", async () => {
		vi.stubEnv("DEEPSEEK_API_KEY", "env-key");

		const auth = await resolveApiKeyAndHeaders({
			provider: "deepseek",
		});

		expect(auth).toEqual({ apiKey: "env-key" });
	});

	it("throws an authentication error when no api key is configured", async () => {
		vi.stubEnv("DEEPSEEK_API_KEY", "");

		await expect(resolveApiKeyAndHeaders({ provider: "deepseek" })).rejects.toMatchObject({
			name: "AuthenticationError",
			provider: "deepseek",
		});
	});

	it("wraps AgentHarness by delegating the expected methods", async () => {
		const session = await new InMemorySessionRepo().create();
		const calls: string[] = [];
		const inner: GenericHarnessInner = {
			abort: async () => {
				calls.push("abort");
				return { clearedSteer: [], clearedFollowUp: [] };
			},
			on: () => {
				calls.push("on");
				return () => undefined;
			},
			prompt: async (text: string) => {
				calls.push(`prompt:${text}`);
				return {
					role: "assistant",
					content: [{ type: "text", text: "ok" }],
					api: "openai-completions",
					provider: "deepseek",
					model: "deepseek-v4-pro",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: 0,
				};
			},
			subscribe: () => {
				calls.push("subscribe");
				return () => undefined;
			},
		};

		const harness = new GenericHarness({
			inner,
			session,
		});

		await harness.prompt("hello");
		harness.subscribe(() => undefined);
		harness.on("before_agent_start", () => undefined);
		await harness.abort();

		expect(calls).toEqual(["prompt:hello", "subscribe", "on", "abort"]);
		expect(harness.getSession()).toBe(session);
		expect(harness.getInner()).toBe(inner);
	});

	it("records harness pruning events with predicted one-time cost in the cache report", async () => {
		const messages = [
			userAgentMessage("read src/a.ts"),
			assistantToolCallMessage("read-1", "src/a.ts"),
			toolResultMessage("read-1", `stale:${"x".repeat(8000)}`),
			userAgentMessage("read src/a.ts again"),
			assistantToolCallMessage("read-2", "src/a.ts"),
			toolResultMessage("read-2", "fresh result"),
		];
		const session = await createSession(messages);
		const harness = new GenericHarness({
			config: {
				pruning: { enabled: true, expectedFutureTurns: 100, minTurnsKept: 0 },
			},
			inner: noopInner(),
			session,
		});
		const internals = harness as unknown as {
			cacheReportTracker: {
				recordDecision(decision: CacheStrategyDecision, turnIndex?: number): void;
				recordTurn(turn: TurnCost): void;
			};
			costTracker: {
				getLastTurn(): TurnCost | undefined;
				handleEvent(event: { type: "turn_end"; message: AssistantMessage; toolResults: [] }): void;
			};
			pruneAfterTurn(): Promise<void>;
		};

		internals.costTracker.handleEvent({
			type: "turn_end",
			message: { ...assistantMessage("stop"), usage: usage(100, 50) },
			toolResults: [],
		});
		const turn = internals.costTracker.getLastTurn();
		if (!turn) throw new Error("expected a recorded turn");
		internals.cacheReportTracker.recordDecision(decision("automatic-prefix"), turn.turnIndex);
		internals.cacheReportTracker.recordTurn(turn);
		await internals.pruneAfterTurn();

		const report = harness.getCacheReport();

		expect(report).toContain("prune: 1 span");
		expect(report).toContain("predicted cost $");
	});

	it("marks harness prewarm as skipped when a user turn is queued", async () => {
		const messages = [
			userAgentMessage("read src/a.ts"),
			assistantToolCallMessage("read-1", "src/a.ts"),
			toolResultMessage("read-1", `stale:${"x".repeat(8000)}`),
			userAgentMessage("read src/a.ts again"),
			assistantToolCallMessage("read-2", "src/a.ts"),
			toolResultMessage("read-2", "fresh result"),
		];
		const session = await createSession(messages);
		const harness = new GenericHarness({
			config: {
				pruning: {
					enabled: true,
					expectedFutureTurns: 100,
					minTurnsKept: 0,
					prewarmAfterPrune: true,
				},
				useDefaultTools: false,
			},
			env: fakeEnv(),
			session,
		});
		const internals = harness as unknown as {
			pruneExecutor?: { handleQueueUpdate(event: { followUp: AgentMessage[]; nextTurn: AgentMessage[]; steer: AgentMessage[] }): void };
			pruneAfterTurn(): Promise<void>;
		};

		internals.pruneExecutor?.handleQueueUpdate({
			followUp: [userAgentMessage("queued")],
			nextTurn: [],
			steer: [],
		});
		await internals.pruneAfterTurn();
		const customEntries = await session.getStorage().findEntries("custom");
		const event = customEntries[0]?.data as
			| { prewarmScheduled?: boolean; prewarmSkippedReason?: string }
			| undefined;

		expect(event).toMatchObject({
			prewarmScheduled: false,
			prewarmSkippedReason: "queued_user_turn",
		});
	});

	it("retries assistant messages that encode transient provider errors", async () => {
		const session = await new InMemorySessionRepo().create();
		const messages = [
			assistantMessage("error", "provider returned status 429"),
			assistantMessage("error", "provider returned status 429"),
			assistantMessage("stop"),
		];
		let calls = 0;
		const retryAttempts: number[] = [];
		const inner: GenericHarnessInner = {
			abort: async () => ({ clearedSteer: [], clearedFollowUp: [] }),
			on: () => () => undefined,
			prompt: async () => messages[calls++] ?? assistantMessage("stop"),
			subscribe: () => () => undefined,
		};
		const harness = new GenericHarness({
			config: { retry: { attempts: 3, baseDelayMs: 0 } },
			inner,
			session,
		});
		harness.subscribe((event) => {
			const maybeRetry = event as unknown as { attempt?: unknown; type?: unknown };
			if (maybeRetry.type === "retry" && typeof maybeRetry.attempt === "number") {
				retryAttempts.push(maybeRetry.attempt);
			}
		});

		const result = await harness.prompt("hello");

		expect(result.stopReason).toBe("stop");
		expect(calls).toBe(3);
		expect(retryAttempts).toEqual([1, 2]);
	});
});
