import { describe, expect, it } from "vitest";
import { createInMemoryCheckpointStore } from "../src/checkpoint/index.ts";
import { createReceiptLedger } from "../src/feedback/ledger.ts";
import { runWorkerReviewerLoop } from "../src/orchestration/coordinator.ts";
import { createInMemoryTraceSink } from "../src/trace/index.ts";
import type { TaskContract } from "../src/contract/index.ts";
import type { EvidenceManifestEntry } from "../src/evidence/index.ts";
import type { ReviewVerdict } from "../src/review/index.ts";

const writeTask: TaskContract = {
	id: "task-write-1",
	goal: "Write the requested file",
	rawRequest: "write loop result",
	hardConstraints: [{ kind: "acceptance", value: "loop-result.txt contains ok" }],
	assignedSkill: "coding",
	writeScope: ["tmp/worker-loop"],
	allowedTools: ["read", "write"],
	gateTier: "G2",
};

function manifestEntry(overrides: Partial<EvidenceManifestEntry> = {}): EvidenceManifestEntry {
	return {
		id: "receipt-1",
		command: "write tmp/worker-loop/loop-result.txt",
		subject: "tmp/worker-loop/loop-result.txt",
		allowed: { level: "allow", ruleId: "write-scope" },
		writeScope: ["tmp/worker-loop"],
		actualWritePaths: ["tmp/worker-loop/loop-result.txt"],
		exitCode: 0,
		stdoutRef: ".evidence-local/run/receipt-1.stdout",
		stderrRef: ".evidence-local/run/receipt-1.stderr",
		bytes: { stdout: 2, stderr: 0, total: 2 },
		binary: false,
		truncated: false,
		sha256: "sha256",
		stderrSha256: "stderr-sha256",
		redactions: 0,
		capturedAt: "2026-06-24T00:00:00.000Z",
		...overrides,
	};
}

function verdict(verdictValue: ReviewVerdict["verdict"], reviewer = "blind-reviewer"): ReviewVerdict {
	return {
		verdict: verdictValue,
		reviewer,
		phase: "cross-check",
		findings: [],
		decidedAt: 1,
	};
}

describe("worker reviewer loop", () => {
	it("retries a failing write task up to the bound, rewinds between attempts, then needs a human", async () => {
		const trace = createInMemoryTraceSink({ runId: "run-failing", now: () => 1 });
		const checkpoint = createInMemoryCheckpointStore({
			rootDir: "/repo",
			files: new Map([["tmp/worker-loop/loop-result.txt", "before"]]),
		});
		const ledger = createReceiptLedger();
		const reviewVerdicts = [verdict("FAIL"), verdict("FAIL"), verdict("FAIL")];

		const result = await runWorkerReviewerLoop({
			taskContract: writeTask,
			trace,
			checkpoint,
			ledger,
			maxAttempts: 3,
			budget: { checkBeforeTurn: () => ({ allowed: true, status: "ok", spentUsd: 0 }) },
			worker: async ({ attempt }) => ({
				doneClaim: true,
				diff: `attempt ${attempt} wrote bad`,
				receipts: [manifestEntry({ id: `receipt-${attempt}`, stdoutRef: `.evidence-local/run/${attempt}.stdout` })],
			}),
			reviewer: async () => reviewVerdicts.shift() ?? verdict("FAIL"),
		});

		expect(result.state).toBe("NEEDS_HUMAN");
		expect(result.attempts).toBe(3);
		expect(checkpoint.readFile("tmp/worker-loop/loop-result.txt")).toBe("before");
		expect(trace.events().map((event) => event.type)).toEqual([
			"transition",
			"worker-attempt",
			"transition",
			"review-verdict",
			"transition",
			"rewind",
			"transition",
			"worker-attempt",
			"transition",
			"review-verdict",
			"transition",
			"rewind",
			"transition",
			"worker-attempt",
			"transition",
			"review-verdict",
			"transition",
		]);
	});

	it("reaches DONE only after a reviewer PASS", async () => {
		const trace = createInMemoryTraceSink({ runId: "run-pass", now: () => 1 });

		const result = await runWorkerReviewerLoop({
			taskContract: writeTask,
			trace,
			checkpoint: createInMemoryCheckpointStore({ rootDir: "/repo" }),
			ledger: createReceiptLedger(),
			maxAttempts: 3,
			budget: { checkBeforeTurn: () => ({ allowed: true, status: "ok", spentUsd: 0 }) },
			worker: async () => ({
				doneClaim: true,
				diff: "wrote ok",
				receipts: [manifestEntry()],
			}),
			reviewer: async ({ input }) => {
				expect(input.workerTranscript).toBeUndefined();
				expect(input.diff).toBe("wrote ok");
				expect(input.acceptanceCriteria).toContain("loop-result.txt contains ok");
				return verdict("PASS");
			},
		});

		expect(result.state).toBe("DONE");
		expect(result.reviewVerdicts.map((entry) => entry.verdict)).toEqual(["PASS"]);
		expect(trace.events().filter((event) => event.type === "review-verdict")).toHaveLength(1);
	});

	it("rewinds bash-like mutations that do not report actual write paths", async () => {
		const trace = createInMemoryTraceSink({ runId: "run-baseline-mutation", now: () => 1 });
		const checkpoint = createInMemoryCheckpointStore({
			rootDir: "/repo",
			files: new Map([["tmp/worker-loop/loop-result.txt", "before"]]),
		});
		const reviewVerdicts = [verdict("FAIL"), verdict("PASS")];
		const seenAtAttemptStart: string[] = [];

		const result = await runWorkerReviewerLoop({
			taskContract: writeTask,
			trace,
			checkpoint,
			ledger: createReceiptLedger(),
			maxAttempts: 2,
			budget: { checkBeforeTurn: () => ({ allowed: true, status: "ok", spentUsd: 0 }) },
			worker: async ({ attempt }) => {
				seenAtAttemptStart.push(checkpoint.readFile("tmp/worker-loop/loop-result.txt") ?? "<missing>");
				if (attempt === 1) checkpoint.writeFile("tmp/worker-loop/loop-result.txt", "dirty from bash");
				return {
					doneClaim: true,
					diff: `attempt ${attempt}`,
					receipts: [manifestEntry({
						id: `receipt-${attempt}`,
						actualWritePaths: [],
						stdoutRef: `.evidence-local/run/${attempt}.stdout`,
					})],
				};
			},
			reviewer: async () => reviewVerdicts.shift() ?? verdict("PASS"),
		});

		expect(result.state).toBe("DONE");
		expect(seenAtAttemptStart).toEqual(["before", "before"]);
	});

	it("removes files created by a failed attempt even when receipts report no write paths", async () => {
		const trace = createInMemoryTraceSink({ runId: "run-baseline-created", now: () => 1 });
		const checkpoint = createInMemoryCheckpointStore({
			rootDir: "/repo",
			files: new Map([["tmp/worker-loop/loop-result.txt", "before"]]),
		});
		const reviewVerdicts = [verdict("FAIL"), verdict("PASS")];
		const createdFileAtAttemptStart: Array<string | undefined> = [];

		const result = await runWorkerReviewerLoop({
			taskContract: writeTask,
			trace,
			checkpoint,
			ledger: createReceiptLedger(),
			maxAttempts: 2,
			budget: { checkBeforeTurn: () => ({ allowed: true, status: "ok", spentUsd: 0 }) },
			worker: async ({ attempt }) => {
				createdFileAtAttemptStart.push(checkpoint.readFile("tmp/worker-loop/new.txt"));
				if (attempt === 1) checkpoint.writeFile("tmp/worker-loop/new.txt", "created by bash");
				return {
					doneClaim: true,
					diff: `attempt ${attempt}`,
					receipts: [manifestEntry({
						id: `receipt-${attempt}`,
						actualWritePaths: [],
						stdoutRef: `.evidence-local/run/${attempt}.stdout`,
					})],
				};
			},
			reviewer: async () => reviewVerdicts.shift() ?? verdict("PASS"),
		});

		expect(result.state).toBe("DONE");
		expect(createdFileAtAttemptStart).toEqual([undefined, undefined]);
		expect(checkpoint.readFile("tmp/worker-loop/new.txt")).toBeUndefined();
	});

	it("restores the pre-attempt baseline when a model failure terminates the loop", async () => {
		const trace = createInMemoryTraceSink({ runId: "run-model-failure-rewind", now: () => 1 });
		const checkpoint = createInMemoryCheckpointStore({
			rootDir: "/repo",
			files: new Map([["tmp/worker-loop/loop-result.txt", "before"]]),
		});

		const result = await runWorkerReviewerLoop({
			taskContract: writeTask,
			trace,
			checkpoint,
			ledger: createReceiptLedger(),
			maxAttempts: 3,
			budget: { checkBeforeTurn: () => ({ allowed: true, status: "ok", spentUsd: 0 }) },
			worker: async () => {
				checkpoint.writeFile("tmp/worker-loop/loop-result.txt", "dirty before model failure");
				checkpoint.writeFile("tmp/worker-loop/new.txt", "created before model failure");
				return {
					doneClaim: false,
					diff: "model refused mid-attempt",
					diffOrigin: "self-report" as const,
					receipts: [manifestEntry({ actualWritePaths: [] })],
					modelFailure: { kind: "refusal" as const, pattern: "cannot help" },
				};
			},
			reviewer: async () => verdict("PASS"),
		});

		expect(result.state).toBe("FAILED");
		expect(result.modelFailure).toEqual({ kind: "refusal", pattern: "cannot help" });
		expect(checkpoint.readFile("tmp/worker-loop/loop-result.txt")).toBe("before");
		expect(checkpoint.readFile("tmp/worker-loop/new.txt")).toBeUndefined();
		expect(trace.events().some((event) => event.type === "rewind")).toBe(true);
	});

	it("passes diff origin to reviewers and stamps it onto verdicts and trace", async () => {
		const trace = createInMemoryTraceSink({ runId: "run-diff-origin", now: () => 1 });

		const result = await runWorkerReviewerLoop({
			taskContract: writeTask,
			trace,
			checkpoint: createInMemoryCheckpointStore({ rootDir: "/repo" }),
			ledger: createReceiptLedger(),
			maxAttempts: 1,
			budget: { checkBeforeTurn: () => ({ allowed: true, status: "ok", spentUsd: 0 }) },
			worker: async () => ({
				doneClaim: true,
				diff: "diff --git a/tmp/worker-loop/loop-result.txt b/tmp/worker-loop/loop-result.txt",
				diffOrigin: "git",
				receipts: [manifestEntry()],
			}),
			reviewer: async ({ input }) => {
				expect(input.diffOrigin).toBe("git");
				return verdict("PASS");
			},
		});

		const reviewEvent = trace.events().find((event) => event.type === "review-verdict");
		const workerEvent = trace.events().find((event) => event.type === "worker-attempt");

		expect(result.state).toBe("DONE");
		expect(result.reviewVerdicts[0]?.diffOrigin).toBe("git");
		expect(workerEvent?.data).toMatchObject({ diffOrigin: "git" });
		expect(reviewEvent?.data).toMatchObject({ verdict: expect.objectContaining({ diffOrigin: "git" }) });
	});

	it("rejects a worker done claim when evidence lacks a successful receipt", async () => {
		const trace = createInMemoryTraceSink({ runId: "run-false-pass", now: () => 1 });
		let reviewerCalls = 0;

		const result = await runWorkerReviewerLoop({
			taskContract: writeTask,
			trace,
			checkpoint: createInMemoryCheckpointStore({ rootDir: "/repo" }),
			ledger: createReceiptLedger(),
			maxAttempts: 1,
			budget: { checkBeforeTurn: () => ({ allowed: true, status: "ok", spentUsd: 0 }) },
			worker: async () => ({
				doneClaim: true,
				diff: "claimed ok without receipt",
				receipts: [manifestEntry({ id: "failed-receipt", exitCode: 1 })],
			}),
			reviewer: async () => {
				reviewerCalls += 1;
				return verdict("PASS");
			},
		});

		expect(result.state).toBe("NEEDS_HUMAN");
		expect(result.completionGateFailures).toHaveLength(1);
		expect(reviewerCalls).toBe(0);
		expect(trace.events().some((event) => event.type === "review-verdict")).toBe(false);
	});

	it("does not treat conversational give-up as a done claim", async () => {
		const trace = createInMemoryTraceSink({ runId: "run-give-up", now: () => 1 });
		let reviewerCalls = 0;

		const result = await runWorkerReviewerLoop({
			taskContract: writeTask,
			trace,
			checkpoint: createInMemoryCheckpointStore({ rootDir: "/repo" }),
			ledger: createReceiptLedger(),
			maxAttempts: 1,
			budget: { checkBeforeTurn: () => ({ allowed: true, status: "ok", spentUsd: 0 }) },
			worker: async () => ({
				doneClaim: false,
				diff: "I couldn't finish this.",
				receipts: [manifestEntry()],
			}),
			reviewer: async () => {
				reviewerCalls += 1;
				return verdict("PASS");
			},
		});

		expect(result.state).toBe("NEEDS_HUMAN");
		expect(result.completionGateFailures).toEqual([
			{ attempt: 1, reason: "worker did not claim completion" },
		]);
		expect(reviewerCalls).toBe(0);
	});

	it("bypasses the reviewer loop for read-only tasks", async () => {
		const trace = createInMemoryTraceSink({ runId: "run-read-only", now: () => 1 });
		const readOnlyTask: TaskContract = {
			...writeTask,
			id: "task-read-only",
			writeScope: [],
			allowedTools: ["read", "grep"],
		};

		const result = await runWorkerReviewerLoop({
			taskContract: readOnlyTask,
			trace,
			checkpoint: createInMemoryCheckpointStore({ rootDir: "/repo" }),
			ledger: createReceiptLedger(),
			maxAttempts: 3,
			budget: { checkBeforeTurn: () => ({ allowed: true, status: "ok", spentUsd: 0 }) },
			worker: async () => ({ doneClaim: true, diff: "read only", receipts: [] }),
			reviewer: async () => {
				throw new Error("read-only task should not invoke reviewer");
			},
		});

		expect(result.state).toBe("DONE");
		expect(result.reviewVerdicts).toEqual([]);
		expect(trace.events().map((event) => event.type)).toEqual(["transition", "worker-attempt", "transition"]);
	});
});
