import { deepSeekV4ProProfile } from "./deepseek-v4-pro.ts";
import type { ModelProfile } from "./types.ts";

const profiles = new Map<string, ModelProfile>();

export class ModelProfileResolutionError extends Error {
	profileId: string;

	constructor(profileId: string) {
		super(`Unknown model profile ${profileId}`);
		this.name = "ModelProfileResolutionError";
		this.profileId = profileId;
	}
}

export function registerModelProfile(profile: ModelProfile): void {
	profiles.set(profile.id, profile);
}

export function unregisterModelProfile(id: string): boolean {
	return profiles.delete(id);
}

export function getModelProfile(id: string): ModelProfile {
	const profile = profiles.get(id);
	if (!profile) throw new ModelProfileResolutionError(id);
	return profile;
}

export function listModelProfiles(): ModelProfile[] {
	return [...profiles.values()];
}

export function findModelProfile(query: { provider: string; modelId: string }): ModelProfile | undefined {
	return listModelProfiles().find(
		(profile) => profile.provider === query.provider && profile.modelId === query.modelId,
	);
}

export interface ModelProfileMatchInput {
	provider: string;
	modelId?: string;
	baseUrl?: string;
}

/** Matches a runtime model (e.g. a pi-ai Model) back to a declared profile via exact identity or match hints. */
export function findModelProfileForModel(model: ModelProfileMatchInput): ModelProfile | undefined {
	const exact = model.modelId !== undefined
		? findModelProfile({ provider: model.provider, modelId: model.modelId })
		: undefined;
	if (exact) return exact;
	return listModelProfiles().find((profile) => {
		const hints = profile.match;
		if (!hints) return false;
		if (hints.providers?.includes(model.provider)) return true;
		if (model.baseUrl && hints.baseUrlIncludes?.some((fragment) => model.baseUrl!.includes(fragment))) return true;
		return false;
	});
}

/** Built-in profiles are seeded at module load so generic modules can consult the seam unconditionally. */
registerModelProfile(deepSeekV4ProProfile);

export const DEFAULT_MODEL_PROFILE: ModelProfile = deepSeekV4ProProfile;
