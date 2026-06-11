import { formatUsd } from "./formatter.ts";
import type { HarnessEvent, UsageLike } from "./types.ts";

export type BudgetDecisionStatus = "ok" | "warn" | "refuse";

export interface BudgetLimits {
	warnAtUsd?: number;
	maxUsdPerSession?: number;
}

export interface BudgetDecision {
	allowed: boolean;
	status: BudgetDecisionStatus;
	spentUsd: number;
	message?: string;
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

function usageFromTurnEnd(event: HarnessEvent): UsageLike | undefined {
	if (event.type !== "turn_end") return undefined;
	if (!isObject(event.message) || event.message.role !== "assistant") return undefined;
	return isUsageLike(event.message.usage) ? event.message.usage : undefined;
}

function normalizeLimit(value: number | undefined): number | undefined {
	if (value === undefined) return undefined;
	return Number.isFinite(value) && value >= 0 ? value : undefined;
}

export class BudgetTracker {
	private readonly warnAtUsd?: number;
	private readonly maxUsdPerSession?: number;
	private spentUsd = 0;

	constructor(limits: BudgetLimits = {}) {
		this.warnAtUsd = normalizeLimit(limits.warnAtUsd);
		this.maxUsdPerSession = normalizeLimit(limits.maxUsdPerSession);
	}

	recordSpend(usd: number): void {
		if (!Number.isFinite(usd) || usd <= 0) return;
		this.spentUsd += usd;
	}

	handleEvent(event: HarnessEvent): void {
		const usage = usageFromTurnEnd(event);
		if (!usage) return;
		this.recordSpend(usage.cost.total);
	}

	checkBeforeTurn(): BudgetDecision {
		if (this.maxUsdPerSession !== undefined && this.spentUsd >= this.maxUsdPerSession) {
			return {
				allowed: false,
				status: "refuse",
				spentUsd: this.spentUsd,
				message: `session spend ${formatUsd(this.spentUsd)} reached hard budget ${formatUsd(
					this.maxUsdPerSession,
				)}`,
			};
		}

		if (this.warnAtUsd !== undefined && this.spentUsd >= this.warnAtUsd) {
			return {
				allowed: true,
				status: "warn",
				spentUsd: this.spentUsd,
				message: `session spend ${formatUsd(this.spentUsd)} is at or above warning budget ${formatUsd(
					this.warnAtUsd,
				)}`,
			};
		}

		return {
			allowed: true,
			status: "ok",
			spentUsd: this.spentUsd,
		};
	}

	getSpentUsd(): number {
		return this.spentUsd;
	}

	reset(): void {
		this.spentUsd = 0;
	}
}
