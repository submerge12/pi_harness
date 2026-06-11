import type { CostSummary, HarnessEvent, HarnessEventSource, TurnCost, UsageLike, UsageSnapshot } from "./types.ts";

function zeroUsage(): UsageSnapshot {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function isNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isUsageLike(value: unknown): value is UsageLike {
	if (!isObject(value) || !isObject(value.cost)) return false;
	return (
		isNumber(value.input) &&
		isNumber(value.output) &&
		isNumber(value.cacheRead) &&
		isNumber(value.cacheWrite) &&
		isNumber(value.totalTokens) &&
		isNumber(value.cost.input) &&
		isNumber(value.cost.output) &&
		isNumber(value.cost.cacheRead) &&
		isNumber(value.cost.cacheWrite) &&
		isNumber(value.cost.total)
	);
}

function getAssistantUsage(message: unknown): UsageLike | undefined {
	if (!isObject(message) || message.role !== "assistant") return undefined;
	return isUsageLike(message.usage) ? message.usage : undefined;
}

export function cloneUsage(usage: UsageLike): UsageSnapshot {
	return {
		input: usage.input,
		output: usage.output,
		cacheRead: usage.cacheRead,
		cacheWrite: usage.cacheWrite,
		totalTokens: usage.totalTokens,
		cost: {
			input: usage.cost.input,
			output: usage.cost.output,
			cacheRead: usage.cost.cacheRead,
			cacheWrite: usage.cost.cacheWrite,
			total: usage.cost.total,
		},
	};
}

function cloneTurn(turn: TurnCost): TurnCost {
	return {
		turnIndex: turn.turnIndex,
		usage: cloneUsage(turn.usage),
		cacheHitRate: turn.cacheHitRate,
		toolResultCount: turn.toolResultCount,
	};
}

function addUsage(total: UsageSnapshot, usage: UsageSnapshot): void {
	total.input += usage.input;
	total.output += usage.output;
	total.cacheRead += usage.cacheRead;
	total.cacheWrite += usage.cacheWrite;
	total.totalTokens += usage.totalTokens;
	total.cost.input += usage.cost.input;
	total.cost.output += usage.cost.output;
	total.cost.cacheRead += usage.cost.cacheRead;
	total.cost.cacheWrite += usage.cost.cacheWrite;
	total.cost.total += usage.cost.total;
}

export function calculateCacheHitRate(usage: UsageSnapshot): number {
	const inputSideTokens = usage.input + usage.cacheRead + usage.cacheWrite;
	return inputSideTokens === 0 ? 0 : usage.cacheRead / inputSideTokens;
}

export class CostTracker {
	private turns: TurnCost[] = [];

	handleEvent(event: HarnessEvent): void {
		if (event.type !== "turn_end") return;
		const usage = getAssistantUsage(event.message);
		if (!usage) return;
		const usageSnapshot = cloneUsage(usage);
		this.turns.push({
			turnIndex: this.turns.length + 1,
			usage: usageSnapshot,
			cacheHitRate: calculateCacheHitRate(usageSnapshot),
			toolResultCount: Array.isArray(event.toolResults) ? event.toolResults.length : 0,
		});
	}

	subscribeTo(harness: HarnessEventSource): () => void {
		return harness.subscribe((event) => {
			this.handleEvent(event);
		});
	}

	getTurns(): TurnCost[] {
		return this.turns.map(cloneTurn);
	}

	getLastTurn(): TurnCost | undefined {
		const turn = this.turns.at(-1);
		return turn ? cloneTurn(turn) : undefined;
	}

	getSummary(): CostSummary {
		const usage = zeroUsage();
		for (const turn of this.turns) addUsage(usage, turn.usage);
		return {
			turnCount: this.turns.length,
			usage,
			cacheHitRate: calculateCacheHitRate(usage),
		};
	}

	reset(): void {
		this.turns = [];
	}
}
