import type { AgentTool } from "@earendil-works/pi-agent-core";
import { completeSimple } from "@earendil-works/pi-ai";
import { runPromptedJsonToolLoop } from "../model-adapters/prompted-json.ts";
import { resolveModel } from "../model-resolver.ts";
import type { ConformanceClient } from "./runner.ts";
import type { ConformanceToolBehavior, RecordedToolCall } from "./types.ts";

export interface LiveConformanceClientOptions {
	apiKey: string;
	maxTurns?: number;
}

/**
 * Real-model conformance client — opt-in only (paid API calls); CI uses mocked
 * clients. Tool dispatch runs through the model-adapters loop so the profile's
 * declared toolCalling mode (native or prompted-json) is what actually gets tested.
 */
export function createLiveConformanceClient(options: LiveConformanceClientOptions): ConformanceClient {
	return async ({ task, prompt, tools, profile }) => {
		const model = resolveModel(profile.provider, profile.modelId);
		const agentTools = tools.map((tool) => toAgentTool(tool));
		const loop = await runPromptedJsonToolLoop({
			profile,
			tools: agentTools,
			prompt,
			systemPrompt: profile.promptDialect.systemPreamble,
			maxTurns: options.maxTurns ?? 8,
			complete: async ({ systemPrompt, messages }) =>
				await completeSimple(
					model,
					{
						systemPrompt,
						messages: [...messages],
						...(profile.toolCalling === "native" && agentTools.length > 0 ? { tools: agentTools } : {}),
					},
					{
						apiKey: options.apiKey,
						reasoning: profile.promptDialect.thinkingLevel === "off" ? undefined : profile.promptDialect.thinkingLevel,
					},
				),
		});
		const toolCalls: RecordedToolCall[] = loop.toolCalls.map((call) => ({
			name: call.toolName,
			arguments: call.arguments,
			resultText: call.resultText,
			isError: call.isError,
		}));
		void task;
		return {
			text: loop.message.content.map((part) => (part.type === "text" ? part.text : "")).join(""),
			toolCalls,
		};
	};
}

function toAgentTool(tool: ConformanceToolBehavior): AgentTool {
	return {
		name: tool.name,
		label: tool.name,
		description: tool.description,
		parameters: tool.parameters,
		execute: async (_toolCallId, params) => {
			const response = tool.respond((params ?? {}) as Record<string, unknown>);
			if (response.isError) throw new Error(response.text);
			return {
				content: [{ type: "text", text: response.text }],
				details: undefined,
			};
		},
	};
}
