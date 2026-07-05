import { describe, expect, it } from "vitest";
import { deepSeekV4ProProfile, type ModelProfile } from "../../src/model-profiles/index.ts";
import { declaredCapabilities, lookupModelPriors } from "../../src/routing/model-priors.ts";

const otherProfile: ModelProfile = {
	id: "other-model@unit",
	provider: "openai",
	modelId: "other",
	api: "openai-completions",
	window: { declared: 128_000, effective: 128_000 },
	toolCalling: "prompted-json",
	promptDialect: {},
	failureSignatures: {},
	cost: { inputPerMTok: 0.2, outputPerMTok: 0.4 },
	strengths: ["zh-summarization"],
};

describe("model priors lookup", () => {
	it("returns declared priors for a capability from the registry by default", () => {
		const priors = lookupModelPriors("zh-summarization");
		expect(priors).toContainEqual({
			profileId: deepSeekV4ProProfile.id,
			capability: "zh-summarization",
			source: "declared",
		});
	});

	it("returns an empty list for capabilities nobody claims — it never invents a route", () => {
		expect(lookupModelPriors("quantum-chromodynamics")).toEqual([]);
	});

	it("consults an explicit profile list without touching the registry", () => {
		const priors = lookupModelPriors("zh-summarization", [deepSeekV4ProProfile, otherProfile]);
		expect(priors.map((prior) => prior.profileId)).toEqual([deepSeekV4ProProfile.id, otherProfile.id]);
	});

	it("lists deduplicated declared capabilities", () => {
		const capabilities = declaredCapabilities([deepSeekV4ProProfile, otherProfile]);
		expect(capabilities.filter((capability) => capability === "zh-summarization")).toHaveLength(1);
		expect(capabilities).toContain("coding");
	});
});
