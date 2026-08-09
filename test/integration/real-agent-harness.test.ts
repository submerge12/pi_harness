import { InMemorySessionRepo } from "@earendil-works/pi-agent-core";
import type { AgentMessage, AgentTool, ExecutionEnv, FileInfo, Session } from "@earendil-works/pi-agent-core";
import {
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	type AssistantMessage,
	type Context,
	type SimpleStreamOptions,
	type ToolResultMessage,
	type Usage,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BudgetTracker, GenericHarness, type HarnessConfig } from "../../src/index.ts";

const usage: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const allowAllPolicy = {
	defaults: {
		"read-only": "allow",
		network: "allow",
		write: "allow",
		destructive: "allow",
	},
} satisfies NonNullable<HarnessConfig["policy"]>;

const denyDestructivePolicy = {
	defaults: {
		"read-only": "allow",
		network: "allow",
		write: "allow",
		destructive: "deny",
	},
} satisfies NonNullable<HarnessConfig["policy"]>;

afterEach(() => {
	vi.restoreAllMocks();
});

describe("real AgentHarness integration", () => {
	it("denies gated tools in the real loop even when a later hook tries to allow them", async () => {
		const faux = registerLocalOpenAiFaux();
		let executed = 0;
		const tool = sideEffectTool(async () => {
			executed += 1;
			return "should not run";
		});
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("side_effect", { value: "blocked" }, { id: "call-blocked" }), {
				stopReason: "toolUse",
			}),
			(context) => fauxAssistantMessage(`final:${latestToolResultText(context)}`),
		]);
		const session = await createSession();
		const harness = new GenericHarness({
			config: {
				apiKey: "test-key",
				policy: denyDestructivePolicy,
				retry: { attempts: 1 },
				tools: [tool],
			},
			env: fakeEnv(),
			models: faux.modelsCollection,
			session,
		});
		const toolResults: Array<{ isError: boolean; text: string }> = [];
		harness.on("tool_call", () => ({ block: false }));
		harness.on("tool_result", (event) => {
			toolResults.push({ isError: event.isError, text: textFromContent(event.content) });
			return undefined;
		});

		const result = await harness.prompt("call the side effect tool");

		expect(executed).toBe(0);
		expect(toolResults).toEqual([
			{ isError: true, text: "Tool side_effect is denied by policy" },
		]);
		expect(assistantText(result)).toContain("Tool side_effect is denied by policy");
	});

	it("trims real context hook messages without starting on assistant or toolResult", async () => {
		const faux = registerLocalOpenAiFaux();
		let providerRoles: string[] | undefined;
		faux.setResponses([
			(context) => {
				providerRoles = context.messages.map((message) => message.role);
				return fauxAssistantMessage("trimmed ok");
			},
		]);
		const session = await createSession([
			userMessage(`old:${"x".repeat(5000)}`),
			userMessage(`anchor:${"x".repeat(5000)}`),
			assistantToolCallMessage("trim-call", "side_effect", { value: "trim" }),
			toolResultMessage("trim-call", "side_effect", "trim result"),
			assistantTextMessage("done"),
		]);
		const harness = new GenericHarness({
			config: {
				apiKey: "test-key",
				compaction: { enabled: false },
				contextWindow: 120,
				policy: allowAllPolicy,
				tools: [sideEffectTool(async () => "unused")],
			},
			env: fakeEnv(),
			models: faux.modelsCollection,
			session,
		});

		await harness.prompt("continue");

		expect(providerRoles?.at(0)).toBe("user");
		expect(providerRoles).toEqual(["user", "assistant", "toolResult", "assistant", "user"]);
	});

	it("applies cache-strategy patches to the outgoing provider request and report", async () => {
		const faux = registerLocalOpenAiFaux();
		let providerOptions: SimpleStreamOptions | undefined;
		faux.setResponses([
			(_context, options) => {
				providerOptions = {
					cacheRetention: options?.cacheRetention,
					headers: options?.headers,
				};
				return fauxAssistantMessage("cached ok");
			},
		]);
		const session = await createSession();
		const harness = new GenericHarness({
			config: {
				apiKey: "test-key",
				apiHeaders: { "x-api": "api" },
				cache: { enabled: true },
				streamOptions: {
					cacheRetention: "long",
					headers: { "x-stream": "stream" },
				},
				useDefaultTools: false,
			},
			env: fakeEnv(),
			models: faux.modelsCollection,
			session,
		});

		await harness.prompt("hello");

		expect(providerOptions?.cacheRetention).toBe("short");
		expect(providerOptions?.headers).toMatchObject({
			"x-api": "api",
			"x-stream": "stream",
		});
		expect(harness.getCacheReport()).toContain("expected automatic-prefix");
	});

	it("aborts a multi-turn prompt once spend crosses the hard budget mid-loop", async () => {
		const faux = registerLocalOpenAiFaux();
		let executed = 0;
		const tool = sideEffectTool(async () => {
			executed += 1;
			return "side effect recorded";
		});
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("side_effect", { value: "spend" }, { id: "call-spend" }), {
				stopReason: "toolUse",
			}),
			(context) => fauxAssistantMessage(`should not be reached:${latestToolResultText(context)}`),
		]);
		// The faux provider always reports zero cost, so accrue a fixed spend per turn_end;
		// the behavior under test is the real loop's mid-prompt re-check and abort.
		const budgetTracker = new BudgetTracker({ maxUsdPerSession: 0.5 });
		budgetTracker.handleEvent = (event) => {
			if ((event as { type: string }).type === "turn_end") budgetTracker.recordSpend(0.6);
		};
		const session = await createSession();
		const harness = new GenericHarness({
			budgetTracker,
			config: {
				apiKey: "test-key",
				policy: allowAllPolicy,
				retry: { attempts: 1 },
				tools: [tool],
			},
			env: fakeEnv(),
			models: faux.modelsCollection,
			session,
		});
		const localEvents: Array<{ type: string }> = [];
		harness.subscribe((event) => {
			localEvents.push(event as { type: string });
		});

		const result = await harness.prompt("perform side effects until stopped");

		expect(executed).toBe(1);
		expect(localEvents.some((event) => event.type === "budget_refused")).toBe(true);
		expect(assistantText(result)).not.toContain("should not be reached");
	});

	it("rewinds a retryable stream failure without replaying an already executed side effect", async () => {
		const faux = registerLocalOpenAiFaux();
		let executed = 0;
		const tool = sideEffectTool(async () => {
			executed += 1;
			return "side effect recorded";
		});
		const retryableError = {
			...fauxAssistantMessage("temporary failure", {
				stopReason: "error",
				errorMessage: "retryable stream failure",
			}),
			status: 503,
		} as AssistantMessage;
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("side_effect", { value: "once" }, { id: "call-once" }), {
				stopReason: "toolUse",
			}),
			retryableError,
			fauxAssistantMessage("recovered after retry"),
		]);
		const session = await createSession();
		const harness = new GenericHarness({
			config: {
				apiKey: "test-key",
				policy: allowAllPolicy,
				retry: { attempts: 2, baseDelayMs: 0, maxDelayMs: 0 },
				tools: [tool],
			},
			env: fakeEnv(),
			models: faux.modelsCollection,
			session,
		});

		const result = await harness.prompt("perform exactly one side effect");
		const activeContext = await session.buildContext();

		expect(assistantText(result)).toBe("recovered after retry");
		expect(executed).toBe(1);
		expect(activeContext.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
		expect(activeContext.messages.some((message) => message.role === "toolResult")).toBe(false);
	});
});

function registerLocalOpenAiFaux() {
	const faux = fauxProvider({
		api: "openai-completions",
		provider: "deepseek",
		tokensPerSecond: 0,
		tokenSize: { min: 1000, max: 1000 },
		models: [
			{
				id: "deepseek-v4-pro",
				name: "DeepSeek V4 Pro",
				contextWindow: 128000,
				maxTokens: 4096,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				input: ["text"],
			},
		],
	});
	const modelsCollection = createModels();
	modelsCollection.setProvider(faux.provider);
	return Object.assign(faux, { modelsCollection });
}

function sideEffectTool(run: (value: string) => Promise<string> | string): AgentTool {
	return {
		name: "side_effect",
		label: "Side Effect",
		description: "Records a side effect for integration tests.",
		parameters: Type.Object({ value: Type.String() }),
		execute: async (_toolCallId, args) => {
			const input = args as { value: string };
			const text = await run(input.value);
			return {
				content: [{ type: "text", text }],
				details: { value: input.value },
			};
		},
	};
}

async function createSession(messages: AgentMessage[] = []): Promise<Session> {
	const session = await new InMemorySessionRepo().create();
	for (const message of messages) await session.appendMessage(message);
	return session;
}

function userMessage(text: string): AgentMessage {
	return {
		role: "user",
		content: [{ type: "text", text }],
		timestamp: Date.now(),
	};
}

function assistantTextMessage(text: string): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-completions",
		provider: "deepseek",
		model: "deepseek-v4-pro",
		usage,
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function assistantToolCallMessage(id: string, name: string, args: Record<string, unknown>): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id, name, arguments: args }],
		api: "openai-completions",
		provider: "deepseek",
		model: "deepseek-v4-pro",
		usage,
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
}

function toolResultMessage(toolCallId: string, toolName: string, text: string): AgentMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text }],
		isError: false,
		timestamp: Date.now(),
	} satisfies ToolResultMessage as AgentMessage;
}

function latestToolResultText(context: Context): string {
	const result = [...context.messages].reverse().find((message) => message.role === "toolResult");
	return result ? textFromContent(result.content) : "";
}

function assistantText(message: AssistantMessage): string {
	return textFromContent(message.content);
}

function textFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			if (typeof part !== "object" || part === null) return "";
			const record = part as Record<string, unknown>;
			return record.type === "text" && typeof record.text === "string" ? record.text : "";
		})
		.join("");
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
