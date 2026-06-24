import type { HarnessConfig, PermissionPolicyConfig } from "../config.ts";
import type { SubjectPolicyRule } from "../policy/types.ts";
import type { PermissionLevel, PermissionPolicy, ToolAccessLevel } from "../tools/types.ts";
import type { AgentProfile } from "./profile.ts";

export type SystemPrompt<TContext = unknown> = string | ((context: TContext) => string | Promise<string>);

const defaultPermissionDefaults: Record<ToolAccessLevel, PermissionLevel> = {
	"read-only": "allow",
	write: "ask",
	destructive: "ask",
	network: "ask",
};

const permissionStrength: Record<PermissionLevel, number> = {
	allow: 0,
	ask: 1,
	deny: 2,
};

export type ToolAccessMap = Readonly<Partial<Record<string, ToolAccessLevel>>>;

function hasPolicyValues(policy: PermissionPolicyConfig | undefined): policy is PermissionPolicyConfig {
	return Boolean(
		policy &&
			(Object.keys(policy.defaults ?? {}).length > 0 ||
				Object.keys(policy.tools ?? {}).length > 0 ||
				(policy.rules?.length ?? 0) > 0),
	);
}

function cloneRule(rule: SubjectPolicyRule): SubjectPolicyRule {
	return { ...rule };
}

function cloneRules(rules: readonly SubjectPolicyRule[] | undefined): SubjectPolicyRule[] {
	return rules ? rules.map(cloneRule) : [];
}

function ruleKey(rule: SubjectPolicyRule): string {
	return `${rule.toolName}\u0000${rule.subject}`;
}

export function stricterPermission(
	left: PermissionLevel | undefined,
	right: PermissionLevel | undefined,
): PermissionLevel | undefined {
	if (!left) return right;
	if (!right) return left;
	return permissionStrength[left] >= permissionStrength[right] ? left : right;
}

function policyDefault(
	policy: PermissionPolicyConfig | PermissionPolicy | undefined,
	accessLevel: ToolAccessLevel,
): PermissionLevel {
	return policy?.defaults?.[accessLevel] ?? defaultPermissionDefaults[accessLevel];
}

function effectiveToolPermission(
	policy: PermissionPolicyConfig | PermissionPolicy | undefined,
	toolName: string,
	accessLevel: ToolAccessLevel,
): PermissionLevel {
	return (
		stricterPermission(policy?.tools?.[toolName], policyDefault(policy, accessLevel)) ??
		policyDefault(policy, accessLevel)
	);
}

export function mergePermissionPolicies(
	base: PermissionPolicyConfig | PermissionPolicy | undefined,
	override: PermissionPolicyConfig | PermissionPolicy | undefined,
): PermissionPolicyConfig | undefined {
	if (!base && !override) return undefined;
	const defaults = { ...base?.defaults, ...override?.defaults };
	const tools = { ...base?.tools, ...override?.tools };
	const rules = [...cloneRules(base?.rules), ...cloneRules(override?.rules)];
	const merged: PermissionPolicyConfig = {};
	if (Object.keys(defaults).length > 0) merged.defaults = defaults;
	if (Object.keys(tools).length > 0) merged.tools = tools;
	if (rules.length > 0) merged.rules = rules;
	return hasPolicyValues(merged) ? merged : undefined;
}

function mergeStricterRules(
	parentRules: readonly SubjectPolicyRule[] | undefined,
	childRules: readonly SubjectPolicyRule[] | undefined,
): SubjectPolicyRule[] | undefined {
	const merged = new Map<string, SubjectPolicyRule>();
	for (const rule of parentRules ?? []) {
		merged.set(ruleKey(rule), cloneRule(rule));
	}
	for (const rule of childRules ?? []) {
		const key = ruleKey(rule);
		const inherited = merged.get(key);
		if (!inherited || permissionStrength[rule.level] > permissionStrength[inherited.level]) {
			merged.set(key, cloneRule(rule));
		}
	}
	const rules = [...merged.values()];
	return rules.length > 0 ? rules : undefined;
}

export function mergeStricterPolicies(
	parent: PermissionPolicyConfig | PermissionPolicy | undefined,
	child: PermissionPolicyConfig | PermissionPolicy | undefined,
	toolAccessLevels: ToolAccessMap = {},
): PermissionPolicy {
	const defaults = {} as Record<ToolAccessLevel, PermissionLevel>;
	for (const accessLevel of Object.keys(defaultPermissionDefaults) as ToolAccessLevel[]) {
		defaults[accessLevel] =
			stricterPermission(parent?.defaults?.[accessLevel], child?.defaults?.[accessLevel]) ??
			defaultPermissionDefaults[accessLevel];
	}

	const tools: Record<string, PermissionLevel> = {};
	const toolNames = new Set([...Object.keys(parent?.tools ?? {}), ...Object.keys(child?.tools ?? {})]);
	for (const toolName of toolNames) {
		const accessLevel = toolAccessLevels[toolName];
		const permission = accessLevel
			? stricterPermission(
					effectiveToolPermission(parent, toolName, accessLevel),
					effectiveToolPermission(child, toolName, accessLevel),
				)
			: stricterPermission(parent?.tools?.[toolName], child?.tools?.[toolName]);
		if (permission) tools[toolName] = permission;
	}

	const rules = mergeStricterRules(parent?.rules, child?.rules);
	return {
		defaults,
		...(Object.keys(tools).length > 0 ? { tools } : {}),
		...(rules ? { rules } : {}),
	};
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
