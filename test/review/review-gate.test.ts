import { describe, expect, it } from "vitest";
import { createReviewGate } from "../../src/review/review-gate.ts";
import { isReviewVerdict } from "../../src/review/verdict.ts";
import type { ReviewTarget, ReviewVerdict } from "../../src/review/types.ts";

const target: ReviewTarget = {
	diff: "diff --git a/src/index.ts b/src/index.ts",
	manifest: [{ id: "evidence-1", sha256: "abc123" }],
	policy: { defaults: { write: "ask" } },
};

const passBlind: ReviewVerdict = {
	verdict: "PASS",
	reviewer: "blind-reviewer",
	phase: "blind",
	findings: [],
	decidedAt: 100,
};

describe("createReviewGate", () => {
	it("short-circuits when the blind reviewer returns a non-PASS verdict", async () => {
		let crossCheckCalls = 0;
		const blindVerdict: ReviewVerdict = {
			verdict: "NEEDS_HUMAN",
			reviewer: "blind-reviewer",
			phase: "blind",
			findings: [{ severity: "warn", claim: "Diff is ambiguous" }],
			decidedAt: 100,
		};
		const gate = createReviewGate({
			clock: { now: () => 123 },
			reviewer: {
				assess: async (diff) => {
					expect(diff).toBe(target.diff);
					return blindVerdict;
				},
			},
			crossChecker: {
				crossCheck: async () => {
					crossCheckCalls += 1;
					return {
						verdict: "PASS",
						reviewer: "cross-checker",
						phase: "cross-check",
						findings: [],
						decidedAt: 123,
					};
				},
			},
		});

		await expect(gate.review(target)).resolves.toBe(blindVerdict);
		expect(crossCheckCalls).toBe(0);
	});

	it("runs the cross-checker after a PASS blind review", async () => {
		const crossVerdict: ReviewVerdict = {
			verdict: "FAIL",
			reviewer: "cross-checker",
			phase: "cross-check",
			findings: [{ severity: "blocker", claim: "Manifest missing expected command", evidenceRef: "manifest:0" }],
			decidedAt: 200,
		};
		const gate = createReviewGate({
			clock: { now: () => 200 },
			reviewer: { assess: async () => passBlind },
			crossChecker: {
				crossCheck: async (input) => {
					expect(input).toEqual({
						diff: target.diff,
						manifest: target.manifest,
						policy: target.policy,
						blindVerdict: passBlind,
					});
					return crossVerdict;
				},
			},
		});

		await expect(gate.review(target)).resolves.toBe(crossVerdict);
	});

	it("stamps missing decidedAt on a terminal blind reviewer verdict from the injected clock", async () => {
		const blindVerdict = {
			verdict: "NEEDS_HUMAN",
			reviewer: "blind-reviewer",
			phase: "blind",
			findings: [{ severity: "warn", claim: "Diff is ambiguous" }],
		} as unknown as ReviewVerdict;
		const gate = createReviewGate({
			clock: { now: () => 123 },
			reviewer: { assess: async () => blindVerdict },
			crossChecker: {
				crossCheck: async () => {
					throw new Error("cross-checker should not run");
				},
			},
		});

		await expect(gate.review(target)).resolves.toEqual({ ...blindVerdict, decidedAt: 123 });
	});

	it("stamps missing decidedAt on PASS blind and cross-checker verdicts from the injected clock", async () => {
		const blindVerdict = {
			verdict: "PASS",
			reviewer: "blind-reviewer",
			phase: "blind",
			findings: [],
		} as unknown as ReviewVerdict;
		const crossVerdict = {
			verdict: "PASS",
			reviewer: "cross-checker",
			phase: "cross-check",
			findings: [],
		} as unknown as ReviewVerdict;
		const gate = createReviewGate({
			clock: { now: () => 456 },
			reviewer: { assess: async () => blindVerdict },
			crossChecker: {
				crossCheck: async (input) => {
					expect(input.blindVerdict).toEqual({ ...blindVerdict, decidedAt: 456 });
					return crossVerdict;
				},
			},
		});

		await expect(gate.review(target)).resolves.toEqual({ ...crossVerdict, decidedAt: 456 });
	});
});

describe("review verdict validation", () => {
	it("accepts the expected verdict shape", () => {
		expect(
			isReviewVerdict({
				verdict: "PASS",
				reviewer: "cross-checker",
				phase: "cross-check",
				findings: [{ severity: "info", claim: "Evidence matched", evidenceRef: "manifest:0" }],
				rerun: { ran: true, matched: false },
				decidedAt: 300,
			}),
		).toBe(true);
	});

	it("rejects invalid verdict enum values", () => {
		expect(
			isReviewVerdict({
				verdict: "MAYBE",
				reviewer: "cross-checker",
				phase: "cross-check",
				findings: [],
				decidedAt: 300,
			}),
		).toBe(false);
	});

	it("preserves rerun metadata and evidence references through the gate", async () => {
		const crossVerdict: ReviewVerdict = {
			verdict: "PASS",
			reviewer: "cross-checker",
			phase: "cross-check",
			findings: [{ severity: "info", claim: "Rerun matched captured output", evidenceRef: "stdout:cmd-1" }],
			rerun: { ran: true, matched: true },
			decidedAt: 400,
		};
		const gate = createReviewGate({
			clock: { now: () => 400 },
			reviewer: { assess: async () => passBlind },
			crossChecker: { crossCheck: async () => crossVerdict },
		});

		await expect(gate.review(target)).resolves.toEqual(crossVerdict);
	});
});
