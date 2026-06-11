import type { Api, Model } from "@earendil-works/pi-ai";
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

function isDeepSeekModel(model: Model<Api>): boolean {
	return model.provider === "deepseek" || model.baseUrl.includes("deepseek.com");
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
	if (isDeepSeekModel(model)) {
		return {
			strategy: "automatic-prefix",
			supportsLongCacheRetention: false,
		};
	}

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
