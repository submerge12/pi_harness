import type {
	AgentHarnessResources,
	AgentHarnessStreamOptions,
	AgentTool,
	ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import type { KnownProvider } from "@earendil-works/pi-ai";
import type { CacheStrategyEngineOptions } from "./cache/types.ts";
import type { CompactionPolicyConfig } from "./context/compaction-policy.ts";
import { resolvePruningConfig, type PruningConfig, type ResolvedPruningConfig } from "./context/prune-executor.ts";
import type { TokenBudgetRatios } from "./context/token-budget.ts";
import type { BudgetLimits } from "./observability/budget.ts";
import type {
	AskPermissionCallback,
	PermissionLevel,
	PermissionPolicy,
	StoredToolRegistration,
	ToolAccessLevel,
} from "./tools/types.ts";

export const DEFAULT_PROVIDER = "deepseek" satisfies KnownProvider;
export const DEFAULT_MODEL_ID = "deepseek-v4-pro";
export const DEFAULT_SESSIONS_ROOT = ".pi-harness/sessions";
export const DEFAULT_THINKING_LEVEL = "off" satisfies ThinkingLevel;
export const DEFAULT_PERMISSION_POLICY: PermissionPolicy = {
	defaults: {
		"read-only": "allow",
		write: "ask",
		destructive: "ask",
		network: "ask",
	},
};

export interface SandboxConfig {
	roots?: string[];
	maxOutputChars?: number;
	bashTimeoutSeconds?: number;
	fetchMaxBytes?: number;
}

export interface RetryConfig {
	attempts?: number;
	baseDelayMs?: number;
	maxDelayMs?: number;
}

export interface EventLogConfig {
	enabled?: boolean;
	filePath?: string;
}

export interface PermissionPolicyConfig {
	defaults?: Partial<Record<ToolAccessLevel, PermissionLevel>>;
	tools?: Record<string, PermissionLevel>;
}

export type AgentConfigOverrides = Omit<HarnessConfig, "agent" | "agents" | "apiKey" | "askPermission" | "tools">;

export interface HarnessConfig {
	cwd?: string;
	sessionsRoot?: string;
	agent?: string;
	agents?: Record<string, AgentConfigOverrides>;
	provider?: KnownProvider;
	modelId?: string;
	apiKey?: string;
	apiHeaders?: Record<string, string>;
	thinkingLevel?: ThinkingLevel;
	streamOptions?: AgentHarnessStreamOptions;
	systemPrompt?: string;
	tools?: AgentTool[];
	toolRegistrations?: StoredToolRegistration[];
	activeToolNames?: string[];
	useDefaultTools?: boolean;
	resources?: AgentHarnessResources;
	sandbox?: SandboxConfig;
	policy?: PermissionPolicyConfig;
	askPermission?: AskPermissionCallback;
	contextWindow?: number;
	tokenBudgetRatios?: TokenBudgetRatios;
	compaction?: CompactionPolicyConfig;
	pruning?: PruningConfig;
	cache?: CacheStrategyEngineOptions;
	retry?: RetryConfig;
	budget?: BudgetLimits;
	eventLog?: EventLogConfig;
}

export interface ResolvedHarnessConfig {
	cwd: string;
	sessionsRoot: string;
	agent?: string;
	agents?: Record<string, AgentConfigOverrides>;
	provider: KnownProvider;
	modelId: string;
	apiKey?: string;
	apiHeaders?: Record<string, string>;
	thinkingLevel: ThinkingLevel;
	streamOptions?: AgentHarnessStreamOptions;
	systemPrompt?: string;
	tools?: AgentTool[];
	toolRegistrations?: StoredToolRegistration[];
	activeToolNames?: string[];
	useDefaultTools: boolean;
	resources?: AgentHarnessResources;
	sandbox?: SandboxConfig;
	policy: PermissionPolicy;
	askPermission?: AskPermissionCallback;
	contextWindow?: number;
	tokenBudgetRatios?: TokenBudgetRatios;
	compaction?: CompactionPolicyConfig;
	pruning: ResolvedPruningConfig;
	cache?: CacheStrategyEngineOptions;
	retry?: RetryConfig;
	budget?: BudgetLimits;
	eventLog?: EventLogConfig;
}

export function resolveHarnessConfig(config: HarnessConfig = {}): ResolvedHarnessConfig {
	return {
		cwd: config.cwd ?? process.cwd(),
		sessionsRoot: config.sessionsRoot ?? DEFAULT_SESSIONS_ROOT,
		agent: config.agent,
		agents: config.agents ? { ...config.agents } : undefined,
		provider: config.provider ?? DEFAULT_PROVIDER,
		modelId: config.modelId ?? DEFAULT_MODEL_ID,
		apiKey: config.apiKey,
		apiHeaders: config.apiHeaders ? { ...config.apiHeaders } : undefined,
		thinkingLevel: config.thinkingLevel ?? DEFAULT_THINKING_LEVEL,
		streamOptions: config.streamOptions ? { ...config.streamOptions } : undefined,
		systemPrompt: config.systemPrompt,
		tools: config.tools ? [...config.tools] : undefined,
		toolRegistrations: config.toolRegistrations ? [...config.toolRegistrations] : undefined,
		activeToolNames: config.activeToolNames ? [...config.activeToolNames] : undefined,
		useDefaultTools: config.useDefaultTools ?? config.tools === undefined,
		resources: config.resources
			? {
					promptTemplates: config.resources.promptTemplates ? [...config.resources.promptTemplates] : undefined,
					skills: config.resources.skills ? [...config.resources.skills] : undefined,
				}
			: undefined,
		sandbox: config.sandbox
			? {
					...config.sandbox,
					roots: config.sandbox.roots ? [...config.sandbox.roots] : undefined,
				}
			: undefined,
		policy: {
			defaults: { ...DEFAULT_PERMISSION_POLICY.defaults, ...config.policy?.defaults },
			tools: config.policy?.tools ? { ...config.policy.tools } : undefined,
		},
		askPermission: config.askPermission,
		contextWindow: config.contextWindow,
		tokenBudgetRatios: config.tokenBudgetRatios ? { ...config.tokenBudgetRatios } : undefined,
		compaction: config.compaction ? { ...config.compaction } : undefined,
		pruning: resolvePruningConfig(config.pruning),
		cache: config.cache ? { ...config.cache } : undefined,
		retry: config.retry ? { ...config.retry } : undefined,
		budget: config.budget ? { ...config.budget } : undefined,
		eventLog: config.eventLog ? { ...config.eventLog } : undefined,
	};
}
