import { getEvidenceCapturedOutput, type EvidenceManifestEntry } from "../evidence/index.ts";
import { parseAcceptanceCriterion, type AcceptanceCriterion } from "./acceptance-criteria.ts";
import type { ReviewCrossCheckInput, ReviewVerdict } from "./types.ts";

export function crossCheckEvidence(input: ReviewCrossCheckInput): ReviewVerdict {
	const { blindVerdict } = input;
	if (blindVerdict.verdict !== "PASS") return blindVerdict;

	const entries = manifestEntries(input.manifest);
	if (entries.length === 0) {
		return failCrossCheck(blindVerdict, "Reviewer PASS lacks evidence manifest receipts.");
	}

	const failedReceipt = entries.find((entry) => entry.allowed.level !== "allow" || entry.exitCode !== 0);
	if (failedReceipt) {
		return failCrossCheck(blindVerdict, `Reviewer PASS includes unsuccessful receipt ${failedReceipt.id}.`);
	}

	const results = acceptanceCriteria(input.policy)
		.map(parseAcceptanceCriterion)
		.map((criterion) => ({ criterion, supported: checkCriterion(criterion, entries, input) }));

	// Hard violations of checkable criteria FAIL (auto-repair path) and take precedence
	// over unverifiable criteria demoting to NEEDS_HUMAN — a prose criterion must not
	// mask missing evidence.
	const violated = results.find((result) => result.supported === false);
	if (violated) {
		return failCrossCheck(blindVerdict, `Reviewer PASS lacks evidence for acceptance criterion: ${violated.criterion.raw}`);
	}

	const unverified = results.find((result) => result.supported === undefined);
	if (unverified) {
		return humanCrossCheck(blindVerdict, `Reviewer PASS has unverified acceptance criterion: ${unverified.criterion.raw}`);
	}

	return { ...blindVerdict, phase: "cross-check" };
}

/** true = evidenced, false = checkable but unsupported, undefined = not machine-checkable here. */
function checkCriterion(
	criterion: AcceptanceCriterion,
	entries: readonly EvidenceManifestEntry[],
	input: Pick<ReviewCrossCheckInput, "fileExists">,
): boolean | undefined {
	switch (criterion.kind) {
		case "free-text":
			return undefined;
		case "exit-zero":
			// The receipts above are already verified allow+exit-0; assert independently anyway.
			return entries.length > 0 && entries.every((entry) => entry.exitCode === 0);
		case "contains":
			return outputCorpus(entries).includes(criterion.text.toLowerCase());
		case "file-exists":
			// Without an injected filesystem capability the criterion cannot be verified.
			return input.fileExists ? input.fileExists(criterion.path) : undefined;
		case "test-command":
			return entries.some(
				(entry) =>
					entry.allowed.level === "allow" &&
					entry.exitCode === 0 &&
					normalizeCommand(entry.command) === normalizeCommand(criterion.command),
			);
	}
}

function normalizeCommand(command: string): string {
	return command.trim().replace(/\s+/g, " ");
}

function outputCorpus(entries: readonly EvidenceManifestEntry[]): string {
	return entries
		.flatMap((entry) => {
			const output = getEvidenceCapturedOutput(entry);
			return output ? [output.stdout, output.stderr] : [];
		})
		.join("\n")
		.toLowerCase();
}

function failCrossCheck(blindVerdict: ReviewVerdict, claim: string): ReviewVerdict {
	return {
		verdict: "FAIL",
		reviewer: blindVerdict.reviewer,
		phase: "cross-check",
		findings: [{ severity: "blocker", claim }],
		...(blindVerdict.diffOrigin ? { diffOrigin: blindVerdict.diffOrigin } : {}),
		decidedAt: blindVerdict.decidedAt,
	};
}

function humanCrossCheck(blindVerdict: ReviewVerdict, claim: string): ReviewVerdict {
	return {
		verdict: "NEEDS_HUMAN",
		reviewer: blindVerdict.reviewer,
		phase: "cross-check",
		findings: [{ severity: "warn", claim }],
		...(blindVerdict.diffOrigin ? { diffOrigin: blindVerdict.diffOrigin } : {}),
		decidedAt: blindVerdict.decidedAt,
	};
}

function acceptanceCriteria(policy: unknown): readonly string[] {
	if (!policy || typeof policy !== "object") return [];
	const value = (policy as Record<string, unknown>).acceptanceCriteria;
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function manifestEntries(manifest: unknown): EvidenceManifestEntry[] {
	if (!Array.isArray(manifest)) return [];
	return manifest.filter(isEvidenceManifestEntry);
}

function isEvidenceManifestEntry(value: unknown): value is EvidenceManifestEntry {
	if (!value || typeof value !== "object") return false;
	const record = value as Record<string, unknown>;
	const allowed = record.allowed;
	return (
		typeof record.id === "string" &&
		typeof record.exitCode === "number" &&
		!!allowed &&
		typeof allowed === "object" &&
		typeof (allowed as Record<string, unknown>).level === "string"
	);
}
