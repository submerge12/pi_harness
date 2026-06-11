import { calculateCacheHitRate, cloneUsage } from "../observability/cost-tracker.ts";
import { formatTurnCost } from "../observability/formatter.ts";
import type { HarnessEvent, UsageLike } from "../observability/types.ts";
import type { TextOutput } from "./cost-display.ts";

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
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

export interface CliRendererOptions {
	output: TextOutput;
	showThinking?: boolean;
}

export class CliRenderer {
	private lastAssistantText = "";
	private output: TextOutput;
	private showThinking: boolean;

	constructor(options: CliRendererOptions) {
		this.output = options.output;
		this.showThinking = options.showThinking ?? false;
	}

	handleEvent(event: HarnessEvent): void {
		if (event.type === "message_update") {
			this.renderMessageUpdate(event);
			return;
		}
		if (event.type === "tool_execution_start") {
			this.output.write(`\n[tool:start] ${event.toolName} ${event.toolCallId}\n`);
			return;
		}
		if (event.type === "tool_execution_end") {
			this.output.write(`\n[tool:end] ${event.toolName} ${event.toolCallId} ${event.isError ? "error" : "ok"}\n`);
			return;
		}
		if (event.type === "retry") {
			this.renderRetry(event);
			return;
		}
		if (event.type === "turn_end") {
			this.renderTurnEnd(event.message);
		}
	}

	private renderRetry(event: HarnessEvent): void {
		const attempt = typeof event.attempt === "number" ? event.attempt : "?";
		const attempts = typeof event.attempts === "number" ? event.attempts : "?";
		const delayMs = typeof event.delayMs === "number" ? event.delayMs : 0;
		this.output.write(`\n[retry] attempt ${attempt}/${attempts}; retrying in ${(delayMs / 1000).toFixed(1)}s\n`);
	}

	private renderMessageUpdate(event: HarnessEvent): void {
		const delta = isObject(event) ? getEventDelta(event.assistantMessageEvent, this.showThinking) : undefined;
		if (delta) {
			this.output.write(delta);
			this.lastAssistantText += delta;
			return;
		}
		const fullText = getAssistantText(event.message);
		if (!fullText) return;
		if (fullText.startsWith(this.lastAssistantText)) {
			const diff = fullText.slice(this.lastAssistantText.length);
			if (diff) this.output.write(diff);
		}
		this.lastAssistantText = fullText;
	}

	private renderTurnEnd(message: unknown): void {
		const usage = getAssistantUsage(message);
		if (!usage) return;
		const usageSnapshot = cloneUsage(usage);
		this.output.write(
			`\n${formatTurnCost({
				turnIndex: 0,
				usage: usageSnapshot,
				cacheHitRate: calculateCacheHitRate(usageSnapshot),
				toolResultCount: 0,
			}).replace("turn 0", "turn")}\n`,
		);
		this.lastAssistantText = "";
	}
}
