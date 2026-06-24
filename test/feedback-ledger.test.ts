import { describe, expect, it } from "vitest";
import type { TaskContract } from "../src/contract/index.ts";
import type { EvidenceManifestEntry } from "../src/evidence/index.ts";
import { createReceiptLedger } from "../src/feedback/index.ts";

const taskContract: TaskContract = {
	id: "task-1",
	goal: "Write src/result.txt",
	rawRequest: "write result",
	hardConstraints: [],
	assignedSkill: "coding",
	writeScope: ["src"],
	gateTier: "G2",
};

function receipt(overrides: Partial<EvidenceManifestEntry> = {}): EvidenceManifestEntry {
	return {
		id: "receipt-1",
		command: "write src/result.txt",
		subject: "src/result.txt",
		allowed: { level: "allow", ruleId: "write-scope" },
		writeScope: ["src"],
		actualWritePaths: ["src/result.txt"],
		exitCode: 0,
		stdoutRef: ".evidence-local/run/receipt-1.stdout",
		stderrRef: ".evidence-local/run/receipt-1.stderr",
		bytes: { stdout: 1, stderr: 0, total: 1 },
		binary: false,
		truncated: false,
		sha256: "sha",
		stderrSha256: "stderr-sha",
		redactions: 0,
		capturedAt: "2026-06-24T00:00:00.000Z",
		...overrides,
	};
}

describe("receipt ledger", () => {
	it("rejects done claims without successful write-scope receipts", () => {
		const ledger = createReceiptLedger();
		ledger.recordAttempt(1, [receipt({ exitCode: 1 })]);

		expect(ledger.checkCompletion({ taskContract, attempt: 1, doneClaim: true })).toMatchObject({
			ok: false,
			failure: { attempt: 1, reason: "done claim has no successful receipt covering the write scope" },
			acceptedReceipts: [],
		});
		expect(ledger.attempts()[0]?.receipts).toHaveLength(1);
	});

	it("accepts only allow plus zero-exit receipts covering the write scope", () => {
		const ledger = createReceiptLedger();
		const accepted = receipt();
		ledger.recordAttempt(2, [
			receipt({ id: "denied", allowed: { level: "deny" } }),
			receipt({ id: "outside", actualWritePaths: ["docs/result.txt"] }),
			accepted,
		]);

		expect(ledger.checkCompletion({ taskContract, attempt: 2, doneClaim: true })).toEqual({
			ok: true,
			acceptedReceipts: [accepted],
		});
	});
});
