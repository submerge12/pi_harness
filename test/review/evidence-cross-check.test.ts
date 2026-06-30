import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { TaskContract } from "../../src/contract/index.ts";
import { createEvidenceGateway, createEvidenceReceiptCollector } from "../../src/evidence/index.ts";
import { createReceiptLedger } from "../../src/feedback/index.ts";
import { crossCheckEvidence } from "../../src/review/evidence-cross-check.ts";
import type { ReviewVerdict } from "../../src/review/index.ts";

const passBlind: ReviewVerdict = {
	verdict: "PASS",
	reviewer: "blind-reviewer",
	phase: "blind",
	findings: [],
	decidedAt: 123,
};

describe("crossCheckEvidence", () => {
	it("returns a cross-check PASS when successful receipts support contains criteria", async () => {
		const entry = await receiptWithOutput("ok");

		const verdict = crossCheckEvidence({
			diff: "diff mentions nothing useful",
			manifest: [entry],
			policy: { acceptanceCriteria: ["src/result.txt contains ok"] },
			blindVerdict: passBlind,
		});

		expect(verdict).toEqual({
			...passBlind,
			phase: "cross-check",
		});
	});

	it("keeps captured output available after collector and ledger cloning", async () => {
		const collector = createEvidenceReceiptCollector();
		const ledger = createReceiptLedger();
		const entry = await receiptWithOutput("ok");
		collector.markAttemptStart(1);
		collector.record(entry);
		ledger.recordAttempt(1, collector.receiptsForAttempt(1));
		const completion = ledger.checkCompletion({
			taskContract,
			attempt: 1,
			doneClaim: true,
		});

		const verdict = crossCheckEvidence({
			diff: "diff mentions nothing useful",
			manifest: completion.acceptedReceipts,
			policy: { acceptanceCriteria: ["src/result.txt contains ok"] },
			blindVerdict: passBlind,
		});

		expect(completion.ok).toBe(true);
		expect(verdict).toEqual({
			...passBlind,
			phase: "cross-check",
		});
	});

	it("does not let the diff satisfy evidence-only contains criteria", async () => {
		const entry = await receiptWithOutput("mismatch");

		const verdict = crossCheckEvidence({
			diff: "diff happens to contain ok",
			manifest: [entry],
			policy: { acceptanceCriteria: ["src/result.txt contains ok"] },
			blindVerdict: passBlind,
		});

		expect(verdict).toEqual({
			verdict: "FAIL",
			reviewer: "blind-reviewer",
			phase: "cross-check",
			findings: [{
				severity: "blocker",
				claim: "Reviewer PASS lacks evidence for acceptance criterion: src/result.txt contains ok",
			}],
			decidedAt: 123,
		});
	});

	it("does not let manifest metadata satisfy evidence-only contains criteria", async () => {
		const entry = await receiptWithOutput("mismatch", { command: "write-ok src/result.txt" });

		const verdict = crossCheckEvidence({
			diff: "diff mentions nothing useful",
			manifest: [entry],
			policy: { acceptanceCriteria: ["src/result.txt contains ok"] },
			blindVerdict: passBlind,
		});

		expect(verdict).toEqual({
			verdict: "FAIL",
			reviewer: "blind-reviewer",
			phase: "cross-check",
			findings: [{
				severity: "blocker",
				claim: "Reviewer PASS lacks evidence for acceptance criterion: src/result.txt contains ok",
			}],
			decidedAt: 123,
		});
	});

	it("fails PASS verdicts that lack successful evidence receipts", () => {
		const verdict = crossCheckEvidence({
			diff: "claimed change",
			manifest: [],
			policy: { acceptanceCriteria: ["evidence must exist"] },
			blindVerdict: passBlind,
		});

		expect(verdict).toEqual({
			verdict: "FAIL",
			reviewer: "blind-reviewer",
			phase: "cross-check",
			findings: [{
				severity: "blocker",
				claim: "Reviewer PASS lacks evidence manifest receipts.",
			}],
			decidedAt: 123,
		});
	});
});

async function receiptWithOutput(stdout: string, options: { command?: string } = {}) {
	const rootDir = await mkdtemp(join(tmpdir(), "pi-review-cross-check-"));
	const gateway = createEvidenceGateway({
		rootDir,
		runId: "run-review",
		now: () => new Date("2026-06-24T00:00:00.000Z"),
		env: {
			exec: async () => ({ ok: true, value: { stdout, stderr: "", exitCode: 0 } }),
		},
	});
	return await gateway.captureOutput({
		id: "receipt-1",
		command: options.command ?? "write src/result.txt",
		subject: "src/result.txt",
		allowed: { level: "allow" },
		writeScope: ["src"],
		actualWritePaths: ["src/result.txt"],
		stdout,
	});
}

const taskContract: TaskContract = {
	id: "task-1",
	goal: "Write src/result.txt",
	rawRequest: "write result",
	hardConstraints: [],
	assignedSkill: "coding",
	writeScope: ["src"],
	gateTier: "G2",
};
