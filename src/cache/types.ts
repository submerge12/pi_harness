import type {
	AgentHarnessStreamOptionsPatch,
	BeforeProviderRequestResult,
} from "@earendil-works/pi-agent-core";
import type { Api, CacheRetention, Model } from "@earendil-works/pi-ai";

export type ProviderCacheStrategy =
	| "explicit-breakpoints"
	| "automatic-prefix"
	| "session-affinity"
	| "no-cache";

export interface ProviderCacheProfile {
	strategy: ProviderCacheStrategy;
	supportsLongCacheRetention: boolean;
}

export interface CacheStrategyEngineOptions {
	cacheRetention?: CacheRetention;
	enabled?: boolean;
	onDecision?: (decision: CacheStrategyDecision) => void;
}

export interface CacheStrategyRequest {
	model: Model<Api>;
	sessionId?: string;
	streamOptions: {
		cacheRetention?: CacheRetention;
	};
}

export interface CacheStrategyDecision {
	profile: ProviderCacheProfile;
	streamOptions: AgentHarnessStreamOptionsPatch;
}

export type CacheStrategyResult = BeforeProviderRequestResult;
