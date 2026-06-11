import type { AgentHarnessEvent, AgentMessage, Session } from "@earendil-works/pi-agent-core";
import {
	applyPrunePlan,
	DEFAULT_PRUNE_EXPECTED_FUTURE_TURNS,
	planContextPrune,
	type PrunePlan,
	type PruningConfig,
} from "./prune-planner.ts";
import { DEFAULT_PRUNE_MAX_RESULT_TOKENS, DEFAULT_PRUNE_MIN_TURNS_KEPT } from "./relevance.ts";

export type { PrunePlan, PruningConfig } from "./prune-planner.ts";

export interface ResolvedPruningConfig {
	enabled: boolean;
	minTurnsKept: number;
	maxResultTokens: number;
	expectedFutureTurns: number;
	prewarmAfterPrune: boolean;
}

export const DEFAULT_PRUNING_CONFIG: ResolvedPruningConfig = {
	enabled: false,
	minTurnsKept: DEFAULT_PRUNE_MIN_TURNS_KEPT,
	maxResultTokens: DEFAULT_PRUNE_MAX_RESULT_TOKENS,
	expectedFutureTurns: DEFAULT_PRUNE_EXPECTED_FUTURE_TURNS,
	prewarmAfterPrune: false,
};

export interface PruneExecutorSpanRecord {
	startTurnIndex: number;
	endTurnIndex: number;
	tokens: number;
	reason: string;
}

export interface PruneExecutorEvent {
	turnIndex?: number;
	spans: PruneExecutorSpanRecord[];
	tokensRemoved: number;
	tokensAfterPrunePoint: number;
	predictedOneTimeCostTokens: number;
	expectedFutureTurns: number;
	firstPrunePoint?: number;
	sourceMessageCount: number;
	prunedMessageCount: number;
	signature: string;
	prewarmScheduled: boolean;
	prewarmSkippedReason?: string;
}

export type PrunePlanner = (messages: AgentMessage[], config: ResolvedPruningConfig) => PrunePlan | undefined;
export type PruneApply = (messages: AgentMessage[], plan: PrunePlan) => AgentMessage[];
export type PrunePrewarm = () => Promise<void> | void;

export interface PruneExecutorOptions {
	config?: PruningConfig;
	session?: Pick<Session, "appendCustomEntry" | "buildContext">;
	planner?: PrunePlanner;
	apply?: PruneApply;
	prewarm?: PrunePrewarm;
}

export interface EvaluatePruneOptions {
	turnIndex?: number;
	sourceMessages?: AgentMessage[];
}

export interface PruneQueueUpdate {
	followUp?: AgentMessage[];
	nextTurn?: AgentMessage[];
	steer?: AgentMessage[];
}

export interface PruneEventSource {
	subscribe(listener: (event: AgentHarnessEvent | PruneQueueUpdateEvent, signal?: AbortSignal) => Promise<void> | void): () => void;
}

interface PruneQueueUpdateEvent extends PruneQueueUpdate {
	type: "queue_update";
}

export class PruneExecutor {
	private readonly config: ResolvedPruningConfig;
	private readonly session?: Pick<Session, "appendCustomEntry" | "buildContext">;
	private readonly planner: PrunePlanner;
	private readonly apply: PruneApply;
	private readonly prewarm?: PrunePrewarm;
	private activePlan?: PrunePlan;
	private activeSignature?: string;
	private lastEvent?: PruneExecutorEvent;
	private rewrittenPrefix?: AgentMessage[];
	private sourceFingerprints: string[] = [];
	private sourceMessageCount = 0;
	private queuedUserTurn = false;

	constructor(options: PruneExecutorOptions = {}) {
		this.config = resolvePruningConfig(options.config);
		this.session = options.session;
		this.planner = options.planner ?? planContextPrune;
		this.apply = options.apply ?? applyPrunePlan;
		this.prewarm = options.prewarm;
	}

	rewriteContext(messages: AgentMessage[]): AgentMessage[] {
		if (!this.rewrittenPrefix || messages.length < this.sourceMessageCount) return messages;
		if (!this.matchesSourcePrefix(messages)) {
			this.clearRewrite();
			return messages;
		}
		return [...this.rewrittenPrefix, ...messages.slice(this.sourceMessageCount)];
	}

	async evaluate(messages: AgentMessage[], options: EvaluatePruneOptions = {}): Promise<PruneExecutorEvent | undefined> {
		if (!this.config.enabled) return undefined;
		const sourceMessages = options.sourceMessages ?? messages;
		const effectiveMessages = options.sourceMessages ? messages : this.rewriteContext(messages);
		const plan = this.planner(effectiveMessages, this.config);
		if (!plan?.shouldPrune) return undefined;
		const signature = plan.signature ?? signatureForPlan(plan);
		if (signature === this.activeSignature) return undefined;

		this.activePlan = plan;
		this.activeSignature = signature;
		this.sourceFingerprints = sourceMessages.map((message) => fingerprintMessage(message));
		this.sourceMessageCount = sourceMessages.length;
		this.rewrittenPrefix = this.apply(effectiveMessages, plan);

		const event = this.createEvent(plan, signature, options.turnIndex, sourceMessages.length, this.rewrittenPrefix.length);
		this.lastEvent = event;
		await this.session?.appendCustomEntry("prune", event);
		return event;
	}

	async handleTurnEnd(options: EvaluatePruneOptions = {}): Promise<boolean> {
		if (!this.session) return false;
		const context = await this.session.buildContext();
		const event = await this.evaluate(this.rewriteContext(context.messages), {
			...options,
			sourceMessages: context.messages,
		});
		if (!event) return false;
		if (this.config.prewarmAfterPrune && !this.queuedUserTurn) {
			const prewarm = this.prewarm;
			if (prewarm) void Promise.resolve(prewarm()).catch(() => undefined);
		}
		return true;
	}

	handleQueueUpdate(event: PruneQueueUpdate): void {
		this.queuedUserTurn = Boolean(event.followUp?.length || event.nextTurn?.length || event.steer?.length);
	}

	bind(harness: PruneEventSource): () => void {
		return harness.subscribe(async (event, signal) => {
			if (signal?.aborted) return;
			if (event.type === "turn_end") await this.handleTurnEnd();
			if (event.type !== "queue_update") return;
			this.handleQueueUpdate(event);
		});
	}

	getActivePlan(): PrunePlan | undefined {
		return this.activePlan;
	}

	getLastEvent(): PruneExecutorEvent | undefined {
		return this.lastEvent;
	}

	private matchesSourcePrefix(messages: readonly AgentMessage[]): boolean {
		if (messages.length < this.sourceFingerprints.length) return false;
		return this.sourceFingerprints.every((fingerprint, index) => fingerprint === fingerprintMessage(messages[index]));
	}

	private clearRewrite(): void {
		this.activePlan = undefined;
		this.activeSignature = undefined;
		this.lastEvent = undefined;
		this.rewrittenPrefix = undefined;
		this.sourceFingerprints = [];
		this.sourceMessageCount = 0;
	}

	private createEvent(
		plan: PrunePlan,
		signature: string,
		turnIndex: number | undefined,
		sourceMessageCount: number,
		prunedMessageCount: number,
	): PruneExecutorEvent {
		return {
			turnIndex,
			spans: plan.spans.map((span) => ({
				startTurnIndex: span.startTurnIndex,
				endTurnIndex: span.endTurnIndex,
				tokens: span.tokensRemoved,
				reason: eventReason(span.reason),
			})),
			tokensRemoved: plan.tokensRemoved,
			tokensAfterPrunePoint: plan.tokensAfterPrunePoint,
			predictedOneTimeCostTokens: plan.tokensAfterPrunePoint,
			expectedFutureTurns: plan.expectedFutureTurns,
			firstPrunePoint: plan.firstPrunePoint ?? undefined,
			sourceMessageCount,
			prunedMessageCount,
			signature,
			prewarmScheduled: this.config.prewarmAfterPrune && !this.getPrewarmSkippedReason(),
			prewarmSkippedReason: this.getPrewarmSkippedReason(),
		};
	}

	private getPrewarmSkippedReason(): string | undefined {
		if (!this.config.prewarmAfterPrune) return "disabled";
		if (!this.prewarm) return "unsupported";
		if (this.queuedUserTurn) return "queued_user_turn";
		return undefined;
	}
}

export function resolvePruningConfig(config: PruningConfig = {}): ResolvedPruningConfig {
	return {
		enabled: config.enabled ?? DEFAULT_PRUNING_CONFIG.enabled,
		minTurnsKept: config.minTurnsKept ?? DEFAULT_PRUNING_CONFIG.minTurnsKept,
		maxResultTokens: config.maxResultTokens ?? DEFAULT_PRUNING_CONFIG.maxResultTokens,
		expectedFutureTurns: config.expectedFutureTurns ?? DEFAULT_PRUNING_CONFIG.expectedFutureTurns,
		prewarmAfterPrune: config.prewarmAfterPrune ?? DEFAULT_PRUNING_CONFIG.prewarmAfterPrune,
	};
}

function signatureForPlan(plan: PrunePlan): string {
	return plan.spans.map((span) => `${span.action}:${span.reason}:${span.start}:${span.end}`).join("|");
}

function eventReason(reason: string): string {
	if (reason === "superseded_tool_result") return "superseded-tool-result";
	if (reason === "oversized_unreferenced_tool_result") return "oversized-tool-result";
	if (reason === "dead_end_branch_marker") return "dead-end-branch";
	return reason;
}

function fingerprintMessage(message: AgentMessage | undefined): string {
	if (!message) return "<missing>";
	return stableStringify(message);
}

function stableStringify(value: unknown): string {
	if (value === undefined) return "<undefined>";
	if (value === null || typeof value !== "object") return String(value);
	if (Array.isArray(value)) return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
	const record = value as Record<string, unknown>;
	return `{${Object.keys(record)
		.sort()
		.map((key) => `${key}:${stableStringify(record[key])}`)
		.join(",")}}`;
}
