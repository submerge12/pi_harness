import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Message, TextContent, ToolCall, UserMessage } from "@earendil-works/pi-ai";
import type { ModelProfile, ModelPromptDialect } from "../model-profiles/types.ts";

export interface PromptedJsonToolCall {
	name: string;
	arguments: Record<string, unknown>;
}

const fencedJsonBlock = /```(?:json)?\s*\n?([\s\S]*?)```/g;

let promptedToolCallCounter = 0;

function nextPromptedToolCallId(): string {
	promptedToolCallCounter += 1;
	return `prompted-json-${promptedToolCallCounter}`;
}

/**
 * System-prompt suffix that teaches a prompted-json model how to call tools:
 * the declared tool surface plus the profile's JSON elicitation phrasing.
 */
export function renderPromptedJsonToolInstructions(
	tools: readonly Pick<AgentTool, "name" | "description" | "parameters">[],
	dialect?: ModelPromptDialect,
): string {
	const toolLines = tools.map((tool) =>
		[
			`- ${tool.name}: ${tool.description}`,
			`  parameters (JSON Schema): ${JSON.stringify(tool.parameters)}`,
		].join("\n"),
	);
	return [
		"You cannot call tools natively. To call a tool, reply with a tool-call JSON object of the shape:",
		'{"tool": "<tool name>", "arguments": { ... }}',
		dialect?.jsonInstruction ??
			"Emit the JSON object inside a single fenced ```json code block with no other JSON blocks in the reply.",
		"Available tools:",
		...toolLines,
		"After each tool result is provided, either call another tool or answer the user directly without any JSON block.",
	].join("\n");
}

/** Extracts prompted tool calls from prose containing fenced JSON blocks. Non-tool-call JSON blocks are ignored. */
export function parsePromptedJsonToolCalls(text: string): PromptedJsonToolCall[] {
	const calls: PromptedJsonToolCall[] = [];
	for (const match of text.matchAll(fencedJsonBlock)) {
		const body = match[1]?.trim();
		if (!body) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(body);
		} catch {
			continue;
		}
		const call = toPromptedToolCall(parsed);
		if (call) calls.push(call);
	}
	return calls;
}

function toPromptedToolCall(value: unknown): PromptedJsonToolCall | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	const nested = record.tool_call;
	if (typeof nested === "object" && nested !== null) return toPromptedToolCall(nested);
	const name = typeof record.tool === "string" ? record.tool : typeof record.name === "string" ? record.name : undefined;
	if (!name) return undefined;
	const args = record.arguments ?? record.parameters ?? {};
	if (typeof args !== "object" || args === null || Array.isArray(args)) return undefined;
	return { name, arguments: args as Record<string, unknown> };
}

/**
 * Rewrites a prose+fenced-JSON assistant message into one carrying native ToolCall
 * content parts, so downstream tool dispatch works unchanged. Messages that already
 * contain tool calls (or no parseable calls) pass through untouched.
 */
export function coercePromptedJsonAssistantMessage(message: AssistantMessage): AssistantMessage {
	if (message.content.some((part) => part.type === "toolCall")) return message;
	const text = assistantText(message);
	const parsed = parsePromptedJsonToolCalls(text);
	if (parsed.length === 0) return message;
	const toolCalls: ToolCall[] = parsed.map((call) => ({
		type: "toolCall",
		id: nextPromptedToolCallId(),
		name: call.name,
		arguments: call.arguments,
	}));
	return {
		...message,
		content: [...message.content, ...toolCalls],
		stopReason: "toolUse",
	};
}

export type AssistantMessageCoercion = (message: AssistantMessage) => AssistantMessage;

/** Selects the tool-call coercion strategy declared by the profile. Native models pass through untouched. */
export function createToolCallCoercion(profile: Pick<ModelProfile, "toolCalling">): AssistantMessageCoercion {
	if (profile.toolCalling === "prompted-json") return coercePromptedJsonAssistantMessage;
	return (message) => message;
}

export interface PromptedJsonCompletionInput {
	systemPrompt: string;
	messages: Message[];
}

export type PromptedJsonCompletion = (input: PromptedJsonCompletionInput) => Promise<AssistantMessage>;

export interface PromptedJsonToolLoopOptions {
	profile: Pick<ModelProfile, "toolCalling" | "promptDialect">;
	complete: PromptedJsonCompletion;
	tools: readonly AgentTool[];
	prompt: string;
	systemPrompt?: string;
	maxTurns?: number;
}

export interface PromptedJsonToolLoopResult {
	message: AssistantMessage;
	toolCalls: readonly { toolCallId: string; toolName: string; arguments: Record<string, unknown>; resultText: string; isError: boolean }[];
	turns: number;
}

/**
 * Round-trips a prompted-json model through tool dispatch: coerce fenced-JSON tool
 * calls into ToolCall parts, execute them against the provided tools, feed results
 * back as plain user messages (prompted-json models have no toolResult channel),
 * and repeat until the model answers without a tool call.
 */
export async function runPromptedJsonToolLoop(options: PromptedJsonToolLoopOptions): Promise<PromptedJsonToolLoopResult> {
	const coerce = createToolCallCoercion(options.profile);
	const maxTurns = options.maxTurns ?? 8;
	const toolsByName = new Map(options.tools.map((tool) => [tool.name, tool]));
	const systemPrompt = [
		options.systemPrompt,
		renderPromptedJsonToolInstructions(options.tools, options.profile.promptDialect),
	]
		.filter((part): part is string => Boolean(part))
		.join("\n\n");
	const messages: Message[] = [userMessage(options.prompt)];
	const dispatched: { toolCallId: string; toolName: string; arguments: Record<string, unknown>; resultText: string; isError: boolean }[] = [];

	for (let turn = 1; turn <= maxTurns; turn++) {
		const raw = await options.complete({ systemPrompt, messages });
		const message = coerce(raw);
		messages.push(message);
		const toolCalls = message.content.filter((part): part is ToolCall => part.type === "toolCall");
		if (toolCalls.length === 0 || message.stopReason === "error") {
			return { message, toolCalls: dispatched, turns: turn };
		}
		for (const toolCall of toolCalls) {
			const outcome = await executeToolCall(toolsByName, toolCall);
			dispatched.push({
				toolCallId: toolCall.id,
				toolName: toolCall.name,
				arguments: toolCall.arguments,
				resultText: outcome.text,
				isError: outcome.isError,
			});
			messages.push(userMessage(renderToolResult(toolCall, outcome)));
		}
	}
	throw new Error(`prompted-json tool loop exceeded ${maxTurns} turns without a final answer`);
}

async function executeToolCall(
	toolsByName: ReadonlyMap<string, AgentTool>,
	toolCall: ToolCall,
): Promise<{ text: string; isError: boolean }> {
	const tool = toolsByName.get(toolCall.name);
	if (!tool) return { text: `Unknown tool: ${toolCall.name}`, isError: true };
	try {
		const args = tool.prepareArguments ? tool.prepareArguments(toolCall.arguments) : toolCall.arguments;
		const result = await tool.execute(toolCall.id, args);
		const text = result.content
			.map((part) => (part.type === "text" ? part.text : `[${part.type}]`))
			.join("\n");
		return { text, isError: false };
	} catch (error) {
		return { text: error instanceof Error ? error.message : String(error), isError: true };
	}
}

function renderToolResult(toolCall: ToolCall, outcome: { text: string; isError: boolean }): string {
	return [
		`Tool result for ${toolCall.name} (${toolCall.id})${outcome.isError ? " [error]" : ""}:`,
		outcome.text,
	].join("\n");
}

function userMessage(text: string): UserMessage {
	return {
		role: "user",
		content: [{ type: "text", text } satisfies TextContent],
		timestamp: Date.now(),
	};
}

function assistantText(message: AssistantMessage): string {
	return message.content
		.map((part) => (part.type === "text" ? part.text : ""))
		.join("");
}
