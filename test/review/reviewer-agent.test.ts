import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createEvidenceGateway, type EvidenceManifestEntry } from "../../src/evidence/index.ts";
import { createSpawnedReviewerAgent } from "../../src/review/index.ts";

function receipt(): EvidenceManifestEntry {
	return {
		id: "receipt-1",
		command: "write src/result.txt",
		subject: "src/result.txt",
		allowed: { level: "allow" },
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
	};
}

describe("spawned reviewer agent", () => {
	it("spawns with a blind read-only contract and excludes worker transcript", async () => {
		const calls: unknown[] = [];
		const reviewer = createSpawnedReviewerAgent({
			now: () => 123,
			spawnAgent: async (input) => {
				calls.push(input);
				expect(JSON.stringify(input)).not.toContain("private worker transcript");
				return {
					text: JSON.stringify({
						verdict: "PASS",
						reviewer: "reviewer",
						phase: "cross-check",
						findings: [],
					}),
				};
			},
		});

		const result = await reviewer.review({
			diff: "diff only",
			evidenceManifest: [receipt()],
			acceptanceCriteria: ["evidence must exist"],
			policy: { gateTier: "G2" },
		});

		expect(result).toEqual({
			verdict: "PASS",
			reviewer: "reviewer",
			phase: "cross-check",
			findings: [],
			decidedAt: 123,
		});
		expect(calls[0]).toMatchObject({
			profile: "coding",
			max_turns: 3,
			task_contract: {
				assignedSkill: "review",
				writeScope: [],
				allowedTools: ["read", "grep", "glob"],
			},
		});
		const call = calls[0] as { prompt: string };
		expect(call.prompt).toContain("Diff:");
		expect(call.prompt).toContain("Acceptance criteria:");
		expect(call.prompt).not.toContain("Evidence manifest:");
		expect(call.prompt).not.toContain("receipt-1");
	});

	it("cross-checks spawned PASS verdicts against evidence", async () => {
		const reviewer = createSpawnedReviewerAgent({
			now: () => 456,
			spawnAgent: async () => ({
				text: JSON.stringify({
					verdict: "PASS",
					reviewer: "reviewer",
					phase: "blind",
					findings: [],
				}),
			}),
		});

		const result = await reviewer.review({
			diff: "claimed change",
			evidenceManifest: [],
			acceptanceCriteria: ["evidence must exist"],
			policy: {},
		});

		expect(result).toEqual({
			verdict: "FAIL",
			reviewer: "reviewer",
			phase: "cross-check",
			findings: [{
				severity: "blocker",
				claim: "Reviewer PASS lacks evidence manifest receipts.",
			}],
			decidedAt: 456,
		});
	});

	it("normalizes spawned blind reviewer phase before returning terminal non-PASS verdicts", async () => {
		const reviewer = createSpawnedReviewerAgent({
			now: () => 654,
			spawnAgent: async () => ({
				text: JSON.stringify({
					verdict: "FAIL",
					reviewer: "reviewer",
					phase: "cross-check",
					findings: [{ severity: "blocker", claim: "diff misses acceptance criteria" }],
				}),
			}),
		});

		const result = await reviewer.review({
			diff: "changed the file",
			evidenceManifest: [receipt()],
			acceptanceCriteria: ["evidence must exist"],
			policy: {},
		});

		expect(result).toEqual({
			verdict: "FAIL",
			reviewer: "reviewer",
			phase: "blind",
			findings: [{ severity: "blocker", claim: "diff misses acceptance criteria" }],
			decidedAt: 654,
		});
	});

	it("fails spawned PASS verdicts when evidence does not support contains criteria", async () => {
		const reviewer = createSpawnedReviewerAgent({
			now: () => 789,
			spawnAgent: async () => ({
				text: JSON.stringify({
					verdict: "PASS",
					reviewer: "reviewer",
					phase: "blind",
					findings: [],
				}),
			}),
		});

		const result = await reviewer.review({
			diff: "changed the file but wrote ok in the diff only",
			evidenceManifest: [receipt()],
			acceptanceCriteria: ["src/result.txt contains ok"],
			policy: {},
		});

		expect(result).toEqual({
			verdict: "FAIL",
			reviewer: "reviewer",
			phase: "cross-check",
			findings: [{
				severity: "blocker",
				claim: "Reviewer PASS lacks evidence for acceptance criterion: src/result.txt contains ok",
			}],
			decidedAt: 789,
		});
	});

	it("returns a cross-check PASS when evidence supports a spawned blind PASS", async () => {
		const reviewer = createSpawnedReviewerAgent({
			now: () => 321,
			spawnAgent: async () => ({
				text: JSON.stringify({
					verdict: "PASS",
					reviewer: "reviewer",
					phase: "blind",
					findings: [],
				}),
			}),
		});

		const result = await reviewer.review({
			diff: "changed the file",
			evidenceManifest: [await receiptWithOutput("ok")],
			acceptanceCriteria: ["src/result.txt contains ok"],
			policy: {},
		});

		expect(result).toEqual({
			verdict: "PASS",
			reviewer: "reviewer",
			phase: "cross-check",
			findings: [],
			decidedAt: 321,
		});
	});
});

async function receiptWithOutput(stdout: string): Promise<EvidenceManifestEntry> {
	const rootDir = await mkdtemp(join(tmpdir(), "pi-reviewer-agent-"));
	const gateway = createEvidenceGateway({
		rootDir,
		runId: "reviewer-agent-test",
		now: () => new Date("2026-06-24T00:00:00.000Z"),
		env: {
			exec: async () => ({ ok: true, value: { stdout, stderr: "", exitCode: 0 } }),
		},
	});
	return await gateway.captureOutput({
		id: "receipt-output",
		command: "write src/result.txt",
		subject: "src/result.txt",
		allowed: { level: "allow" },
		stdout,
	});
}
