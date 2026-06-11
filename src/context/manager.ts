import type { AgentHarness, AgentMessage, ContextResult } from "@earendil-works/pi-agent-core";
import { estimateContextTokens } from "@earendil-works/pi-agent-core";
import type { TokenBudgetRatios } from "./token-budget.ts";

export interface ContextManagerOptions {
	contextWindow: number;
	ratios?: TokenBudgetRatios;
	rewriteMessages?: (messages: AgentMessage[]) => AgentMessage[];
}

export interface ContextHookEvent {
	messages: AgentMessage[];
}

interface MessageChunk {
	start: number;
	tokens: number;
}

export class ContextManager {
	private readonly contextWindow: number;
	private readonly rewriteMessages?: (messages: AgentMessage[]) => AgentMessage[];

	constructor(options: ContextManagerOptions) {
		this.contextWindow = options.contextWindow;
		this.rewriteMessages = options.rewriteMessages;
	}

	bind(harness: Pick<AgentHarness, "on">): () => void {
		return harness.on("context", (event) => this.handleContext(event));
	}

	handleContext(event: ContextHookEvent): ContextResult {
		const messages = this.rewriteMessages?.(event.messages) ?? event.messages;
		const currentTokens = estimateContextTokens(messages).tokens;

		if (currentTokens <= this.contextWindow) {
			return { messages };
		}

		return { messages: this.keepRecentSuffix(messages, this.contextWindow) };
	}

	private keepRecentSuffix(messages: AgentMessage[], tokenBudget: number): AgentMessage[] {
		if (messages.length <= 1) {
			return messages;
		}

		const messageTokens = messages.map((message) => estimateContextTokens([message]).tokens);
		const chunks = this.buildMessageChunks(messages, messageTokens);
		let selectedStart = chunks[chunks.length - 1]?.start ?? messages.length - 1;
		let selectedAny = false;
		let selectedTokens = 0;

		for (let i = chunks.length - 1; i >= 0; i--) {
			const chunk = chunks[i];
			if (!chunk) {
				continue;
			}

			if (selectedAny && selectedTokens + chunk.tokens > tokenBudget) {
				break;
			}

			selectedAny = true;
			selectedStart = chunk.start;
			selectedTokens += chunk.tokens;
		}

		return messages.slice(selectedStart);
	}

	private buildMessageChunks(messages: AgentMessage[], messageTokens: number[]): MessageChunk[] {
		const chunks: MessageChunk[] = [];
		let index = 0;

		while (index < messages.length) {
			const toolCallIds = this.getAssistantToolCallIds(messages[index]);
			if (toolCallIds.length === 0) {
				chunks.push({ start: index, tokens: messageTokens[index] ?? 0 });
				index++;
				continue;
			}

			const pendingToolCallIds = new Set(toolCallIds);
			let end = index;
			let tokens = messageTokens[index] ?? 0;

			while (end + 1 < messages.length && pendingToolCallIds.size > 0) {
				const nextToolCallId = this.getToolResultCallId(messages[end + 1]);
				if (!nextToolCallId || !pendingToolCallIds.has(nextToolCallId)) {
					break;
				}

				end++;
				tokens += messageTokens[end] ?? 0;
				pendingToolCallIds.delete(nextToolCallId);
			}

			if (pendingToolCallIds.size === 0 && this.isAssistantResponseWithoutToolCalls(messages[end + 1])) {
				end++;
				tokens += messageTokens[end] ?? 0;
			}

			chunks.push({ start: index, tokens });
			index = end + 1;
		}

		return chunks;
	}

	private getAssistantToolCallIds(message: AgentMessage | undefined): string[] {
		const record = asRecord(message);
		if (record?.role !== "assistant") {
			return [];
		}

		const ids: string[] = [];
		for (const key of ["toolCalls", "tool_calls"]) {
			const toolCalls = record[key];
			if (!Array.isArray(toolCalls)) {
				continue;
			}
			for (const toolCall of toolCalls) {
				const toolCallRecord = asRecord(toolCall);
				if (typeof toolCallRecord?.id === "string") {
					ids.push(toolCallRecord.id);
				}
			}
		}

		const content = record.content;
		if (Array.isArray(content)) {
			for (const part of content) {
				const partRecord = asRecord(part);
				if (partRecord?.type === "toolCall" && typeof partRecord.id === "string") {
					ids.push(partRecord.id);
				}
			}
		}

		return ids;
	}

	private getToolResultCallId(message: AgentMessage | undefined): string | undefined {
		const record = asRecord(message);
		if (record?.role !== "tool" && record?.role !== "toolResult") {
			return undefined;
		}

		for (const key of ["toolCallId", "tool_call_id"]) {
			const value = record[key];
			if (typeof value === "string") {
				return value;
			}
		}

		return undefined;
	}

	private isAssistantResponseWithoutToolCalls(message: AgentMessage | undefined): boolean {
		const record = asRecord(message);
		return record?.role === "assistant" && this.getAssistantToolCallIds(message).length === 0;
	}
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	if (typeof value !== "object" || value === null) {
		return undefined;
	}

	return value as Record<string, unknown>;
}
