import { listModelProfiles } from "../model-profiles/registry.ts";
import type { ModelProfile } from "../model-profiles/types.ts";

/**
 * Declared capability prior from a ModelProfile's strengths. Priors are hints for
 * a human-gated routing decision; there is deliberately NO auto-routing here —
 * overrides come from scorecard history of real reviewed runs (>= ~10 per cell),
 * and routing-table changes stay gated decisions.
 */
export interface ModelPrior {
	profileId: string;
	capability: string;
	source: "declared";
}

/** Profiles claiming the capability among their declared strengths (registry order; no ranking). */
export function lookupModelPriors(
	capability: string,
	profiles: readonly ModelProfile[] = listModelProfiles(),
): ModelPrior[] {
	return profiles
		.filter((profile) => profile.strengths?.includes(capability))
		.map((profile) => ({ profileId: profile.id, capability, source: "declared" as const }));
}

/** Every capability any registered profile claims, deduplicated. */
export function declaredCapabilities(profiles: readonly ModelProfile[] = listModelProfiles()): string[] {
	const capabilities = new Set<string>();
	for (const profile of profiles) {
		for (const strength of profile.strengths ?? []) capabilities.add(strength);
	}
	return [...capabilities];
}
