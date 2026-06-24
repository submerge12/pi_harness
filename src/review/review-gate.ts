import type { ReviewGate, ReviewGateOptions, ReviewTarget, ReviewVerdict } from "./types.ts";

export function createReviewGate(opts: ReviewGateOptions): ReviewGate {
	const { clock, reviewer, crossChecker } = opts;

	return {
		async review(target: ReviewTarget): Promise<ReviewVerdict> {
			const blindVerdict = stampDecidedAt(await reviewer.assess(target.diff));
			if (blindVerdict.verdict !== "PASS") return blindVerdict;

			return stampDecidedAt(
				await crossChecker.crossCheck({
					diff: target.diff,
					manifest: target.manifest,
					policy: target.policy,
					blindVerdict,
				}),
			);
		},
	};

	function stampDecidedAt(verdict: ReviewVerdict): ReviewVerdict {
		if (verdict.decidedAt !== undefined) return verdict;
		return { ...verdict, decidedAt: clock.now() };
	}
}
