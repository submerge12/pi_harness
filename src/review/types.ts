import type { ReviewVerdict, Verdict } from "./verdict.ts";

export type { ReviewVerdict, Verdict };

export interface Clock {
	now(): number;
}

export interface ReviewTarget {
	diff: string;
	manifest: unknown;
	policy: unknown;
}

export interface ReviewCrossCheckInput {
	diff: string;
	manifest: unknown;
	policy: unknown;
	blindVerdict: ReviewVerdict;
	/** Filesystem capability for `file-exists` criteria; absent → such criteria are unverifiable. */
	fileExists?: (path: string) => boolean;
}

export interface BlindReviewer {
	assess(diff: string): Promise<ReviewVerdict>;
}

export interface CrossChecker {
	crossCheck(input: ReviewCrossCheckInput): Promise<ReviewVerdict>;
}

export interface ReviewGate {
	review(target: ReviewTarget): Promise<ReviewVerdict>;
}

export interface ReviewGateOptions {
	clock: Clock;
	reviewer: BlindReviewer;
	crossChecker: CrossChecker;
}
