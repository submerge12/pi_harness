import type { ReviewFinding, ReviewFindingSeverity } from "../review/verdict.ts";
import type { ReviewVerdict } from "../review/index.ts";
import type { CompletionGateFailure } from "./ledger.ts";

export interface FailureDigestInput {
	verdicts: readonly ReviewVerdict[];
	completionGateFailures?: readonly CompletionGateFailure[];
	/** Cap on rendered findings after prioritization; excess is summarized as a count. */
	maxClaims?: number;
}

const DEFAULT_MAX_CLAIMS = 6;

const severityRank: Record<ReviewFindingSeverity, number> = {
	blocker: 0,
	warn: 1,
	info: 2,
};

/**
 * Turns review verdicts into the digest injected into the next worker attempt:
 * blockers first, duplicates collapsed (a claim repeated across attempts is a
 * recurring failure and marked as such), bounded so it cannot crowd out the task.
 */
export function buildFailureDigest(input: FailureDigestInput): string | undefined {
	const maxClaims = input.maxClaims ?? DEFAULT_MAX_CLAIMS;
	const deduped = dedupeFindings(input.verdicts.flatMap((verdict) => verdict.findings));
	const gateFailures = input.completionGateFailures ?? [];
	if (deduped.length === 0 && gateFailures.length === 0) {
		const last = input.verdicts.at(-1);
		return last ? `reviewer ${last.verdict}` : undefined;
	}

	const shown = deduped.slice(0, maxClaims);
	const hidden = deduped.length - shown.length;
	const lines = [
		...shown.map(({ finding, occurrences }) =>
			`[${finding.severity}] ${finding.claim}${occurrences > 1 ? ` (recurring x${occurrences})` : ""}`,
		),
		...(hidden > 0 ? [`(+${hidden} lower-severity finding(s) omitted)`] : []),
		...gateFailures.map((failure) => `[gate] attempt ${failure.attempt}: ${failure.reason}`),
	];
	return lines.join("\n");
}

interface DedupedFinding {
	finding: ReviewFinding;
	occurrences: number;
}

function dedupeFindings(findings: readonly ReviewFinding[]): DedupedFinding[] {
	const byClaim = new Map<string, DedupedFinding>();
	for (const finding of findings) {
		const key = normalizeClaim(finding.claim);
		const existing = byClaim.get(key);
		if (!existing) {
			byClaim.set(key, { finding, occurrences: 1 });
			continue;
		}
		existing.occurrences += 1;
		// Keep the most severe phrasing of a repeated claim.
		if (severityRank[finding.severity] < severityRank[existing.finding.severity]) {
			existing.finding = finding;
		}
	}
	return [...byClaim.values()].sort(
		(left, right) =>
			severityRank[left.finding.severity] - severityRank[right.finding.severity] ||
			right.occurrences - left.occurrences,
	);
}

function normalizeClaim(claim: string): string {
	return claim.trim().toLowerCase().replace(/\s+/g, " ");
}
