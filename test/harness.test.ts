import { InMemorySessionRepo } from "@earendil-works/pi-agent-core";
import type { AgentMessage, AgentTool, CompactResult, ExecutionEnv, FileInfo, Session } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, Model, ToolResultMessage, Usage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CacheStrategyDecision } from "../src/cache/types.ts";
import {
	AuthenticationError,
	BudgetTracker,
	GenericHarness,
	buildPrewarmStreamOptions,
	createInMemoryTraceSink,
	createSkillCardRegistry,
	deepSeekV4ProProfile,
	type GenericHarnessInner,
	redactString,
	registerModelProfile,
	resolveApiKeyAndHeaders,
	resolveHarnessConfig,
	resolveHarnessModel,
} from "../src/index.ts";
import type { TurnCost } from "../src/observability/types.ts";
import { clearKnownSecretsForTesting } from "../src/redaction/core.ts";
import type { PermissionPolicy } from "../src/tools/types.ts";

function assistantMessage(
	stopReason: AssistantMessage["stopReason"],
	errorMessage?: string,
	text = stopReason === "error" ? "failed" : "ok",
): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
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

const denyAllPolicy: PermissionPolicy = {
	defaults: {
		"read-only": "deny",
		network: "deny",
		write: "deny",
		destructive: "deny",
	},
};

describe("GenericHarness core", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
		registerModelProfile(deepSeekV4ProProfile);
		clearKnownSecretsForTesting();
	});

	it("resolves DeepSeek V4 Pro as the default model", () => {
		const config = resolveHarnessConfig({ cwd: "G:/pi-harness" });
		const model = resolveHarnessModel(config);

		expect(model.provider).toBe("deepseek");
		expect(model.id).toBe("deepseek-v4-pro");
		expect(model.name).toBe("DeepSeek V4 Pro");
	});

	it("uses the matching ModelProfile effective window for compaction thresholds", async () => {
		registerModelProfile({
			...deepSeekV4ProProfile,
			window: { declared: deepSeekV4ProProfile.window.declared, effective: 20 },
		});
		const session = await createSession([
			userAgentMessage("original next step: continue integration"),
			userAgentMessage("large context ".repeat(1000)),
		]);
		let compacted = false;
		const inner: GenericHarnessInner = {
			...noopInner(),
			compact: async () => {
				compacted = true;
				return {} as CompactResult;
			},
		};
		const harness = new GenericHarness({
			config: {
				compaction: { highWaterRatio: 0.1 },
			},
			inner,
			session,
		});

		await harness.prompt("trigger compaction");

		expect(compacted).toBe(true);
	});

	it("warns when matched ModelProfile costs drift from the pi-ai registry", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		registerModelProfile({
			...deepSeekV4ProProfile,
			cost: {
				...deepSeekV4ProProfile.cost,
				inputPerMTok: deepSeekV4ProProfile.cost.inputPerMTok + 1,
			},
		});

		new GenericHarness({
			config: { useDefaultTools: false },
			inner: noopInner(),
		});

		expect(warn).toHaveBeenCalledWith(expect.stringContaining("ModelProfile cost drift"));
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("input profile="));
	});

	it("uses the matching ModelProfile input cost for prune cost prediction", () => {
		vi.spyOn(console, "warn").mockImplementation(() => undefined);
		registerModelProfile({
			...deepSeekV4ProProfile,
			cost: {
				...deepSeekV4ProProfile.cost,
				inputPerMTok: 2,
			},
		});
		const harness = new GenericHarness({
			config: { useDefaultTools: false },
			inner: noopInner(),
		});
		const internals = harness as unknown as {
			predictedInputCostUsd(tokens: number): number;
		};

		expect(internals.predictedInputCostUsd(1_000_000)).toBe(2);
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

	it("registers configured api keys as known redaction secrets at startup", () => {
		new GenericHarness({
			config: { apiKey: "sk-test-harness-secret", useDefaultTools: false },
			inner: noopInner(),
		});

		expect(redactString("bare sk-test-harness-secret value")).toBe("bare [REDACTED] value");
	});

	it("registers provider environment api keys as known redaction secrets at startup", () => {
		vi.stubEnv("DEEPSEEK_API_KEY", "sk-test-env-harness-secret");

		new GenericHarness({
			config: { useDefaultTools: false },
			inner: noopInner(),
		});

		expect(redactString("bare sk-test-env-harness-secret value")).toBe("bare [REDACTED] value");
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

	it("clones resolved config while preserving runtime tool functions", () => {
		const customTool: AgentTool = {
			name: "clone_safe_tool",
			label: "Clone Safe Tool",
			description: "Exercises getConfig cloning.",
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text" as const, text: "ok" }], details: undefined }),
		};
		const harness = new GenericHarness({
			config: {
				useDefaultTools: false,
				tools: [customTool],
				runPolicy: {
					lessons: { enabled: true, ttlMs: 1234, maxLessons: 3 },
					gateTiers: { G2: "human" },
				},
			},
			inner: noopInner(),
		});

		const clone = harness.getConfig();
		expect(clone.tools?.[0]).toBe(customTool);
		if (!clone.runPolicy?.lessons || !clone.runPolicy.gateTiers) throw new Error("expected cloned run policy");
		clone.runPolicy.lessons.enabled = false;
		clone.runPolicy.gateTiers.G2 = "auto";

		const freshClone = harness.getConfig();
		expect(freshClone.runPolicy?.lessons).toMatchObject({ enabled: true, ttlMs: 1234, maxLessons: 3 });
		expect(freshClone.runPolicy?.gateTiers?.G2).toBe("human");
	});

	it("retries profile-classified truncation through the existing retry policy", async () => {
		const messages = [
			assistantMessage("stop", undefined, 'Here is the result:\n```json\n{"status": "compl'),
			assistantMessage("stop", undefined, "healthy result"),
		];
		let calls = 0;
		const harness = new GenericHarness({
			config: {
				retry: { attempts: 2, baseDelayMs: 0, maxDelayMs: 0 },
			},
			inner: {
				...noopInner(),
				prompt: async () => messages[calls++] ?? assistantMessage("stop", undefined, "unexpected"),
			},
		});

		const result = await harness.prompt("hello");

		expect(calls).toBe(2);
		expect(result.content).toEqual([{ type: "text", text: "healthy result" }]);
	});

	it("surfaces profile-classified fatal output as an error assistant message", async () => {
		const harness = new GenericHarness({
			inner: {
				...noopInner(),
				prompt: async () => assistantMessage("stop", undefined, "I cannot help with that request."),
			},
		});

		const result = await harness.prompt("hello");

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("refusal");
		expect(result.content).toEqual([
			{ type: "text", text: expect.stringContaining("Model output classified as refusal") },
		]);

		const requestResult = await harness.runRequest({ rawRequest: "hello" });
		expect(requestResult.entryStage).toBe("execute");
		if (requestResult.entryStage !== "execute") throw new Error("expected execute result");
		expect(requestResult.modelFailure).toEqual({
			kind: "refusal",
			pattern: expect.stringContaining("cannot"),
		});
	});

	it("surfaces exhausted profile-classified truncation as a model failure", async () => {
		let calls = 0;
		const harness = new GenericHarness({
			config: {
				retry: { attempts: 2, baseDelayMs: 0, maxDelayMs: 0 },
			},
			inner: {
				...noopInner(),
				prompt: async () => {
					calls += 1;
					return assistantMessage("stop", undefined, 'Here is the result:\n```json\n{"status": "compl');
				},
			},
		});

		const result = await harness.runRequest({ rawRequest: "hello" });

		expect(calls).toBe(2);
		expect(result.entryStage).toBe("execute");
		if (result.entryStage !== "execute") throw new Error("expected execute result");
		expect(result.message.stopReason).toBe("error");
		expect(result.modelFailure?.kind).toBe("truncation");
	});

	it("does not infer retryable status codes from arbitrary assistant error text", async () => {
		let calls = 0;
		const harness = new GenericHarness({
			config: {
				retry: { attempts: 2, baseDelayMs: 0, maxDelayMs: 0 },
			},
			inner: {
				...noopInner(),
				prompt: async () => {
					calls += 1;
					return assistantMessage("error", "documentation mentioned HTTP 503 but no provider status field");
				},
			},
		});

		await expect(harness.runRequest({ rawRequest: "hello" })).rejects.toThrow(
			"documentation mentioned HTTP 503",
		);

		expect(calls).toBe(1);
	});

	it("retries assistant errors when a structured provider status is retryable", async () => {
		const messages = [
			{ ...assistantMessage("error", "provider overloaded"), status: 503 } as AssistantMessage,
			assistantMessage("stop", undefined, "healthy result"),
		];
		let calls = 0;
		const harness = new GenericHarness({
			config: {
				retry: { attempts: 2, baseDelayMs: 0, maxDelayMs: 0 },
			},
			inner: {
				...noopInner(),
				prompt: async () => messages[calls++] ?? assistantMessage("stop", undefined, "unexpected"),
			},
		});

		const result = await harness.prompt("hello");

		expect(calls).toBe(2);
		expect(result.content).toEqual([{ type: "text", text: "healthy result" }]);
	});

	it("rechecks the budget before each retry attempt", async () => {
		const budgetTracker = new BudgetTracker();
		let budgetChecks = 0;
		vi.spyOn(budgetTracker, "checkBeforeTurn").mockImplementation(() => {
			budgetChecks += 1;
			if (budgetChecks === 1) return { allowed: true, status: "ok", spentUsd: 0 };
			return {
				allowed: false,
				status: "refuse",
				spentUsd: 1,
				message: "budget exhausted on retry",
			};
		});
		let calls = 0;
		const harness = new GenericHarness({
			config: {
				retry: { attempts: 2, baseDelayMs: 0, maxDelayMs: 0 },
			},
			budgetTracker,
			inner: {
				...noopInner(),
				prompt: async () => {
					calls += 1;
					return assistantMessage("stop", undefined, 'Here is the result:\n```json\n{"status": "compl');
				},
			},
		});

		await expect(harness.runRequest({ rawRequest: "hello" })).rejects.toThrow("budget exhausted on retry");

		expect(calls).toBe(1);
		expect(budgetChecks).toBe(2);
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

	it("passes request-lifecycle 9-section instructions when compacting after a turn", async () => {
		const session = await createSession([
			userAgentMessage("original next step: continue integration"),
			userAgentMessage("large context ".repeat(1000)),
		]);
		let compactInstructions: string | undefined;
		const inner: GenericHarnessInner = {
			...noopInner(),
			compact: async (customInstructions?: string) => {
				compactInstructions = customInstructions;
				return {} as CompactResult;
			},
		};
		const harness = new GenericHarness({
			config: {
				contextWindow: 20,
				compaction: {
					highWaterRatio: 0.1,
					customInstructions: "Preserve decisions.",
				},
			},
			inner,
			session,
		});

		await harness.prompt("trigger compaction");

		expect(compactInstructions).toContain("full_compaction_summary");
		expect(compactInstructions).toContain("Main request & user intent");
		expect(compactInstructions).toContain("The user's original wording for the next step");
		expect(compactInstructions).toContain("Protected recent turns");
		expect(compactInstructions).toContain("Preserve decisions.");
	});

	it("enforces the lifecycle frozen prefix across GenericHarness.runRequest turns", async () => {
		const session = await new InMemorySessionRepo().create();
		const registry = createSkillCardRegistry();
		const harness = new GenericHarness({
			config: { useDefaultTools: false },
			inner: noopInner(),
			requestLifecycle: {
				skillRegistry: registry,
				routing: { routes: [] },
			},
			session,
		});

		registry.publish({
			name: "mutated.skill",
			responsibility: "Mutate the prefix.",
			whenToUse: "Only after the frozen prefix has been captured.",
			effects: [],
			adjacentFalseTriggers: [],
			positiveExamples: [],
			negativeExamples: [],
			inputs: [],
			outputs: [],
			tools: [],
			constraints: [],
			handoffContract: "Should not be visible in the frozen prefix.",
		});

		await expect(harness.runRequest({ rawRequest: "hello" })).rejects.toThrow("Frozen prefix changed");
	});

	it("routes options-bearing prompts through the request lifecycle and preserves execute options", async () => {
		const session = await new InMemorySessionRepo().create();
		const trace = createInMemoryTraceSink({ runId: "harness-options", now: () => 1 });
		const calls: Array<{ text: string; options: unknown }> = [];
		const inner: GenericHarnessInner = {
			...noopInner(),
			prompt: async (text, options) => {
				calls.push({ text, options });
				return assistantMessage("stop");
			},
		};
		const promptOptions = { maxTurns: 2 } as Parameters<GenericHarness["prompt"]>[1];
		const harness = new GenericHarness({
			config: { useDefaultTools: false },
			inner,
			requestLifecycle: {
				skillRegistry: createSkillCardRegistry(),
				intake: {
					extractionRules: [{ kind: "scope", pattern: /scope:([^\s]+)/, source: "test" }],
					requiredConstraintKinds: ["scope"],
				},
				routing: { routes: [] },
				trace,
			},
			session,
		});

		await harness.prompt("please execute scope:src", promptOptions);

		expect(calls).toHaveLength(1);
		expect(calls[0]?.text).toBe("please execute scope:src");
		expect(calls[0]?.options).toMatchObject({ maxTurns: 2 });
		expect(trace.events().map((event) => (event.data as { stage: string }).stage)).toEqual([
			"intake",
			"route",
			"skill-select",
			"memory-recall",
			"execute",
			"memory-write",
		]);
	});

	it("gates custom config tools at dispatch", async () => {
		const session = await new InMemorySessionRepo().create();
		let executed = 0;
		const customTool: AgentTool = {
			name: "custom_write",
			label: "Custom Write",
			description: "Writes custom data.",
			parameters: Type.Object({ path: Type.String() }),
			execute: async () => {
				executed += 1;
				return { content: [{ type: "text" as const, text: "wrote" }], details: undefined };
			},
		};
		const harness = new GenericHarness({
			config: {
				policy: denyAllPolicy,
				tools: [customTool],
			},
			env: fakeEnv(),
			session,
		});
		harness.on("tool_call", () => ({ block: false }));
		const inner = harness.getInner() as GenericHarnessInner & { tools?: Map<string, AgentTool> };

		await expect(inner.tools?.get("custom_write")?.execute("custom-call", { path: "out.txt" })).rejects.toThrow(
			"Tool custom_write is denied by policy",
		);
		expect(executed).toBe(0);
	});

	it("rejects ambiguous duplicate custom tool names", async () => {
		const session = await new InMemorySessionRepo().create();
		const firstTool: AgentTool = {
			name: "duplicate_tool",
			label: "First",
			description: "First duplicate.",
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text" as const, text: "first" }], details: undefined }),
		};
		const secondTool: AgentTool = {
			name: "duplicate_tool",
			label: "Second",
			description: "Second duplicate.",
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text" as const, text: "second" }], details: undefined }),
		};

		expect(() => new GenericHarness({
			config: {
				toolRegistrations: [{ tool: firstTool, accessLevel: "read-only" }],
				tools: [secondTool],
				useDefaultTools: false,
			},
			env: fakeEnv(),
			session,
		})).toThrow("Duplicate runtime tool name duplicate_tool");
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
			{ ...assistantMessage("error", "provider returned status 429"), status: 429 } as AssistantMessage,
			{ ...assistantMessage("error", "provider returned status 429"), status: 429 } as AssistantMessage,
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
