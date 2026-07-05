import { describe, expect, it } from "vitest";
import { getProviderCacheProfile } from "../../src/cache/profiles.ts";
import {
	DEFAULT_MODEL_ID,
	DEFAULT_PROVIDER,
	DEFAULT_THINKING_LEVEL,
} from "../../src/config.ts";
import {
	DEFAULT_MODEL_PROFILE,
	deepSeekV4ProProfile,
	findModelProfile,
	findModelProfileForModel,
	getModelProfile,
	listModelProfiles,
	ModelProfileResolutionError,
	registerModelProfile,
	unregisterModelProfile,
	type ModelProfile,
} from "../../src/model-profiles/index.ts";
import { resolveModel } from "../../src/model-resolver.ts";

describe("model profile registry", () => {
	it("seeds the built-in DeepSeek profile as the default", () => {
		expect(DEFAULT_MODEL_PROFILE).toBe(deepSeekV4ProProfile);
		expect(getModelProfile(deepSeekV4ProProfile.id)).toBe(deepSeekV4ProProfile);
		expect(listModelProfiles()).toContain(deepSeekV4ProProfile);
	});

	it("throws a typed error for unknown profile ids", () => {
		expect(() => getModelProfile("nope@never")).toThrow(ModelProfileResolutionError);
	});

	it("drives harness defaults from the default profile (no literals left in config)", () => {
		expect(DEFAULT_PROVIDER).toBe(DEFAULT_MODEL_PROFILE.provider);
		expect(DEFAULT_MODEL_ID).toBe(DEFAULT_MODEL_PROFILE.modelId);
		expect(DEFAULT_THINKING_LEVEL).toBe(DEFAULT_MODEL_PROFILE.promptDialect.thinkingLevel);
	});

	it("matches runtime models by exact identity and by match hints", () => {
		expect(findModelProfile({ provider: "deepseek", modelId: "deepseek-v4-pro" })).toBe(deepSeekV4ProProfile);
		expect(
			findModelProfileForModel({ provider: "deepseek", modelId: "deepseek-chat" }),
		).toBe(deepSeekV4ProProfile);
		expect(
			findModelProfileForModel({ provider: "openai", modelId: "x", baseUrl: "https://api.deepseek.com" }),
		).toBe(deepSeekV4ProProfile);
		expect(findModelProfileForModel({ provider: "openai", modelId: "gpt-x" })).toBeUndefined();
	});

	it("declares window and cost matching the pi-ai registry entry", () => {
		const model = resolveModel("deepseek", "deepseek-v4-pro");
		expect(deepSeekV4ProProfile.window.declared).toBe(model.contextWindow);
		expect(deepSeekV4ProProfile.window.effective).toBeLessThanOrEqual(deepSeekV4ProProfile.window.declared);
		expect(deepSeekV4ProProfile.cost.inputPerMTok).toBe(model.cost.input);
		expect(deepSeekV4ProProfile.cost.outputPerMTok).toBe(model.cost.output);
		expect(deepSeekV4ProProfile.cost.cacheReadPerMTok).toBe(model.cost.cacheRead);
	});

	it("supplies the cache strategy for matched models via the seam", () => {
		const model = resolveModel("deepseek", "deepseek-v4-pro");
		expect(getProviderCacheProfile(model)).toEqual({
			strategy: "automatic-prefix",
			supportsLongCacheRetention: false,
		});
	});

	it("lets newly registered profiles win exact-identity matches over hint matches", () => {
		const custom: ModelProfile = {
			id: "test-model@unit",
			provider: "deepseek",
			modelId: "deepseek-chat",
			api: "openai-completions",
			window: { declared: 128_000, effective: 64_000 },
			toolCalling: "prompted-json",
			promptDialect: {},
			failureSignatures: {},
			cost: { inputPerMTok: 0.1, outputPerMTok: 0.2 },
		};
		registerModelProfile(custom);
		try {
			expect(findModelProfileForModel({ provider: "deepseek", modelId: "deepseek-chat" })).toBe(custom);
		} finally {
			// The registry is module-global; a test profile must not leak into other tests.
			expect(unregisterModelProfile(custom.id)).toBe(true);
		}
	});
});
