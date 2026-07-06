import { describe, expect, it } from "vitest";
import { createInMemoryCheckpointStore } from "../../src/checkpoint/index.ts";
import type { TaskContract } from "../../src/contract/index.ts";
import type { EvidenceManifestEntry } from "../../src/evidence/index.ts";
import { createReceiptLedger } from "../../src/feedback/index.ts";
import { BudgetTracker } from "../../src/observability/budget.ts";
import { runWorkerReviewerLoop } from "../../src/orchestration/index.ts";
import type { ReviewVerdict } from "../../src/review/index.ts";
import { createInMemoryTraceSink } from "../../src/trace/index.ts";

const taskContract: TaskContract = {
	id: "task-human-gate",
	goal: "Write gated output",
	rawRequest: "write gated output",
	hardConstraints: [{ kind: "acceptance", value: "output contains ok", source: "test" }],
	assignedSkill: "coding",
	writeScope: ["src"],
	allowedTools: ["write"],
	gateTier: "G3",
};

function receipt(overrides: Partial<EvidenceManifestEntry> = {}): EvidenceManifestEntry {
	return {
		id: "receipt-1",
		command: "write src/out.txt",
		subject: "src/out.txt",
		allowed: { level: "allow", ruleId: "write-scope" },
		writeScope: ["src"],
		actualWritePaths: ["src/out.txt"],
		exitCode: 0,
		stdoutRef: ".evidence-local/run/receipt-1.stdout",
		stderrRef: ".evidence-local/run/receipt-1.stderr",
		bytes: { stdout: 2, stderr: 0, total: 2 },
		binary: false,
		truncated: false,
		sha256: "sha",
		stderrSha256: "stderr-sha",
		redactions: 0,
		capturedAt: "2026-06-24T00:00:00.000Z",
		...overrides,
	};
}

function verdict(value: ReviewVerdict["verdict"]): ReviewVerdict {
	return {
		verdict: value,
		reviewer: "blind-reviewer",
		phase: "cross-check",
		findings: value === "PASS" ? [] : [{ severity: "blocker", claim: "needs human" }],
		decidedAt: 1,
	};
}

describe("human gate", () => {
	it("does not continue a NEEDS_HUMAN verdict without a recorded decision", async () => {
		const requests: unknown[] = [];
		const result = await runWorkerReviewerLoop({
			taskContract,
			trace: createInMemoryTraceSink({ runId: "human-gate-pause", now: () => 1 }),
			checkpoint: createInMemoryCheckpointStore({ rootDir: "/repo" }),
			ledger: createReceiptLedger(),
			maxAttempts: 2,
			worker: async () => ({ doneClaim: true, diff: "needs review", receipts: [receipt()] }),
			reviewer: async () => verdict("NEEDS_HUMAN"),
			humanGate: {
				requestDecision: async (request) => {
					requests.push(request);
					return undefined;
				},
			},
		});

		expect(result.state).toBe("NEEDS_HUMAN");
		expect(result.attempts).toBe(1);
		expect(requests).toHaveLength(1);
	});

	it("resumes the coordinator when a human records a resume decision", async () => {
		let attempt = 0;
		const result = await runWorkerReviewerLoop({
			taskContract,
			trace: createInMemoryTraceSink({ runId: "human-gate-resume", now: () => 1 }),
			checkpoint: createInMemoryCheckpointStore({ rootDir: "/repo" }),
			ledger: createReceiptLedger(),
			maxAttempts: 3,
			worker: async () => {
				attempt += 1;
				return { doneClaim: true, diff: `attempt ${attempt}`, receipts: [receipt({ id: `receipt-${attempt}` })] };
			},
			reviewer: async () => attempt === 1 ? verdict("NEEDS_HUMAN") : verdict("PASS"),
			humanGate: {
				requestDecision: async (request) => ({
					id: `${request.id}-decision`,
					action: "resume",
					reviewer: "human",
					decidedAt: 2,
					reason: "approved another attempt",
				}),
			},
		});

		expect(result.state).toBe("DONE");
		expect(result.attempts).toBe(2);
		expect(result.humanDecisions.map((decision) => decision.action)).toEqual(["resume"]);
	});

	it("ignores persisted id-less resume decisions", async () => {
		let attempt = 0;
		let reviewCalls = 0;
		let requestDecisionCalls = 0;
		const result = await runWorkerReviewerLoop({
			taskContract,
			trace: createInMemoryTraceSink({ runId: "human-gate-idless-persisted", now: () => 1 }),
			checkpoint: createInMemoryCheckpointStore({ rootDir: "/repo" }),
			ledger: createReceiptLedger(),
			maxAttempts: 3,
			worker: async () => {
				attempt += 1;
				return { doneClaim: true, diff: `attempt ${attempt}`, receipts: [receipt({ id: `receipt-${attempt}` })] };
			},
			reviewer: async () => {
				reviewCalls += 1;
				return attempt === 1 ? verdict("NEEDS_HUMAN") : verdict("PASS");
			},
			humanGate: {
				persistence: {
					savePendingHumanGate: async () => undefined,
					loadPendingHumanGate: async () => undefined,
					saveHumanDecision: async () => undefined,
					loadHumanDecisions: async () => [
						{ id: "legacy", action: "resume", reviewer: "human", decidedAt: 2 },
					] as any,
				},
				requestDecision: async () => {
					requestDecisionCalls += 1;
					return undefined;
				},
			},
		});

		expect(result.state).toBe("NEEDS_HUMAN");
		expect(result.attempts).toBe(1);
		expect(reviewCalls).toBe(1);
		expect(requestDecisionCalls).toBe(1);
		expect(result.humanDecisions).toEqual([]);
	});

	it("replays exact persisted resume decisions idempotently", async () => {
		let attempt = 0;
		let requestDecisionCalls = 0;
		const result = await runWorkerReviewerLoop({
			taskContract,
			trace: createInMemoryTraceSink({ runId: "human-gate-exact-persisted", now: () => 1 }),
			checkpoint: createInMemoryCheckpointStore({ rootDir: "/repo" }),
			ledger: createReceiptLedger(),
			maxAttempts: 3,
			worker: async () => {
				attempt += 1;
				return { doneClaim: true, diff: `attempt ${attempt}`, receipts: [receipt({ id: `receipt-${attempt}` })] };
			},
			reviewer: async () => attempt === 1 ? verdict("NEEDS_HUMAN") : verdict("PASS"),
			humanGate: {
				persistence: {
					savePendingHumanGate: async () => undefined,
					loadPendingHumanGate: async () => undefined,
					saveHumanDecision: async () => undefined,
					loadHumanDecisions: async () => [{
						id: "decision-1",
						action: "resume",
						reviewer: "human",
						decidedAt: 2,
						requestId: "task-human-gate-attempt-1-human-gate",
					}],
				},
				requestDecision: async () => {
					requestDecisionCalls += 1;
					return undefined;
				},
			},
		});

		expect(result.state).toBe("DONE");
		expect(result.attempts).toBe(2);
		expect(requestDecisionCalls).toBe(0);
		expect(result.humanDecisions.map((decision) => decision.id)).toEqual(["decision-1"]);
	});

	it("uses RunPolicy gate tiers to require a human before a protected run starts", async () => {
		let workerCalls = 0;
		const result = await runWorkerReviewerLoop({
			taskContract,
			trace: createInMemoryTraceSink({ runId: "human-gate-pre-run", now: () => 1 }),
			checkpoint: createInMemoryCheckpointStore({ rootDir: "/repo" }),
			ledger: createReceiptLedger(),
			maxAttempts: 1,
			runPolicy: { gateTiers: { G3: "human" } },
			worker: async () => {
				workerCalls += 1;
				return { doneClaim: true, diff: "unused", receipts: [receipt()] };
			},
			reviewer: async () => verdict("PASS"),
			humanGate: {
				requestDecision: async () => undefined,
			},
		});

		expect(result.state).toBe("NEEDS_HUMAN");
		expect(result.attempts).toBe(0);
		expect(workerCalls).toBe(0);
		expect(result.humanGateRequests).toHaveLength(1);
	});

	it("uses legal transitions when budget refuses before the first attempt", async () => {
		const trace = createInMemoryTraceSink({ runId: "budget-refusal", now: () => 1 });
		const result = await runWorkerReviewerLoop({
			taskContract: { ...taskContract, gateTier: "G2" },
			trace,
			checkpoint: createInMemoryCheckpointStore({ rootDir: "/repo" }),
			ledger: createReceiptLedger(),
			maxAttempts: 1,
			budget: { checkBeforeTurn: () => ({ allowed: false, status: "refuse", spentUsd: 1 }) },
			worker: async () => {
				throw new Error("budget refusal should not run worker");
			},
			reviewer: async () => verdict("PASS"),
		});

		expect(result.state).toBe("NEEDS_HUMAN");
		expect(result.attempts).toBe(0);
		expect(trace.events().filter((event) => event.type === "transition").map((event) => event.data)).toEqual([
			{ from: "CREATED", to: "PLANNED" },
			{ from: "PLANNED", to: "GATED" },
			{ from: "GATED", to: "NEEDS_HUMAN" },
		]);
	});

	it("pauses through the coordinator when cumulative BudgetTracker spend exceeds RunPolicy maxUsd", async () => {
		const budget = new BudgetTracker({ maxUsdPerSession: 0.01 });
		let workerCalls = 0;
		const result = await runWorkerReviewerLoop({
			taskContract: { ...taskContract, gateTier: "G2" },
			trace: createInMemoryTraceSink({ runId: "budget-cumulative-refusal", now: () => 1 }),
			checkpoint: createInMemoryCheckpointStore({ rootDir: "/repo" }),
			ledger: createReceiptLedger(),
			maxAttempts: 2,
			budget,
			runPolicy: { budget: { maxUsd: 0.01 } },
			worker: async () => {
				workerCalls += 1;
				budget.recordSpend(0.02);
				return { doneClaim: true, diff: "needs another attempt", receipts: [receipt()] };
			},
			reviewer: async () => verdict("FAIL"),
		});

		expect(result.state).toBe("NEEDS_HUMAN");
		expect(result.attempts).toBe(1);
		expect(workerCalls).toBe(1);
	});

	it("allows the loop to complete while BudgetTracker spend remains under RunPolicy maxUsd", async () => {
		const budget = new BudgetTracker({ maxUsdPerSession: 1 });
		const result = await runWorkerReviewerLoop({
			taskContract: { ...taskContract, gateTier: "G2" },
			trace: createInMemoryTraceSink({ runId: "budget-under-limit", now: () => 1 }),
			checkpoint: createInMemoryCheckpointStore({ rootDir: "/repo" }),
			ledger: createReceiptLedger(),
			maxAttempts: 1,
			budget,
			runPolicy: { budget: { maxUsd: 1 } },
			worker: async () => {
				budget.recordSpend(0.02);
				return { doneClaim: true, diff: "ok", receipts: [receipt()] };
			},
			reviewer: async () => verdict("PASS"),
		});

		expect(result.state).toBe("DONE");
		expect(result.attempts).toBe(1);
	});

	it("enforces RunPolicy maxRewinds", async () => {
		const result = await runWorkerReviewerLoop({
			taskContract: { ...taskContract, gateTier: "G2" },
			trace: createInMemoryTraceSink({ runId: "max-rewinds", now: () => 1 }),
			checkpoint: createInMemoryCheckpointStore({ rootDir: "/repo" }),
			ledger: createReceiptLedger(),
			maxAttempts: 3,
			runPolicy: { repairLimits: { maxRewinds: 0 } },
			worker: async () => ({ doneClaim: true, diff: "bad", receipts: [receipt()] }),
			reviewer: async () => verdict("FAIL"),
		});

		expect(result.state).toBe("NEEDS_HUMAN");
		expect(result.attempts).toBe(1);
		expect(result.rewinds).toBe(0);
	});
});
