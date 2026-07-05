import type { ModelProfile } from "./types.ts";

export const DEEPSEEK_V4_PRO_PROFILE_ID = "deepseek-v4-pro@2026-06";

/**
 * First ModelProfile: everything the harness previously assumed implicitly about
 * DeepSeek lives here. Window and cost figures mirror pi-ai's registry entry for
 * deepseek/deepseek-v4-pro; dialect and failure signatures are the extracted
 * operating assumptions, to be tightened by conformance runs and scorecard data.
 */
export const deepSeekV4ProProfile: ModelProfile = {
	id: DEEPSEEK_V4_PRO_PROFILE_ID,
	provider: "deepseek",
	modelId: "deepseek-v4-pro",
	api: "openai-completions",
	window: {
		declared: 1_000_000,
		// No measured long-context degradation yet; keep equal to declared until conformance says otherwise.
		effective: 1_000_000,
	},
	toolCalling: "native",
	promptDialect: {
		systemPreamble: "Be direct and concrete. State uncertainty explicitly instead of guessing.",
		jsonInstruction:
			"Respond with exactly one fenced ```json code block containing a single JSON object and nothing else — no prose before or after the fence.",
		thinkingLevel: "off",
	},
	failureSignatures: {
		refusal: [
			/\b(?:i\s+(?:cannot|can['’]t|am unable to)\s+(?:help|assist|comply|do|provide)|as an ai\b)/i,
			/(?:无法|不能)(?:协助|提供|完成|帮助)/,
			/抱歉[，,]?\s*我(?:无法|不能)/,
		],
		loop: [/(.{24,}?)(?:\s*\1){4,}/s],
		// An opening fence whose JSON body never closes — the output was cut mid-block.
		truncation: [/```(?:json)?\s*\{(?:(?!```)[\s\S])*$/],
	},
	cost: {
		inputPerMTok: 0.435,
		outputPerMTok: 0.87,
		cacheReadPerMTok: 0.003625,
	},
	cache: {
		// DeepSeek's automatic prefix cache: cached reads are ~120x cheaper than uncached input.
		strategy: "automatic-prefix",
		supportsLongCacheRetention: false,
	},
	match: {
		providers: ["deepseek"],
		baseUrlIncludes: ["deepseek.com"],
	},
	strengths: ["zh-summarization", "structured-extraction", "tool-use", "coding"],
};
