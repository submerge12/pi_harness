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
import {
	resolvePermissionProfile,
	type CommandRule,
	type PermissionProfileName,
	type RunPolicy,
} from "./policy/profiles.ts";
import type { SubjectPolicyRule } from "./policy/types.ts";
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

export interface DatabaseConfig {
	url?: string;
	maxConnections?: number;
}

export interface HarnessSchedulerConfig {
	checkIntervalMs?: number;
	tasks?: Array<Record<string, unknown>>;
}

export interface ReviewLoopConfig {
	enabled?: boolean;
	maxAttempts?: number;
	maxTurns?: number;
	reviewerProfile?: string;
	reviewerMaxTurns?: number;
	runPolicy?: RunPolicy;
}

export interface PermissionPolicyConfig {
	defaults?: Partial<Record<ToolAccessLevel, PermissionLevel>>;
	tools?: Record<string, PermissionLevel>;
	rules?: readonly SubjectPolicyRule[];
}

export interface HarnessInternalConfig {
	spawnAgentDepth?: number;
	inheritedPolicy?: PermissionPolicyConfig | PermissionPolicy;
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
	permissionProfile?: PermissionProfileName;
	runPolicy?: RunPolicy;
	askPermission?: AskPermissionCallback;
	contextWindow?: number;
	tokenBudgetRatios?: TokenBudgetRatios;
	compaction?: CompactionPolicyConfig;
	pruning?: PruningConfig;
	cache?: CacheStrategyEngineOptions;
	retry?: RetryConfig;
	budget?: BudgetLimits;
	eventLog?: EventLogConfig;
	database?: DatabaseConfig;
	scheduler?: HarnessSchedulerConfig;
	reviewLoop?: ReviewLoopConfig;
	internal?: HarnessInternalConfig;
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
	permissionProfile?: PermissionProfileName;
	commandRules?: readonly CommandRule[];
	runPolicy?: RunPolicy;
	askPermission?: AskPermissionCallback;
	contextWindow?: number;
	tokenBudgetRatios?: TokenBudgetRatios;
	compaction?: CompactionPolicyConfig;
	pruning: ResolvedPruningConfig;
	cache?: CacheStrategyEngineOptions;
	retry?: RetryConfig;
	budget?: BudgetLimits;
	eventLog?: EventLogConfig;
	database?: DatabaseConfig;
	scheduler?: HarnessSchedulerConfig;
	reviewLoop?: ReviewLoopConfig;
	internal?: HarnessInternalConfig;
}

function resolveDatabaseConfig(config?: DatabaseConfig): DatabaseConfig | undefined {
	const url = config?.url ?? process.env.DATABASE_URL;
	if (url === undefined && config?.maxConnections === undefined) return undefined;
	return {
		url,
		maxConnections: config?.maxConnections,
	};
}

function clonePolicy(policy: PermissionPolicyConfig | PermissionPolicy | undefined): PermissionPolicyConfig | undefined {
	if (!policy) return undefined;
	const defaults = policy.defaults ? { ...policy.defaults } : undefined;
	const tools = policy.tools ? { ...policy.tools } : undefined;
	const rules = policy.rules ? policy.rules.map((rule) => ({ ...rule })) : undefined;
	return {
		...(defaults ? { defaults } : {}),
		...(tools ? { tools } : {}),
		...(rules ? { rules } : {}),
	};
}

function cloneInternalConfig(config?: HarnessInternalConfig): HarnessInternalConfig | undefined {
	if (!config) return undefined;
	return {
		spawnAgentDepth: config.spawnAgentDepth,
		inheritedPolicy: clonePolicy(config.inheritedPolicy),
	};
}

const permissionStrength: Record<PermissionLevel, number> = {
	allow: 0,
	ask: 1,
	deny: 2,
};

function stricterPermission(first: PermissionLevel | undefined, second: PermissionLevel | undefined): PermissionLevel | undefined {
	if (!first) return second;
	if (!second) return first;
	return permissionStrength[first] >= permissionStrength[second] ? first : second;
}

function resolvePolicy(
	config: HarnessConfig,
): { policy: PermissionPolicy; commandRules?: readonly CommandRule[]; permissionProfile?: PermissionProfileName } {
	const profile = config.permissionProfile
		? resolvePermissionProfile(config.permissionProfile)
		: undefined;
	const defaults = {} as Record<ToolAccessLevel, PermissionLevel>;
	for (const accessLevel of Object.keys(DEFAULT_PERMISSION_POLICY.defaults) as ToolAccessLevel[]) {
		defaults[accessLevel] =
			stricterPermission(
				profile?.policy.defaults?.[accessLevel],
				config.policy?.defaults?.[accessLevel],
			) ?? DEFAULT_PERMISSION_POLICY.defaults[accessLevel];
	}
	const toolNames = new Set([
		...Object.keys(profile?.policy.tools ?? {}),
		...Object.keys(config.policy?.tools ?? {}),
	]);
	const tools: Record<string, PermissionLevel> = {};
	for (const toolName of toolNames) {
		const level = stricterPermission(profile?.policy.tools?.[toolName], config.policy?.tools?.[toolName]);
		if (level) tools[toolName] = level;
	}
	const rules = [
		...(profile?.policy.rules ?? []),
		...(config.policy?.rules ?? []),
	].map((rule) => ({ ...rule }));
	return {
		policy: {
			defaults,
			...(Object.keys(tools).length > 0 ? { tools } : {}),
			...(rules.length > 0 ? { rules } : {}),
		},
		...(profile ? { commandRules: profile.commandRules, permissionProfile: profile.name } : {}),
	};
}

function cloneRunPolicy(runPolicy?: RunPolicy): RunPolicy | undefined {
	if (!runPolicy) return undefined;
	return {
		...runPolicy,
		budget: runPolicy.budget ? { ...runPolicy.budget } : undefined,
		repairLimits: runPolicy.repairLimits ? { ...runPolicy.repairLimits } : undefined,
		gateTiers: runPolicy.gateTiers ? { ...runPolicy.gateTiers } : undefined,
	};
}

export function resolveHarnessConfig(config: HarnessConfig = {}): ResolvedHarnessConfig {
	const policy = resolvePolicy(config);
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
		policy: policy.policy,
		permissionProfile: policy.permissionProfile,
		commandRules: policy.commandRules ? [...policy.commandRules] : undefined,
		runPolicy: cloneRunPolicy(config.runPolicy),
		askPermission: config.askPermission,
		contextWindow: config.contextWindow,
		tokenBudgetRatios: config.tokenBudgetRatios ? { ...config.tokenBudgetRatios } : undefined,
		compaction: config.compaction ? { ...config.compaction } : undefined,
		pruning: resolvePruningConfig(config.pruning),
		cache: config.cache ? { ...config.cache } : undefined,
		retry: config.retry ? { ...config.retry } : undefined,
		budget: config.budget ? { ...config.budget } : undefined,
		eventLog: config.eventLog ? { ...config.eventLog } : undefined,
		database: resolveDatabaseConfig(config.database),
		scheduler: config.scheduler
			? {
					...config.scheduler,
					tasks: config.scheduler.tasks ? [...config.scheduler.tasks] : undefined,
				}
			: undefined,
		reviewLoop: config.reviewLoop
			? {
					...config.reviewLoop,
					runPolicy: cloneRunPolicy(config.reviewLoop.runPolicy),
				}
			: undefined,
		internal: cloneInternalConfig(config.internal),
	};
}
