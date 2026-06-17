import { dataAnalysisProfile } from "./data-analysis/profile.ts";
import { codingProfile } from "./coding/profile.ts";
import { researchProfile } from "./research/profile.ts";
import { compassHealthProfile } from "./compass-health/profile.ts";
// <agent-profile-imports>
import { hasProfile, registerProfile } from "../registry.ts";

const builtInProfiles = [
	codingProfile,
	researchProfile,
	dataAnalysisProfile,
	compassHealthProfile,
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
export { compassHealthProfile, createCompassHealthToolRegistrations } from "./compass-health/profile.ts";
// <agent-profile-exports>
