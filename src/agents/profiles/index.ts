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

// ── WO-HS-10 / M11-M13: health primary / teacher / manager profiles ──
async function loadHealthModule(name: string): Promise<{ default: AgentProfile } | undefined> {
	try {
		return (await import(`./compass-health-${name}/profile.ts`)) as { default: AgentProfile };
	} catch {
		return undefined;
	}
}

const healthPrimaryModule = await loadHealthModule("primary");
const healthTeacherModule = await loadHealthModule("teacher");
const healthManagerModule = await loadHealthModule("manager");

export const compassHealthPrimaryProfile: AgentProfile | undefined = healthPrimaryModule?.default;
export const compassHealthTeacherProfile: AgentProfile | undefined = healthTeacherModule?.default;
export const compassHealthManagerProfile: AgentProfile | undefined = healthManagerModule?.default;

const healthProfiles: AgentProfile[] = [
	...(healthPrimaryModule ? [healthPrimaryModule.default] : []),
	...(healthTeacherModule ? [healthTeacherModule.default] : []),
	...(healthManagerModule ? [healthManagerModule.default] : []),
];

export function registerBuiltInProfiles(): void {
	for (const profile of builtInProfiles) {
		if (!hasProfile(profile.name)) registerProfile(profile);
	}
	for (const profile of healthProfiles) {
		if (!hasProfile(profile.name)) registerProfile(profile);
	}
}

export { codingProfile, createCodingToolRegistrations } from "./coding/profile.ts";
export { researchProfile, createResearchToolRegistrations } from "./research/profile.ts";
export { dataAnalysisProfile, createDataAnalysisToolRegistrations } from "./data-analysis/profile.ts";
// <agent-profile-exports>
