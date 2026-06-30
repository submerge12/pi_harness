import { getEvidenceCapturedOutput, type EvidenceManifestEntry } from "../evidence/index.ts";
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

	const unsupportedCriterion = firstUnsupportedContainsCriterion(acceptanceCriteria(input.policy), entries);
	if (unsupportedCriterion) {
		return failCrossCheck(blindVerdict, `Reviewer PASS lacks evidence for acceptance criterion: ${unsupportedCriterion}`);
	}

	return { ...blindVerdict, phase: "cross-check" };
}

function failCrossCheck(blindVerdict: ReviewVerdict, claim: string): ReviewVerdict {
	return {
		verdict: "FAIL",
		reviewer: blindVerdict.reviewer,
		phase: "cross-check",
		findings: [{ severity: "blocker", claim }],
		decidedAt: blindVerdict.decidedAt,
	};
}

function firstUnsupportedContainsCriterion(
	criteria: readonly string[],
	entries: readonly EvidenceManifestEntry[],
): string | undefined {
	const corpus = entries
		.flatMap((entry) => {
			const output = getEvidenceCapturedOutput(entry);
			return output ? [output.stdout, output.stderr] : [];
		})
		.join("\n")
		.toLowerCase();

	for (const criterion of criteria) {
		const required = /\bcontains\s+([A-Za-z0-9._-]+)/i.exec(criterion)?.[1];
		if (required && !corpus.includes(required.toLowerCase())) return criterion;
	}
	return undefined;
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
