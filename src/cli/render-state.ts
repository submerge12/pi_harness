import { calculateCacheHitRate, cloneUsage } from "../observability/cost-tracker.ts";
import { formatTurnCost } from "../observability/formatter.ts";
import type { HarnessEvent, UsageLike } from "../observability/types.ts";

export interface CliTranscriptItem {
	role: "assistant";
	text: string;
}

export interface CliToolLine {
	id: string;
	text: string;
	tone: "running" | "ok" | "error";
}

export interface CliRenderState {
	lastAssistantText: string;
	liveAssistantText: string;
	transcript: CliTranscriptItem[];
	statusText: string;
	noticeLines: string[];
	toolLines: CliToolLine[];
	footerText: string;
}

export interface CliRenderOptions {
	showThinking?: boolean;
}

export interface CliRenderResult {
	state: CliRenderState;
	classicChunks: string[];
}

export function createCliRenderState(): CliRenderState {
	return {
		lastAssistantText: "",
		liveAssistantText: "",
		transcript: [],
		statusText: "",
		noticeLines: [],
		toolLines: [],
		footerText: "",
	};
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function getString(value: unknown, fallback = "?"): string {
	return typeof value === "string" ? value : fallback;
}

function getEventDelta(event: unknown, showThinking: boolean): string | undefined {
	if (!isObject(event) || typeof event.type !== "string") return undefined;
	if (event.type === "text_delta" && typeof event.delta === "string") return event.delta;
	if (showThinking && event.type === "thinking_delta" && typeof event.delta === "string") return event.delta;
	return undefined;
}

function getTextFromContent(content: unknown): string | undefined {
	if (!Array.isArray(content)) return undefined;
	const text = content
		.flatMap((part) => {
			if (!isObject(part) || part.type !== "text" || typeof part.text !== "string") return [];
			return [part.text];
		})
		.join("");
	return text.length > 0 ? text : undefined;
}

function getAssistantText(message: unknown): string | undefined {
	if (!isObject(message) || message.role !== "assistant") return undefined;
	return getTextFromContent(message.content);
}

function getAssistantUsage(message: unknown): UsageLike | undefined {
	if (!isObject(message) || message.role !== "assistant" || !isObject(message.usage)) return undefined;
	const usage = message.usage;
	if (!isObject(usage.cost)) return undefined;
	const fields = [usage.input, usage.output, usage.cacheRead, usage.cacheWrite, usage.totalTokens];
	const costs = [usage.cost.input, usage.cost.output, usage.cost.cacheRead, usage.cost.cacheWrite, usage.cost.total];
	return fields.every((value) => typeof value === "number") && costs.every((value) => typeof value === "number")
		? (usage as unknown as UsageLike)
		: undefined;
}

function formatUsageFooter(usage: UsageLike): string {
	const usageSnapshot = cloneUsage(usage);
	return formatTurnCost({
		turnIndex: 0,
		usage: usageSnapshot,
		cacheHitRate: calculateCacheHitRate(usageSnapshot),
		toolResultCount: 0,
	}).replace("turn 0", "turn");
}

function appendAssistantText(state: CliRenderState, text: string): CliRenderState {
	return {
		...state,
		lastAssistantText: state.lastAssistantText + text,
		liveAssistantText: state.liveAssistantText + text,
	};
}

function reduceMessageUpdate(
	state: CliRenderState,
	event: HarnessEvent,
	options: CliRenderOptions,
): CliRenderResult {
	const delta = isObject(event) ? getEventDelta(event.assistantMessageEvent, options.showThinking ?? false) : undefined;
	if (delta) {
		return {
			state: appendAssistantText(state, delta),
			classicChunks: [delta],
		};
	}

	const fullText = getAssistantText(isObject(event) ? event.message : undefined);
	if (!fullText) return { state, classicChunks: [] };

	const diff = fullText.startsWith(state.lastAssistantText) ? fullText.slice(state.lastAssistantText.length) : "";
	return {
		state: {
			...state,
			lastAssistantText: fullText,
			liveAssistantText: fullText,
		},
		classicChunks: diff ? [diff] : [],
	};
}

function reduceToolStart(state: CliRenderState, event: HarnessEvent): CliRenderResult {
	const toolName = isObject(event) ? getString(event.toolName) : "?";
	const toolCallId = isObject(event) ? getString(event.toolCallId) : "?";
	const text = `[tool:start] ${toolName} ${toolCallId}`;
	return {
		state: {
			...state,
			statusText: `${toolName} ${toolCallId} running`,
			toolLines: [...state.toolLines, { id: toolCallId, text, tone: "running" }],
		},
		classicChunks: [`\n${text}\n`],
	};
}

function reduceToolEnd(state: CliRenderState, event: HarnessEvent): CliRenderResult {
	const toolName = isObject(event) ? getString(event.toolName) : "?";
	const toolCallId = isObject(event) ? getString(event.toolCallId) : "?";
	const outcome = isObject(event) && event.isError ? "error" : "ok";
	const text = `[tool:end] ${toolName} ${toolCallId} ${outcome}`;
	return {
		state: {
			...state,
			statusText: `${toolName} ${toolCallId} ${outcome}`,
			toolLines: [...state.toolLines, { id: toolCallId, text, tone: outcome }],
		},
		classicChunks: [`\n${text}\n`],
	};
}

function reduceRetry(state: CliRenderState, event: HarnessEvent): CliRenderResult {
	const attempt = isObject(event) && typeof event.attempt === "number" ? event.attempt : "?";
	const attempts = isObject(event) && typeof event.attempts === "number" ? event.attempts : "?";
	const delayMs = isObject(event) && typeof event.delayMs === "number" ? event.delayMs : 0;
	const seconds = (delayMs / 1000).toFixed(1);
	const text = `[retry] attempt ${attempt}/${attempts}; retrying in ${seconds}s`;
	return {
		state: {
			...state,
			statusText: `retrying in ${seconds}s`,
			noticeLines: [...state.noticeLines, text],
		},
		classicChunks: [`\n${text}\n`],
	};
}

function reduceTurnEnd(state: CliRenderState, event: HarnessEvent): CliRenderResult {
	const message = isObject(event) ? event.message : undefined;
	const assistantText = getAssistantText(message) ?? state.liveAssistantText;
	const transcript = assistantText ? [...state.transcript, { role: "assistant" as const, text: assistantText }] : state.transcript;
	const usage = getAssistantUsage(message);
	const footerText = usage ? formatUsageFooter(usage) : state.footerText;

	return {
		state: {
			...state,
			lastAssistantText: "",
			liveAssistantText: "",
			transcript,
			footerText,
			statusText: usage ? footerText : state.statusText,
		},
		classicChunks: usage ? [`\n${footerText}\n`] : [],
	};
}

export function reduceCliEvent(
	state: CliRenderState,
	event: HarnessEvent,
	options: CliRenderOptions = {},
): CliRenderResult {
	if (!isObject(event) || typeof event.type !== "string") return { state, classicChunks: [] };
	if (event.type === "message_update") return reduceMessageUpdate(state, event, options);
	if (event.type === "tool_execution_start") return reduceToolStart(state, event);
	if (event.type === "tool_execution_end") return reduceToolEnd(state, event);
	if (event.type === "retry") return reduceRetry(state, event);
	if (event.type === "turn_end") return reduceTurnEnd(state, event);
	return { state, classicChunks: [] };
}
