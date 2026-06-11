import { dataAnalysisProfile } from "./data-analysis/profile.ts";
import { codingProfile } from "./coding/profile.ts";
import { researchProfile } from "./research/profile.ts";
// <agent-profile-imports>
import { hasProfile, registerProfile } from "../registry.ts";

const builtInProfiles = [
	codingProfile,
	researchProfile,
	dataAnalysisProfile,
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
