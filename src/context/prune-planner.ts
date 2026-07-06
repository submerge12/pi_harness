import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	DEFAULT_PRUNE_MAX_RESULT_TOKENS,
	DEFAULT_PRUNE_MIN_TURNS_KEPT,
	detectPruningCandidates,
	type PruneCandidate,
} from "./relevance.ts";
import { createTombstoneAnchor } from "./lifecycle.ts";
import { estimateMessageTokens } from "./token-estimator.ts";

export const DEFAULT_PRUNE_EXPECTED_FUTURE_TURNS = 3;

export interface PruningConfig {
	enabled?: boolean;
	minTurnsKept?: number;
	maxResultTokens?: number;
	expectedFutureTurns?: number;
	prewarmAfterPrune?: boolean;
}

export type PruneDecision = "prune" | "skip_disabled" | "skip_no_candidates" | "skip_not_economic";

export interface PrunePlan {
	spans: PruneCandidate[];
	firstPrunePoint: number | null;
	tokensRemoved: number;
	tokensAfterPrunePoint: number;
	expectedFutureTurns: number;
	decision: PruneDecision;
	shouldPrune: boolean;
	enabled?: boolean;
	predictedFutureSavingsTokens?: number;
	sourceMessageCount?: number;
	signature?: string;
}

export function planContextPrune(messages: AgentMessage[], config: PruningConfig = {}): PrunePlan {
	if (config.enabled === false) {
		return emptyPlan(messages, "skip_disabled", config);
	}

	const spans = detectPruningCandidates(messages, {
		minTurnsKept: config.minTurnsKept ?? DEFAULT_PRUNE_MIN_TURNS_KEPT,
		maxResultTokens: config.maxResultTokens ?? DEFAULT_PRUNE_MAX_RESULT_TOKENS,
	});
	const firstPrunePoint = spans.length === 0 ? null : Math.min(...spans.map((span) => span.start));
	const tokensRemoved = spans.reduce((total, span) => total + span.tokensRemoved, 0);
	const prunedMessages = spans.length > 0
		? applyPrunePlan(messages, {
				spans,
				firstPrunePoint,
				tokensRemoved,
				tokensAfterPrunePoint: 0,
				expectedFutureTurns: DEFAULT_PRUNE_EXPECTED_FUTURE_TURNS,
				decision: "prune",
				shouldPrune: true,
			})
		: messages;
	const tokensAfterPrunePoint = firstPrunePoint === null ? 0 : estimateMessagesTokens(prunedMessages.slice(firstPrunePoint));
	const expectedFutureTurns = Math.max(1, Math.floor(config.expectedFutureTurns ?? estimateExpectedFutureTurns(messages)));
	const predictedFutureSavingsTokens = tokensRemoved * expectedFutureTurns;
	const shouldPrune = spans.length > 0 && predictedFutureSavingsTokens > tokensAfterPrunePoint;
	const decision = spans.length === 0 ? "skip_no_candidates" : shouldPrune ? "prune" : "skip_not_economic";

	return {
		spans,
		firstPrunePoint,
		tokensRemoved,
		tokensAfterPrunePoint,
		expectedFutureTurns,
		decision,
		shouldPrune,
		enabled: config.enabled,
		predictedFutureSavingsTokens,
		sourceMessageCount: messages.length,
		signature: signatureForSpans(spans),
	};
}

export function createPrunePlan(messages: AgentMessage[], config: PruningConfig = {}): PrunePlan {
	return planContextPrune(messages, config);
}

export function applyPrunePlan(messages: AgentMessage[], plan: PrunePlan): AgentMessage[] {
	if (!plan.shouldPrune || plan.spans.length === 0) return messages;
	const sorted = [...plan.spans].sort((left, right) => left.start - right.start);
	const result: AgentMessage[] = [];
	let spanIndex = 0;

	for (let index = 0; index < messages.length; index++) {
		const span = sorted[spanIndex];
		if (span && index === span.start) {
			result.push(withTextContent(messages[index], span.replacementText ?? createSpanTombstoneText(span)));
			index = span.end;
			spanIndex++;
			continue;
		}
		result.push(messages[index]);
	}

	return result;
}

function emptyPlan(messages: AgentMessage[], decision: PruneDecision, config: PruningConfig): PrunePlan {
	const expectedFutureTurns = Math.max(1, Math.floor(config.expectedFutureTurns ?? DEFAULT_PRUNE_EXPECTED_FUTURE_TURNS));
	return {
		spans: [],
		firstPrunePoint: null,
		tokensRemoved: 0,
		tokensAfterPrunePoint: 0,
		expectedFutureTurns,
		decision,
		shouldPrune: false,
		enabled: config.enabled,
		predictedFutureSavingsTokens: 0,
		sourceMessageCount: messages.length,
		signature: "",
	};
}

function estimateMessagesTokens(messages: readonly AgentMessage[]): number {
	return messages.reduce((total, message) => total + estimateMessageTokens(message), 0);
}

function estimateExpectedFutureTurns(messages: readonly AgentMessage[]): number {
	const userTurns = messages.filter((message) => asRecord(message)?.role === "user").length;
	return Math.max(DEFAULT_PRUNE_EXPECTED_FUTURE_TURNS, Math.ceil(userTurns / 4));
}

function signatureForSpans(spans: readonly PruneCandidate[]): string {
	return spans.map((span) => `${span.action}:${span.reason}:${span.start}:${span.end}`).join("|");
}

function createSpanTombstoneText(span: PruneCandidate): string {
	return createTombstoneAnchor({
		removedSummary: `[result pruned: ${span.reason} from turns ${span.startTurnIndex}-${span.endTurnIndex}]`,
		anchorId: `context-prune:${span.reason}:${span.start}-${span.end}`,
		retrievableFrom: "session custom prune entry",
		reason: span.reason,
	}).text;
}

function withTextContent(message: AgentMessage, text: string): AgentMessage {
	const record = asRecord(message) ?? {};
	return { ...record, content: [{ type: "text", text }] } as unknown as AgentMessage;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}
