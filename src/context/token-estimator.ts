import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { estimateTokens } from "@earendil-works/pi-agent-core";

const cjkPattern = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3040-\u30FF\uAC00-\uD7AF]/gu;

export interface TokenEstimate {
	tokens: number;
}

export function estimateTextTokens(text: string): number {
	let cjkChars = 0;
	for (const _match of text.matchAll(cjkPattern)) cjkChars += 1;
	const nonCjkChars = Math.max(0, Array.from(text).length - cjkChars);
	return Math.max(1, Math.ceil(nonCjkChars / 4) + cjkChars);
}

export function estimateMessageTokens(message: AgentMessage | undefined): number {
	if (!message) return 0;
	const text = messageText(message);
	const textEstimate = text ? estimateTextTokens(text) : 0;
	return Math.max(estimateTokens(message), textEstimate);
}

export function estimateMessagesTokens(messages: readonly AgentMessage[]): number {
	return messages.reduce((total, message) => total + estimateMessageTokens(message), 0);
}

export function estimateContextTokens(messages: readonly AgentMessage[]): TokenEstimate {
	return { tokens: estimateMessagesTokens(messages) };
}

function messageText(message: AgentMessage): string {
	const record = message as unknown as Record<string, unknown>;
	const content = record.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			if (!part || typeof part !== "object") return "";
			const recordPart = part as Record<string, unknown>;
			return recordPart.type === "text" && typeof recordPart.text === "string" ? recordPart.text : "";
		})
		.join("\n");
}
