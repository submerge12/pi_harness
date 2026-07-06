import { dataAnalysisProfile } from "./data-analysis/profile.ts";
import { codingProfile } from "./coding/profile.ts";
import { researchProfile } from "./research/profile.ts";
// <agent-profile-imports>
import { hasProfile, registerProfile } from "../registry.ts";
import type { AgentProfile } from "../profile.ts";

// The compass-health profile integrates the OPTIONAL, private `compass-health-agent`
// package (a file: optional dependency). Load it lazily so the harness works without
// it: when the package is absent, the profile is simply not registered.
async function loadCompassHealthModule(): Promise<
	typeof import("./compass-health/profile.ts") | undefined
> {
	try {
		return await import("./compass-health/profile.ts");
	} catch {
		return undefined;
	}
}

const compassHealthModule = await loadCompassHealthModule();

/** Undefined when the optional `compass-health-agent` package is not installed. */
export const compassHealthProfile: AgentProfile | undefined = compassHealthModule?.compassHealthProfile;
export const createCompassHealthToolRegistrations = compassHealthModule?.createCompassHealthToolRegistrations;

const builtInProfiles: AgentProfile[] = [
	codingProfile,
	researchProfile,
	dataAnalysisProfile,
	...(compassHealthProfile ? [compassHealthProfile] : []),
	// <agent-profile-list>
];

export function registerBuiltInProfiles(): void {
	for (const profile of builtInProfiles) {
		if (!hasProfile(profile.name)) registerProfile(profile);
	}
}

export { codingProfile, createCodingToolRegistrations } from "./coding/profile.ts";
export { researchProfile, createResearchToolRegistrations } from "./research/profile.ts";
export { dataAnalysisProfile, createDataAnalysisToolRegistrations } from "./data-analysis/profile.ts";
// <agent-profile-exports>
