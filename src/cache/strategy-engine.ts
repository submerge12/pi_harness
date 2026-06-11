import type {
	AgentHarness,
	BeforeProviderRequestEvent,
	BeforeProviderRequestResult,
} from "@earendil-works/pi-agent-core";
import type { CacheRetention } from "@earendil-works/pi-ai";
import { getProviderCacheProfile } from "./profiles.ts";
import type { CacheStrategyDecision, CacheStrategyEngineOptions, CacheStrategyRequest } from "./types.ts";

const DEFAULT_CACHE_RETENTION: CacheRetention = "short";

function longIfSupported(retention: CacheRetention, supportsLongCacheRetention: boolean): CacheRetention {
	if (retention === "long" && !supportsLongCacheRetention) {
		return "short";
	}
	return retention;
}

export class CacheStrategyEngine {
	private readonly cacheRetention?: CacheRetention;
	private readonly enabled: boolean;
	private readonly onDecision?: (decision: CacheStrategyDecision) => void;

	constructor(options: CacheStrategyEngineOptions = {}) {
		this.cacheRetention = options.cacheRetention;
		this.enabled = options.enabled ?? true;
		this.onDecision = options.onDecision;
	}

	bind(harness: Pick<AgentHarness, "on">): () => void {
		return harness.on("before_provider_request", (event) => this.handleBeforeProviderRequest(event));
	}

	handleBeforeProviderRequest(event: BeforeProviderRequestEvent): BeforeProviderRequestResult {
		const decision = this.buildDecision({
			model: event.model,
			sessionId: event.sessionId,
			streamOptions: event.streamOptions,
		});
		this.onDecision?.(decision);
		return { streamOptions: decision.streamOptions };
	}

	buildDecision(request: CacheStrategyRequest): CacheStrategyDecision {
		const profile = getProviderCacheProfile(request.model);
		const requestedRetention = this.enabled
			? (request.streamOptions.cacheRetention ?? this.cacheRetention ?? DEFAULT_CACHE_RETENTION)
			: "none";

		if (requestedRetention === "none" || profile.strategy === "no-cache") {
			return {
				profile,
				streamOptions: { cacheRetention: "none" },
			};
		}

		if (profile.strategy === "automatic-prefix") {
			return {
				profile,
				streamOptions: { cacheRetention: "short" },
			};
		}

		const cacheRetention = longIfSupported(requestedRetention, profile.supportsLongCacheRetention);

		if (profile.strategy === "explicit-breakpoints") {
			return {
				profile,
				streamOptions: { cacheRetention },
			};
		}

		if (!request.sessionId) {
			return {
				profile,
				streamOptions: { cacheRetention },
			};
		}

		return {
			profile,
			streamOptions: {
				cacheRetention,
				headers: {
					session_id: request.sessionId,
					"x-client-request-id": request.sessionId,
					"x-session-affinity": request.sessionId,
				},
				metadata: {
					"pi.cache.sessionId": request.sessionId,
					"pi.cache.strategy": profile.strategy,
				},
			},
		};
	}
}
