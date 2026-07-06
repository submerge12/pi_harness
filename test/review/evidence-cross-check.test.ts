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

	it("demotes PASS to NEEDS_HUMAN when acceptance criteria are not machine-checkable", async () => {
		const entry = await receiptWithOutput("tests ran");

		const verdict = crossCheckEvidence({
			diff: "claimed all tests pass",
			manifest: [entry],
			policy: { acceptanceCriteria: ["all tests pass"] },
			blindVerdict: passBlind,
		});

		expect(verdict).toEqual({
			verdict: "NEEDS_HUMAN",
			reviewer: "blind-reviewer",
			phase: "cross-check",
			findings: [{
				severity: "warn",
				claim: "Reviewer PASS has unverified acceptance criterion: all tests pass",
			}],
			decidedAt: 123,
		});
	});

	it("supports exit-zero criteria via successful receipts", async () => {
		const entry = await receiptWithOutput("done");

		const verdict = crossCheckEvidence({
			diff: "claimed change",
			manifest: [entry],
			policy: { acceptanceCriteria: ["exit-zero"] },
			blindVerdict: passBlind,
		});

		expect(verdict).toEqual({ ...passBlind, phase: "cross-check" });
	});

	it("supports contains-prefix criteria against captured output", async () => {
		const entry = await receiptWithOutput("all green: ok");

		const verdict = crossCheckEvidence({
			diff: "claimed change",
			manifest: [entry],
			policy: { acceptanceCriteria: ["contains all green"] },
			blindVerdict: passBlind,
		});

		expect(verdict).toEqual({ ...passBlind, phase: "cross-check" });
	});

	it("checks file-exists criteria through the injected filesystem capability", async () => {
		const entry = await receiptWithOutput("done");
		const checkedPaths: string[] = [];

		const pass = crossCheckEvidence({
			diff: "claimed change",
			manifest: [entry],
			policy: { acceptanceCriteria: ["file-exists outputs/report.md"] },
			blindVerdict: passBlind,
			fileExists: (path) => {
				checkedPaths.push(path);
				return true;
			},
		});
		const fail = crossCheckEvidence({
			diff: "claimed change",
			manifest: [entry],
			policy: { acceptanceCriteria: ["file-exists outputs/report.md"] },
			blindVerdict: passBlind,
			fileExists: () => false,
		});

		expect(pass).toEqual({ ...passBlind, phase: "cross-check" });
		expect(checkedPaths).toEqual(["outputs/report.md"]);
		expect(fail.verdict).toBe("FAIL");
		expect(fail.findings[0]?.claim).toContain("file-exists outputs/report.md");
	});

	it("demotes file-exists criteria to NEEDS_HUMAN when no filesystem capability is injected", async () => {
		const entry = await receiptWithOutput("done");

		const verdict = crossCheckEvidence({
			diff: "claimed change",
			manifest: [entry],
			policy: { acceptanceCriteria: ["file-exists outputs/report.md"] },
			blindVerdict: passBlind,
		});

		expect(verdict.verdict).toBe("NEEDS_HUMAN");
		expect(verdict.findings[0]?.claim).toContain("unverified acceptance criterion");
	});

	it("checks test-command criteria against successful receipt commands", async () => {
		const entry = await receiptWithOutput("done");

		const pass = crossCheckEvidence({
			diff: "claimed change",
			manifest: [entry],
			policy: { acceptanceCriteria: ["test-command write   src/result.txt"] },
			blindVerdict: passBlind,
		});
		const fail = crossCheckEvidence({
			diff: "claimed change",
			manifest: [entry],
			policy: { acceptanceCriteria: ["test-command npm test"] },
			blindVerdict: passBlind,
		});

		expect(pass).toEqual({ ...passBlind, phase: "cross-check" });
		expect(fail.verdict).toBe("FAIL");
		expect(fail.findings[0]?.claim).toContain("test-command npm test");
	});

	it("fails on checkable violations before demoting for unverifiable prose criteria", async () => {
		const entry = await receiptWithOutput("mismatch");

		const verdict = crossCheckEvidence({
			diff: "claimed change",
			manifest: [entry],
			// The prose criterion must not mask the hard missing-evidence violation.
			policy: { acceptanceCriteria: ["all tests pass", "src/result.txt contains ok"] },
			blindVerdict: passBlind,
		});

		expect(verdict.verdict).toBe("FAIL");
		expect(verdict.findings[0]?.claim).toContain("src/result.txt contains ok");
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
