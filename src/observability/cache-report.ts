import type { CacheStrategyDecision, ProviderCacheStrategy } from "../cache/types.ts";
import { formatPercent, formatUsd } from "./formatter.ts";
import type { TurnCost } from "./types.ts";

const DEFAULT_SHARP_DROP_THRESHOLD = 0.25;
const DEFAULT_MIN_PREVIOUS_HIT_RATE = 0.2;
const DEFAULT_PRUNE_RECOVERY_HIT_RATE_THRESHOLD = 0.5;
const DEFAULT_PRUNE_RECOVERY_TURN_LIMIT = 2;

export interface CacheReportOptions {
	sharpDropThreshold?: number;
	minPreviousHitRate?: number;
	pruneRecoveryHitRateThreshold?: number;
	pruneRecoveryTurnLimit?: number;
}

export interface CacheDecisionRecord {
	turnIndex?: number;
	decision: CacheStrategyDecision;
}

export interface CachePruneSpanRecord {
	startTurnIndex: number;
	endTurnIndex: number;
	tokens: number;
	reason?: string;
}

export interface CachePruneEventRecord {
	turnIndex: number;
	spans: CachePruneSpanRecord[];
	tokensRemoved: number;
	tokensAfterPrunePoint: number;
	predictedOneTimeCostUsd?: number;
}

export interface CacheReportEntry {
	turnIndex: number;
	expectedStrategy: ProviderCacheStrategy;
	expectedCacheRetention?: string;
	cacheRead: number;
	cacheWrite: number;
	input: number;
	actualHitRate: number;
	pruneEvents: CachePruneEventRecord[];
	warning?: string;
}

interface ActivePruneRecovery {
	turnIndex: number;
	lowTurnCount: number;
}

interface PruneRecoveryState {
	active?: ActivePruneRecovery;
}

function cloneTurn(turn: TurnCost): TurnCost {
	return {
		turnIndex: turn.turnIndex,
		usage: {
			input: turn.usage.input,
			output: turn.usage.output,
			cacheRead: turn.usage.cacheRead,
			cacheWrite: turn.usage.cacheWrite,
			totalTokens: turn.usage.totalTokens,
			cost: {
				input: turn.usage.cost.input,
				output: turn.usage.cost.output,
				cacheRead: turn.usage.cost.cacheRead,
				cacheWrite: turn.usage.cost.cacheWrite,
				total: turn.usage.cost.total,
			},
		},
		cacheHitRate: turn.cacheHitRate,
		toolResultCount: turn.toolResultCount,
	};
}

function cloneUnknown(value: unknown): unknown {
	if (Array.isArray(value)) return value.map((entry) => cloneUnknown(entry));
	if (typeof value === "object" && value !== null) {
		const output: Record<string, unknown> = {};
		for (const [key, entry] of Object.entries(value)) output[key] = cloneUnknown(entry);
		return output;
	}
	return value;
}

function cloneDecision(decision: CacheStrategyDecision): CacheStrategyDecision {
	return {
		profile: { ...decision.profile },
		streamOptions: cloneUnknown(decision.streamOptions) as CacheStrategyDecision["streamOptions"],
	};
}

function clonePruneSpan(span: CachePruneSpanRecord): CachePruneSpanRecord {
	return {
		startTurnIndex: span.startTurnIndex,
		endTurnIndex: span.endTurnIndex,
		tokens: span.tokens,
		reason: span.reason,
	};
}

function clonePruneEvent(event: CachePruneEventRecord): CachePruneEventRecord {
	return {
		turnIndex: event.turnIndex,
		spans: event.spans.map(clonePruneSpan),
		tokensRemoved: event.tokensRemoved,
		tokensAfterPrunePoint: event.tokensAfterPrunePoint,
		predictedOneTimeCostUsd: event.predictedOneTimeCostUsd,
	};
}

function cacheRetention(decision: CacheStrategyDecision): string | undefined {
	const streamOptions = decision.streamOptions as { cacheRetention?: unknown };
	return typeof streamOptions.cacheRetention === "string" ? streamOptions.cacheRetention : undefined;
}

function warningForDrop(previous: CacheReportEntry | undefined, currentHitRate: number, options: Required<CacheReportOptions>): string | undefined {
	if (!previous) return undefined;
	if (previous.actualHitRate < options.minPreviousHitRate) return undefined;
	if (previous.actualHitRate - currentHitRate < options.sharpDropThreshold) return undefined;
	return `cache hit rate dropped from ${formatPercent(previous.actualHitRate)} to ${formatPercent(
		currentHitRate,
	)}; prompt prefix may have changed`;
}

function warningForPruneRecovery(
	entry: CacheReportEntry,
	recovery: PruneRecoveryState,
	options: Required<CacheReportOptions>,
): string | undefined {
	const latestPrune = entry.pruneEvents.at(-1);
	if (latestPrune) {
		recovery.active = { turnIndex: latestPrune.turnIndex, lowTurnCount: 0 };
		return undefined;
	}
	if (!recovery.active) return undefined;
	if (entry.actualHitRate >= options.pruneRecoveryHitRateThreshold) {
		recovery.active = undefined;
		return undefined;
	}
	recovery.active.lowTurnCount++;
	if (recovery.active.lowTurnCount <= options.pruneRecoveryTurnLimit) return undefined;
	return `cache hit rate stayed below ${formatPercent(options.pruneRecoveryHitRateThreshold)} for ${
		recovery.active.lowTurnCount
	} turns after prune at turn ${recovery.active.turnIndex}; rewrite may be unstable`;
}

function joinWarnings(warnings: Array<string | undefined>): string | undefined {
	const present = warnings.filter((warning): warning is string => Boolean(warning));
	return present.length === 0 ? undefined : present.join("; ");
}

function renderPruneEvent(event: CachePruneEventRecord): string {
	const spanLabel = event.spans.length === 1 ? "span" : "spans";
	const cost =
		event.predictedOneTimeCostUsd === undefined
			? ""
			: `, predicted cost ${formatUsd(event.predictedOneTimeCostUsd)}`;
	return `prune: ${event.spans.length} ${spanLabel}, ${event.tokensRemoved} tokens removed, ${event.tokensAfterPrunePoint} one-time tokens${cost}`;
}

function renderEntry(entry: CacheReportEntry): string {
	const retention = entry.expectedCacheRetention ? `/${entry.expectedCacheRetention}` : "";
	const base = `turn ${entry.turnIndex}: expected ${entry.expectedStrategy}${retention} | cache read ${entry.cacheRead} | hit ${formatPercent(
		entry.actualHitRate,
	)}`;
	const annotations = entry.pruneEvents.map(renderPruneEvent);
	if (entry.warning) annotations.push(`warning: ${entry.warning}`);
	return [base, ...annotations].join(" | ");
}

export class CacheReportTracker {
	private readonly options: Required<CacheReportOptions>;
	private decisions: CacheDecisionRecord[] = [];
	private pruneEvents: CachePruneEventRecord[] = [];
	private turns: TurnCost[] = [];

	constructor(options: CacheReportOptions = {}) {
		this.options = {
			sharpDropThreshold: options.sharpDropThreshold ?? DEFAULT_SHARP_DROP_THRESHOLD,
			minPreviousHitRate: options.minPreviousHitRate ?? DEFAULT_MIN_PREVIOUS_HIT_RATE,
			pruneRecoveryHitRateThreshold:
				options.pruneRecoveryHitRateThreshold ?? DEFAULT_PRUNE_RECOVERY_HIT_RATE_THRESHOLD,
			pruneRecoveryTurnLimit: options.pruneRecoveryTurnLimit ?? DEFAULT_PRUNE_RECOVERY_TURN_LIMIT,
		};
	}

	recordDecision(decision: CacheStrategyDecision, turnIndex?: number): void {
		this.decisions.push({ decision: cloneDecision(decision), turnIndex });
	}

	recordTurn(turn: TurnCost): void {
		this.turns.push(cloneTurn(turn));
	}

	recordPruneEvent(event: CachePruneEventRecord): void {
		this.pruneEvents.push(clonePruneEvent(event));
	}

	getEntries(): CacheReportEntry[] {
		const entries: CacheReportEntry[] = [];
		const pruneRecovery: PruneRecoveryState = {};
		for (const turn of this.turns) {
			const record = this.decisions.find((entry) => entry.turnIndex === turn.turnIndex);
			if (!record) continue;
			const actualHitRate = turn.cacheHitRate;
			const pruneEvents = this.pruneEvents
				.filter((event) => event.turnIndex === turn.turnIndex)
				.map(clonePruneEvent);
			const entry: CacheReportEntry = {
				turnIndex: turn.turnIndex,
				expectedStrategy: record.decision.profile.strategy,
				expectedCacheRetention: cacheRetention(record.decision),
				cacheRead: turn.usage.cacheRead,
				cacheWrite: turn.usage.cacheWrite,
				input: turn.usage.input,
				actualHitRate,
				pruneEvents,
			};
			entry.warning = joinWarnings([
				warningForDrop(entries.at(-1), actualHitRate, this.options),
				warningForPruneRecovery(entry, pruneRecovery, this.options),
			]);
			entries.push(entry);
		}
		return entries;
	}

	getWarnings(): string[] {
		return this.getEntries()
			.map((entry) => entry.warning)
			.filter((warning): warning is string => Boolean(warning));
	}

	render(): string {
		const entries = this.getEntries();
		return entries.length === 0 ? "cache: no turns recorded" : entries.map(renderEntry).join("\n");
	}

	reset(): void {
		this.decisions = [];
		this.pruneEvents = [];
		this.turns = [];
	}
}
