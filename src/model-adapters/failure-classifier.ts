import type { ProviderErrorClassification } from "../resilience/errors.ts";
import type { ModelFailureSignatures, ModelProfile } from "../model-profiles/types.ts";

export type ModelFailureKind = "refusal" | "loop" | "truncation";

export interface ModelFailureClassification {
	kind: ModelFailureKind;
	/** Source pattern that matched, for diagnostics. */
	pattern: string;
}

const signatureOrder: readonly ModelFailureKind[] = ["refusal", "loop", "truncation"];

/**
 * Classifies assistant output text against a profile's declared failure signatures.
 * Returns the first matching kind in specificity order (refusal > loop > truncation).
 */
export function classifyModelFailure(
	text: string,
	profile: Pick<ModelProfile, "failureSignatures">,
): ModelFailureClassification | undefined {
	for (const kind of signatureOrder) {
		const patterns = signaturePatterns(profile.failureSignatures, kind);
		for (const pattern of patterns) {
			if (pattern.test(text)) return { kind, pattern: pattern.source };
		}
	}
	return undefined;
}

/** Maps a classified model failure onto the retry policy: only truncation is worth retrying. */
export function failureRetryClassification(kind: ModelFailureKind): ProviderErrorClassification {
	return kind === "truncation" ? "transient" : "fatal";
}

function signaturePatterns(signatures: ModelFailureSignatures, kind: ModelFailureKind): readonly RegExp[] {
	if (kind === "refusal") return signatures.refusal ?? [];
	if (kind === "loop") return signatures.loop ?? [];
	return signatures.truncation ?? [];
}
