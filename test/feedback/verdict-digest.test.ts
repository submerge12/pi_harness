import { describe, expect, it } from "vitest";
import { buildFailureDigest } from "../../src/feedback/verdict-digest.ts";
import type { ReviewVerdict } from "../../src/review/index.ts";

function verdict(overrides: Partial<ReviewVerdict> = {}): ReviewVerdict {
	return {
		verdict: "FAIL",
		reviewer: "blind-reviewer",
		phase: "blind",
		findings: [],
		decidedAt: 1,
		...overrides,
	};
}

describe("buildFailureDigest", () => {
	it("orders findings by severity and marks recurring claims across attempts", () => {
		const digest = buildFailureDigest({
			verdicts: [
				verdict({
					findings: [
						{ severity: "info", claim: "consider a comment" },
						{ severity: "blocker", claim: "acceptance test missing" },
					],
				}),
				verdict({
					findings: [
						{ severity: "blocker", claim: "Acceptance test missing" },
						{ severity: "warn", claim: "unused import" },
					],
					decidedAt: 2,
				}),
			],
		});
		const lines = digest!.split("\n");
		expect(lines[0]).toBe("[blocker] acceptance test missing (recurring x2)");
		expect(lines[1]).toBe("[warn] unused import");
		expect(lines[2]).toBe("[info] consider a comment");
	});

	it("caps rendered claims and reports the omitted count", () => {
		const findings = Array.from({ length: 9 }, (_, index) => ({
			severity: "warn" as const,
			claim: `finding number ${index}`,
		}));
		const digest = buildFailureDigest({ verdicts: [verdict({ findings })], maxClaims: 3 });
		expect(digest!.split("\n")).toHaveLength(4);
		expect(digest).toContain("(+6 lower-severity finding(s) omitted)");
	});

	it("appends completion-gate failures and falls back to the verdict value when findings are empty", () => {
		const withGate = buildFailureDigest({
			verdicts: [],
			completionGateFailures: [{ attempt: 2, reason: "no receipt covering write scope" }],
		});
		expect(withGate).toBe("[gate] attempt 2: no receipt covering write scope");

		expect(buildFailureDigest({ verdicts: [verdict()] })).toBe("reviewer FAIL");
		expect(buildFailureDigest({ verdicts: [] })).toBeUndefined();
	});
});
