import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, KnownProvider } from "@earendil-works/pi-ai";
import type { ProviderCacheProfile } from "../cache/types.ts";

export type ModelToolCallingMode = "native" | "prompted-json";

export interface ModelProfileWindow {
	/** Provider-declared context window in tokens. */
	declared: number;
	/** Working window the harness budgets against; tighten from measured degradation, never widen past declared. */
	effective: number;
}

export interface ModelPromptDialect {
	/** Phrasing that measurably improves this model's behavior; prepended to system prompts by callers that opt in. */
	systemPreamble?: string;
	/** Phrasing that reliably elicits strict JSON from this model. */
	jsonInstruction?: string;
	/** Thinking level this model should run at by default. */
	thinkingLevel?: ThinkingLevel;
}

export interface ModelFailureSignatures {
	refusal?: readonly RegExp[];
	loop?: readonly RegExp[];
	truncation?: readonly RegExp[];
}

export interface ModelCostProfile {
	inputPerMTok: number;
	outputPerMTok: number;
	cacheReadPerMTok?: number;
}

/** Data (not code) used to match a runtime model back to its profile. */
export interface ModelMatchHints {
	providers?: readonly string[];
	baseUrlIncludes?: readonly string[];
}

/**
 * The single seam between the generic harness and model-specific behavior.
 * One declared data object per model; general modules consume fields, never model names.
 */
export interface ModelProfile {
	/** Stable profile id, e.g. "deepseek-v4-pro@2026-06". Emitted in NormalizedResult.model for attribution. */
	id: string;
	provider: KnownProvider;
	modelId: string;
	api: Api;
	window: ModelProfileWindow;
	/** Selects the tool-call coercion strategy in model-adapters/. */
	toolCalling: ModelToolCallingMode;
	promptDialect: ModelPromptDialect;
	/** Classified by model-adapters/failure-classifier.ts to pick the retry/repair policy. */
	failureSignatures: ModelFailureSignatures;
	cost: ModelCostProfile;
	/** Provider cache behavior; consulted by cache/profiles.ts. */
	cache?: ProviderCacheProfile;
	match?: ModelMatchHints;
	/** Free-form capability priors ("zh-summarization", "extraction"); read by routing/model-priors.ts. */
	strengths?: readonly string[];
}
