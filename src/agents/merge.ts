import type { HarnessConfig, PermissionPolicyConfig } from "../config.ts";
import type { PermissionPolicy } from "../tools/types.ts";
import type { AgentProfile } from "./profile.ts";

export type SystemPrompt<TContext = unknown> = string | ((context: TContext) => string | Promise<string>);

function hasPolicyValues(policy: PermissionPolicyConfig | undefined): policy is PermissionPolicyConfig {
	return Boolean(policy && (Object.keys(policy.defaults ?? {}).length > 0 || policy.tools));
}

export function mergePermissionPolicies(
	base: PermissionPolicyConfig | PermissionPolicy | undefined,
	override: PermissionPolicyConfig | PermissionPolicy | undefined,
): PermissionPolicyConfig | undefined {
	if (!base && !override) return undefined;
	const defaults = { ...base?.defaults, ...override?.defaults };
	const tools = { ...base?.tools, ...override?.tools };
	const merged: PermissionPolicyConfig = {};
	if (Object.keys(defaults).length > 0) merged.defaults = defaults;
	if (Object.keys(tools).length > 0) merged.tools = tools;
	return hasPolicyValues(merged) ? merged : undefined;
}

export function mergeSystemPrompts<TContext>(
	base?: SystemPrompt<TContext>,
	extension?: SystemPrompt<TContext>,
): SystemPrompt<TContext> | undefined {
	if (!base) return extension;
	if (!extension) return base;
	if (typeof base === "string" && typeof extension === "string") return `${base}\n\n${extension}`;
	return async (context: TContext) => {
		const baseText = typeof base === "string" ? base : await base(context);
		const extensionText = typeof extension === "string" ? extension : await extension(context);
		return [baseText, extensionText].filter((part) => part.length > 0).join("\n\n");
	};
}

function mergeCompaction(profile: AgentProfile, overrides: HarnessConfig): HarnessConfig["compaction"] {
	const profileInstructions = profile.context?.compactionInstructions;
	if (!profileInstructions) return overrides.compaction ? { ...overrides.compaction } : undefined;
	return {
		customInstructions: profileInstructions,
		...overrides.compaction,
	};
}

export function mergeAgentProfileConfig(profile: AgentProfile, overrides: HarnessConfig = {}): HarnessConfig {
	const systemPrompt = mergeSystemPrompts(profile.systemPrompt, overrides.systemPrompt) as string | undefined;
	return {
		...overrides,
		provider: overrides.provider ?? profile.model?.provider,
		modelId: overrides.modelId ?? profile.model?.modelId,
		thinkingLevel: overrides.thinkingLevel ?? profile.thinkingLevel,
		systemPrompt,
		policy: mergePermissionPolicies(profile.policy, overrides.policy),
		tokenBudgetRatios: overrides.tokenBudgetRatios ?? profile.context?.ratios,
		compaction: mergeCompaction(profile, overrides),
	};
}
