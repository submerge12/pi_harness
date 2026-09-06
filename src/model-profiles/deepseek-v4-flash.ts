import { deepSeekV4ProProfile } from "./deepseek-v4-pro.ts";
import type { ModelProfile } from "./types.ts";

export const DEEPSEEK_V4_FLASH_PROFILE_ID = "deepseek-v4-flash@2026-06";

/**
 * Cheaper sibling of V4 Pro: same API, dialect and failure signatures; only identity,
 * cost and strengths differ. Cost figures mirror pi-ai's registry entry for
 * deepseek/deepseek-v4-flash. Intended for bulk/mechanical runs where Pro is overkill.
 */
export const deepSeekV4FlashProfile: ModelProfile = {
	...deepSeekV4ProProfile,
	id: DEEPSEEK_V4_FLASH_PROFILE_ID,
	modelId: "deepseek-v4-flash",
	cost: {
		inputPerMTok: 0.14,
		outputPerMTok: 0.28,
		cacheReadPerMTok: 0.0028,
	},
	strengths: ["zh-summarization", "structured-extraction", "tool-use"],
};
