import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { CacheStrategyDecision } from "../src/cache/types.ts";
import { BudgetTracker } from "../src/observability/budget.ts";
import { CacheReportTracker } from "../src/observability/cache-report.ts";
import { EventLog, createSessionEventLogPath } from "../src/observability/event-log.ts";
import { redact } from "../src/observability/redact.ts";
import type { HarnessEvent, TurnCost, UsageSnapshot } from "../src/observability/types.ts";
import { clearKnownSecretsForTesting, registerKnownSecret } from "../src/redaction/core.ts";

function usage(totalUsd: number, cacheRead: number, input = 100): UsageSnapshot {
	return {
		input,
		output: 20,
		cacheRead,
		cacheWrite: 0,
		totalTokens: input + cacheRead + 20,
		cost: {
			input: totalUsd / 2,
			output: totalUsd / 2,
			cacheRead: 0,
			cacheWrite: 0,
			total: totalUsd,
		},
	};
}

function turn(turnIndex: number, cacheRead: number, input = 100): TurnCost {
	const usageSnapshot = usage(0.01, cacheRead, input);
	return {
		turnIndex,
		usage: usageSnapshot,
		cacheHitRate: cacheRead / (input + cacheRead),
		toolResultCount: 0,
	};
}

function turnEndEvent(totalUsd: number): HarnessEvent {
	return {
		type: "turn_end",
		message: {
			role: "assistant",
			usage: usage(totalUsd, 0),
		},
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

describe("observability hardening", () => {
	afterEach(() => {
		clearKnownSecretsForTesting();
	});

	test("redact_masks_secret_keys_and_bearer_tokens", () => {
		const redacted = redact({
			apiKey: "sk-live",
			nested: {
				Authorization: "Bearer abc.def.ghi",
				message: "call with Bearer raw-token-value now",
			},
			plain: "visible",
		});

		expect(redacted).toEqual({
			apiKey: "[REDACTED]",
			nested: {
				Authorization: "[REDACTED]",
				message: "call with Bearer [REDACTED] now",
			},
			plain: "visible",
		});
	});

	test("redact_masks_cookie_session_and_credential_keys", () => {
		expect(
			redact({
				Cookie: "session=raw",
				"set-cookie": "token=raw",
				credential: "raw",
				session: "raw",
			}),
		).toEqual({
			Cookie: "[REDACTED]",
			"set-cookie": "[REDACTED]",
			credential: "[REDACTED]",
			session: "[REDACTED]",
		});
	});

	test("redact_masks_registered_secret_values_inside_object_keys", () => {
		registerKnownSecret("sk-test-object-value");

		const redacted = redact({
			"sk-test-object-value": "visible",
			nested: {
				"prefix-sk-test-object-value-suffix": "also visible",
			},
		});

		expect(JSON.stringify(redacted)).not.toContain("sk-test-object-value");
		expect(redacted).toEqual({
			"[REDACTED]": "visible",
			nested: {
				"prefix-[REDACTED]-suffix": "also visible",
			},
		});
	});

	test("budget_tracker_warns_then_refuses_new_turns_past_cap", () => {
		const tracker = new BudgetTracker({ warnAtUsd: 0.02, maxUsdPerSession: 0.03 });

		expect(tracker.checkBeforeTurn()).toEqual({
			allowed: true,
			status: "ok",
			spentUsd: 0,
		});

		tracker.handleEvent(turnEndEvent(0.025));
		expect(tracker.checkBeforeTurn()).toEqual({
			allowed: true,
			status: "warn",
			spentUsd: 0.025,
			message: "session spend $0.025000 is at or above warning budget $0.020000",
		});

		tracker.handleEvent(turnEndEvent(0.01));
		expect(tracker.checkBeforeTurn()).toEqual({
			allowed: false,
			status: "refuse",
			spentUsd: 0.035,
			message: "session spend $0.035000 reached hard budget $0.030000",
		});
	});

	test("cache_report_warns_when_actual_hit_rate_drops_sharply", () => {
		const report = new CacheReportTracker({ sharpDropThreshold: 0.3 });
		report.recordDecision(decision("session-affinity"), 1);
		report.recordTurn(turn(1, 300));
		report.recordDecision(decision("session-affinity"), 2);
		report.recordTurn(turn(2, 20));

		const entries = report.getEntries();

		expect(entries).toHaveLength(2);
		expect(entries[0]?.expectedStrategy).toBe("session-affinity");
		expect(entries[1]?.warning).toBe(
			"cache hit rate dropped from 75.0% to 16.7%; prompt prefix may have changed",
		);
	});

	test("cache_report_records_decisions_by_value", () => {
		const report = new CacheReportTracker();
		const cacheDecision = decision("session-affinity");
		report.recordDecision(cacheDecision, 1);
		cacheDecision.profile.strategy = "no-cache";
		report.recordTurn(turn(1, 100));

		expect(report.getEntries()[0]?.expectedStrategy).toBe("session-affinity");
	});

	test("event_log_path_rejects_session_id_traversal", () => {
		expect(() => createSessionEventLogPath("/sessions", "../outside")).toThrow("Invalid session id");
		expect(() => createSessionEventLogPath("/sessions", "..\\outside")).toThrow("Invalid session id");
		expect(() => createSessionEventLogPath("/sessions", "C:\\outside")).toThrow("Invalid session id");
		expect(createSessionEventLogPath("/sessions", "session-1")).toBe("/sessions/session-1.events.jsonl");
	});

	test("event_log_writes_well_formed_jsonl_without_secrets", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-harness-observability-"));
		const filePath = createSessionEventLogPath(root, "session-1");
		const log = new EventLog({ filePath, now: () => new Date("2026-06-10T00:00:00.000Z") });

		await log.handleEvent({
			type: "tool_execution_start",
			toolCallId: "call-1",
			toolName: "fetch",
			args: {
				headers: {
					Authorization: "Bearer secret-token",
				},
			},
		});

		const content = await readFile(filePath, "utf8");
		const lines = content.trim().split("\n");
		const lastLine = lines.at(-1);

		expect(lastLine).toBeDefined();
		expect(lastLine).not.toContain("secret-token");
		expect(JSON.parse(lastLine ?? "") as unknown).toEqual({
			timestamp: "2026-06-10T00:00:00.000Z",
			event: {
				type: "tool_execution_start",
				toolCallId: "call-1",
				toolName: "fetch",
				args: {
					headers: {
						Authorization: "[REDACTED]",
					},
				},
			},
		});
	});

	test("event_log_redacts_key_value_assignments_inside_tool_result_text", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-harness-observability-"));
		const filePath = createSessionEventLogPath(root, "session-1");
		const log = new EventLog({ filePath, now: () => new Date("2026-06-10T00:00:00.000Z") });

		await log.handleEvent({
			type: "tool_execution_end",
			toolCallId: "call-1",
			toolName: "bash",
			result: {
				content: [
					{
						type: "text",
						text: "before\nDEEPSEEK_API_KEY=sk-test-event-log-secret\nafter",
					},
				],
			},
		});

		const content = await readFile(filePath, "utf8");
		const lastLine = content.trim().split("\n").at(-1) ?? "";

		expect(lastLine).toContain("DEEPSEEK_API_KEY=[REDACTED]");
		expect(lastLine).not.toContain("sk-test-event-log-secret");
	});

	test("event_log_redacts_registered_bare_secret_values", async () => {
		registerKnownSecret("sk-test-known-event-secret");
		const root = await mkdtemp(join(tmpdir(), "pi-harness-observability-"));
		const filePath = createSessionEventLogPath(root, "session-1");
		const log = new EventLog({ filePath, now: () => new Date("2026-06-10T00:00:00.000Z") });

		await log.handleEvent({
			type: "tool_execution_end",
			toolCallId: "call-1",
			toolName: "bash",
			result: {
				content: [{ type: "text", text: "raw output sk-test-known-event-secret done" }],
			},
		});

		const content = await readFile(filePath, "utf8");
		const lastLine = content.trim().split("\n").at(-1) ?? "";

		expect(lastLine).toContain("raw output [REDACTED] done");
		expect(lastLine).not.toContain("sk-test-known-event-secret");
	});
});
