import { describe, expect, it } from "vitest";
import type { EvidenceManifestEntry } from "../../src/evidence/index.ts";
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
			diff: "diff only ok",
			evidenceManifest: [receipt()],
			acceptanceCriteria: ["src/result.txt contains ok"],
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
			diff: "changed the file but wrote bad",
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
});
