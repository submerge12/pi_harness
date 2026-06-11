import type { CostSummary, TurnCost, UsageSnapshot } from "./types.ts";

export function formatUsd(value: number): string {
	return `$${value.toFixed(6)}`;
}

export function formatPercent(value: number): string {
	return `${(value * 100).toFixed(1)}%`;
}

export function formatUsageTokens(usage: UsageSnapshot): string {
	return `tokens ${usage.input} in, ${usage.output} out, ${usage.cacheRead} cache read, ${usage.cacheWrite} cache write`;
}

export function formatTurnCost(turn: TurnCost): string {
	return `turn ${turn.turnIndex}: ${formatUsd(turn.usage.cost.total)} | ${formatUsageTokens(
		turn.usage,
	)} | cache hit ${formatPercent(turn.cacheHitRate)}`;
}

export function formatSessionCost(summary: CostSummary): string {
	const turnLabel = summary.turnCount === 1 ? "turn" : "turns";
	return `session: ${summary.turnCount} ${turnLabel} | ${formatUsd(summary.usage.cost.total)} | ${formatUsageTokens(
		summary.usage,
	)} | cache hit ${formatPercent(summary.cacheHitRate)}`;
}
