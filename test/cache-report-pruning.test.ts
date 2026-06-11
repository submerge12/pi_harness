import type { CacheStrategyDecision } from "../src/cache/types.ts";
import { CacheReportTracker, type CachePruneEventRecord } from "../src/observability/cache-report.ts";
import type { TurnCost, UsageSnapshot } from "../src/observability/types.ts";
import { describe, expect, test } from "vitest";

function usage(cacheRead: number, input = 100): UsageSnapshot {
	return {
		input,
		output: 20,
		cacheRead,
		cacheWrite: 0,
		totalTokens: input + cacheRead + 20,
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: 0,
		},
	};
}

function turn(turnIndex: number, cacheHitRate: number): TurnCost {
	const cacheRead = Math.round(cacheHitRate * 100);
	return {
		turnIndex,
		usage: usage(cacheRead),
		cacheHitRate,
		toolResultCount: 0,
	};
}

function decision(strategy: CacheStrategyDecision["profile"]["strategy"]): CacheStrategyDecision {
	return {
		profile: {
			strategy,
			supportsLongCacheRetention: true,
		},
		streamOptions: {
			cacheRetention: "short",
		},
	};
}

function pruneEvent(turnIndex: number): CachePruneEventRecord {
	return {
		turnIndex,
		spans: [
			{
				startTurnIndex: 2,
				endTurnIndex: 4,
				tokens: 1200,
				reason: "superseded read",
			},
		],
		tokensRemoved: 1200,
		tokensAfterPrunePoint: 3400,
		predictedOneTimeCostUsd: 0.0068,
	};
}

describe("cache report pruning telemetry", () => {
	test("cache_report_annotates_turns_with_prune_events_and_predicted_cost", () => {
		const report = new CacheReportTracker();
		const event = pruneEvent(5);

		report.recordPruneEvent(event);
		event.spans[0].tokens = 99;
		report.recordDecision(decision("automatic-prefix"), 5);
		report.recordTurn(turn(5, 0.12));

		const entries = report.getEntries();

		expect(entries[0]?.pruneEvents).toEqual([pruneEvent(5)]);
		expect(report.render()).toContain(
			"prune: 1 span, 1200 tokens removed, 3400 one-time tokens, predicted cost $0.006800",
		);
	});

	test("cache_report_warns_when_post_prune_hit_rate_stays_low_past_two_turns", () => {
		const report = new CacheReportTracker({
			pruneRecoveryHitRateThreshold: 0.5,
			pruneRecoveryTurnLimit: 2,
		});

		report.recordPruneEvent(pruneEvent(10));
		for (const turnIndex of [10, 11, 12, 13]) {
			report.recordDecision(decision("automatic-prefix"), turnIndex);
		}
		report.recordTurn(turn(10, 0.1));
		report.recordTurn(turn(11, 0.2));
		report.recordTurn(turn(12, 0.3));
		report.recordTurn(turn(13, 0.25));

		const entries = report.getEntries();

		expect(entries[0]?.warning).toBeUndefined();
		expect(entries[1]?.warning).toBeUndefined();
		expect(entries[2]?.warning).toBeUndefined();
		expect(entries[3]?.warning).toBe(
			"cache hit rate stayed below 50.0% for 3 turns after prune at turn 10; rewrite may be unstable",
		);
	});
});
