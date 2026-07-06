import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import {
	coercePromptedJsonAssistantMessage,
	createToolCallCoercion,
	parsePromptedJsonToolCalls,
	renderPromptedJsonToolInstructions,
	runPromptedJsonToolLoop,
} from "../../src/model-adapters/prompted-json.ts";
import type { ModelProfile } from "../../src/model-profiles/index.ts";

const promptedJsonProfile: Pick<ModelProfile, "toolCalling" | "promptDialect"> = {
	toolCalling: "prompted-json",
	promptDialect: {
		jsonInstruction: "Emit exactly one fenced ```json block.",
	},
};

function assistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-completions",
		provider: "openai",
		model: "mock-prompted-json",
		usage: {
			input: 10,
			output: 10,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 20,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1,
	};
}

const weatherTool: AgentTool = {
	name: "get_weather",
	label: "Get weather",
	description: "Returns the weather for a city.",
	parameters: Type.Object({ city: Type.String() }, { additionalProperties: false }),
	execute: async (_toolCallId, params) => ({
		content: [{ type: "text", text: `Weather in ${(params as { city: string }).city}: 21C, clear` }],
		details: undefined,
	}),
};

describe("prompted-json parsing and coercion", () => {
	it("parses tool calls from prose with a fenced JSON block", () => {
		const text = [
			"I will look that up for you.",
			"```json",
			'{"tool": "get_weather", "arguments": {"city": "Shanghai"}}',
			"```",
			"One moment.",
		].join("\n");
		expect(parsePromptedJsonToolCalls(text)).toEqual([
			{ name: "get_weather", arguments: { city: "Shanghai" } },
		]);
	});

	it("requires the declared tool envelope and ignores non-tool JSON blocks", () => {
		const text = [
			"```json",
			'{"result": "just data, not a call"}',
			"```",
			"```json",
			'{"tool_call": {"name": "get_weather", "arguments": {"city": "Beijing"}}}',
			"```",
		].join("\n");
		expect(parsePromptedJsonToolCalls(text)).toEqual([]);
	});

	it("rewrites a prose+JSON assistant message into native ToolCall parts", () => {
		const message = assistantMessage('Sure.\n```json\n{"tool": "get_weather", "arguments": {"city": "Xi\'an"}}\n```');
		const coerced = coercePromptedJsonAssistantMessage(message);
		const toolCalls = coerced.content.filter((part) => part.type === "toolCall");
		expect(toolCalls).toHaveLength(1);
		expect(toolCalls[0]).toMatchObject({ name: "get_weather", arguments: { city: "Xi'an" } });
		expect(coerced.stopReason).toBe("toolUse");
	});

	it("leaves plain answers and native tool-call messages untouched", () => {
		const plain = assistantMessage("The answer is 42.");
		expect(coercePromptedJsonAssistantMessage(plain)).toBe(plain);
		const native = createToolCallCoercion({ toolCalling: "native" });
		const proseCall = assistantMessage('```json\n{"tool": "get_weather", "arguments": {"city": "x"}}\n```');
		expect(native(proseCall)).toBe(proseCall);
	});

	it("renders tool instructions carrying the profile's JSON dialect", () => {
		const instructions = renderPromptedJsonToolInstructions([weatherTool], promptedJsonProfile.promptDialect);
		expect(instructions).toContain("get_weather");
		expect(instructions).toContain("Emit exactly one fenced ```json block.");
		expect(instructions).toContain('"tool"');
	});
});

describe("prompted-json tool dispatch round-trip", () => {
	it("round-trips a prose-only model through tool dispatch to a grounded final answer", async () => {
		const transcript: Message[][] = [];
		// Mocked model that cannot emit native tool calls: first turn answers in
		// prose+fenced JSON, second turn reads the tool result from the context.
		const complete = async ({ messages }: { systemPrompt: string; messages: Message[] }) => {
			transcript.push([...messages]);
			const lastUser = [...messages].reverse().find((message) => message.role === "user");
			const lastUserText =
				lastUser && Array.isArray(lastUser.content)
					? lastUser.content.map((part) => (part.type === "text" ? part.text : "")).join("")
					: String(lastUser?.content ?? "");
			if (lastUserText.startsWith("Tool result for get_weather")) {
				return assistantMessage(`Based on the tool output: ${lastUserText.split("\n")[1]}`);
			}
			return assistantMessage(
				'Let me check the weather.\n```json\n{"tool": "get_weather", "arguments": {"city": "Hangzhou"}}\n```',
			);
		};

		const result = await runPromptedJsonToolLoop({
			profile: promptedJsonProfile,
			complete,
			tools: [weatherTool],
			prompt: "What is the weather in Hangzhou?",
			permission: { mode: "trusted-in-memory-tools" },
		});

		expect(result.turns).toBe(2);
		expect(result.toolCalls).toHaveLength(1);
		expect(result.toolCalls[0]).toMatchObject({
			toolName: "get_weather",
			arguments: { city: "Hangzhou" },
			resultText: "Weather in Hangzhou: 21C, clear",
			isError: false,
		});
		const finalText = result.message.content
			.map((part) => (part.type === "text" ? part.text : ""))
			.join("");
		expect(finalText).toContain("Weather in Hangzhou: 21C, clear");
		// The dispatched call was recorded in the conversation as a native ToolCall part.
		const secondTurnContext = transcript[1]!;
		const coercedAssistant = secondTurnContext.find(
			(message): message is AssistantMessage => message.role === "assistant",
		);
		expect(coercedAssistant?.content.some((part) => part.type === "toolCall")).toBe(true);
	});

	it("feeds unknown-tool errors back to the model instead of crashing", async () => {
		let calls = 0;
		const complete = async () => {
			calls += 1;
			if (calls === 1) {
				return assistantMessage('```json\n{"tool": "does_not_exist", "arguments": {}}\n```');
			}
			return assistantMessage("I could not complete the lookup because the tool is unavailable.");
		};
		const result = await runPromptedJsonToolLoop({
			profile: promptedJsonProfile,
			complete,
			tools: [weatherTool],
			prompt: "Use the mystery tool.",
			permission: { mode: "trusted-in-memory-tools" },
		});
		expect(result.toolCalls[0]).toMatchObject({ toolName: "does_not_exist", isError: true });
		expect(result.turns).toBe(2);
	});

	it("repair-prompts once for malformed fenced tool JSON before dispatching", async () => {
		let calls = 0;
		let repairPrompt = "";
		const complete = async ({ messages }: { systemPrompt: string; messages: Message[] }) => {
			calls += 1;
			const lastUser = [...messages].reverse().find((message) => message.role === "user");
			const lastUserText = Array.isArray(lastUser?.content)
				? lastUser.content.map((part) => (part.type === "text" ? part.text : "")).join("")
				: "";
			if (calls === 1) {
				return assistantMessage('```json\n{"tool": "get_weather", "arguments": {"city": "Hangzhou"\n```');
			}
			if (calls === 2) {
				repairPrompt = lastUserText;
				return assistantMessage('```json\n{"tool": "get_weather", "arguments": {"city": "Hangzhou"}}\n```');
			}
			return assistantMessage(`Used the tool after repair: ${lastUserText.split("\n")[1]}`);
		};

		const result = await runPromptedJsonToolLoop({
			profile: promptedJsonProfile,
			complete,
			tools: [weatherTool],
			prompt: "What is the weather in Hangzhou?",
			permission: { mode: "trusted-in-memory-tools" },
		});

		expect(calls).toBe(3);
		expect(result.turns).toBe(3);
		expect(repairPrompt).toContain("malformed");
		expect(repairPrompt).toContain("fenced ```json block");
		expect(result.toolCalls[0]).toMatchObject({
			toolName: "get_weather",
			arguments: { city: "Hangzhou" },
			isError: false,
		});
	});

	it("honors permission denials without executing prompted-json tools", async () => {
		let completeCalls = 0;
		let executed = 0;
		let secondTurnText = "";
		const deniedTool: AgentTool = {
			...weatherTool,
			execute: async (...args) => {
				executed += 1;
				return await weatherTool.execute(...args);
			},
		};
		const complete = async ({ messages }: { systemPrompt: string; messages: Message[] }) => {
			completeCalls += 1;
			if (completeCalls === 1) {
				return assistantMessage('```json\n{"tool": "get_weather", "arguments": {"city": "Hangzhou"}}\n```');
			}
			const lastUser = [...messages].reverse().find((message) => message.role === "user");
			secondTurnText = Array.isArray(lastUser?.content)
				? lastUser.content.map((part) => (part.type === "text" ? part.text : "")).join("")
				: "";
			return assistantMessage("I could not use the weather tool.");
		};

		const result = await runPromptedJsonToolLoop({
			profile: promptedJsonProfile,
			complete,
			tools: [deniedTool],
			prompt: "What is the weather in Hangzhou?",
			permission: {
				mode: "permission-gate",
				askCallback: async () => false,
				policy: {
					defaults: { "read-only": "ask", network: "ask", write: "deny", destructive: "deny" },
				},
				registrations: [{ tool: deniedTool, accessLevel: "network" }],
			},
		});

		expect(executed).toBe(0);
		expect(result.toolCalls[0]).toMatchObject({
			toolName: "get_weather",
			isError: true,
			resultText: "Tool get_weather requires approval",
		});
		expect(secondTurnText).toContain("Tool result for get_weather");
		expect(secondTurnText).toContain("Tool get_weather requires approval");
	});

	it("throws when the model never stops calling tools", async () => {
		const complete = async () =>
			assistantMessage('```json\n{"tool": "get_weather", "arguments": {"city": "loop"}}\n```');
		await expect(
			runPromptedJsonToolLoop({
				profile: promptedJsonProfile,
				complete,
				tools: [weatherTool],
				prompt: "Loop forever.",
				maxTurns: 3,
				permission: { mode: "trusted-in-memory-tools" },
			}),
		).rejects.toThrow(/exceeded 3 turns/);
	});
});
