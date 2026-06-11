import type { AgentProfile } from "./profile.ts";

export interface RegisteredAgentProfile {
	name: string;
	description: string;
}

const profiles = new Map<string, AgentProfile>();

export function registerProfile(profile: AgentProfile): void {
	if (profiles.has(profile.name)) throw new Error(`Duplicate agent profile: ${profile.name}`);
	profiles.set(profile.name, profile);
}

export function getProfile(name: string): AgentProfile {
	const profile = profiles.get(name);
	if (!profile) throw new Error(`Unknown agent profile: ${name}`);
	return profile;
}

export function hasProfile(name: string): boolean {
	return profiles.has(name);
}

export function listProfiles(): readonly RegisteredAgentProfile[] {
	return [...profiles.values()].map((profile) => ({
		name: profile.name,
		description: profile.description,
	}));
}

export function clearProfilesForTests(): void {
	profiles.clear();
}
