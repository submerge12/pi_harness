import type { Api, Model } from "@earendil-works/pi-ai";
import { findModelProfileForModel } from "../model-profiles/registry.ts";
import type { ProviderCacheProfile } from "./types.ts";

function hasAnthropicCacheControlFormat(model: Model<Api>): boolean {
	const compat = model.compat;
	return !!compat && "cacheControlFormat" in compat && compat.cacheControlFormat === "anthropic";
}

function supportsLongCacheRetention(model: Model<Api>, defaultValue: boolean): boolean {
	const compat = model.compat;
	if (compat && "supportsLongCacheRetention" in compat && compat.supportsLongCacheRetention !== undefined) {
		return compat.supportsLongCacheRetention;
	}
	return defaultValue;
}

function isAnthropicBreakpointModel(model: Model<Api>): boolean {
	return model.api === "anthropic-messages" || hasAnthropicCacheControlFormat(model);
}

function isOpenAISessionAffinityModel(model: Model<Api>): boolean {
	if (model.provider !== "openai" && model.provider !== "openai-codex") {
		return false;
	}
	return (
		model.api === "openai-responses" ||
		model.api === "openai-codex-responses" ||
		model.api === "openai-completions"
	);
}

export function getProviderCacheProfile(model: Model<Api>): ProviderCacheProfile {
	// Model-specific cache behavior is declared on the ModelProfile seam; the
	// remaining branches below are API-shape heuristics, not model knowledge.
	const declaredProfile = findModelProfileForModel({
		provider: model.provider,
		modelId: model.id,
		baseUrl: model.baseUrl,
	});
	if (declaredProfile?.cache) return { ...declaredProfile.cache };

	if (isAnthropicBreakpointModel(model)) {
		return {
			strategy: "explicit-breakpoints",
			supportsLongCacheRetention: supportsLongCacheRetention(model, true),
		};
	}

	if (isOpenAISessionAffinityModel(model)) {
		return {
			strategy: "session-affinity",
			supportsLongCacheRetention: supportsLongCacheRetention(model, true),
		};
	}

	return {
		strategy: "no-cache",
		supportsLongCacheRetention: false,
	};
}
