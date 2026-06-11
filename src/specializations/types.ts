import type { Api, Model } from "@earendil-works/pi-ai";

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface ToolRegistration {
	name: string;
	description?: string;
	value?: unknown;
}

export type HarnessPolicy = Record<string, unknown>;

export type SystemPrompt<TContext = unknown> = string | ((context: TContext) => string | Promise<string>);

export interface SpecializableHarnessConfig<TTool = ToolRegistration, TPolicy extends HarnessPolicy = HarnessPolicy> {
	tools?: readonly TTool[];
	systemPrompt?: SystemPrompt;
	model?: unknown;
	thinkingLevel?: ThinkingLevel | string;
	policy?: TPolicy;
}

export interface HarnessSpecialization<
	TTool = ToolRegistration,
	TPolicy extends HarnessPolicy = HarnessPolicy,
	TDefaultModel = Model<Api>,
> {
	name: string;
	tools?: readonly TTool[];
	systemPrompt?: SystemPrompt;
	defaultModel?: TDefaultModel;
	defaultThinkingLevel?: ThinkingLevel;
	policy?: TPolicy;
}

function hasValues(value: HarnessPolicy): boolean {
	return Object.keys(value).length > 0;
}

function isPolicyRecord(value: unknown): value is HarnessPolicy {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mergePolicies(base: HarnessPolicy, extension: HarnessPolicy): HarnessPolicy {
	const result: HarnessPolicy = { ...base };
	for (const [key, value] of Object.entries(extension)) {
		const existing = result[key];
		result[key] = isPolicyRecord(existing) && isPolicyRecord(value) ? mergePolicies(existing, value) : value;
	}
	return result;
}

export function mergeSystemPrompts(base?: SystemPrompt, extension?: SystemPrompt): SystemPrompt | undefined {
	if (!base) return extension;
	if (!extension) return base;
	if (typeof base === "string" && typeof extension === "string") return `${base}\n\n${extension}`;
	return async (context: unknown) => {
		const baseText = typeof base === "string" ? base : await base(context);
		const extensionText = typeof extension === "string" ? extension : await extension(context);
		return [baseText, extensionText].filter((part) => part.length > 0).join("\n\n");
	};
}

export function createSpecializedHarness<
	TConfig extends SpecializableHarnessConfig<TTool, HarnessPolicy>,
	TTool = ToolRegistration,
	TDefaultModel = Model<Api>,
>(
	baseConfig: Readonly<TConfig>,
	specialization: HarnessSpecialization<TTool, HarnessPolicy, TDefaultModel>,
): TConfig & SpecializableHarnessConfig<TTool> {
	const baseTools = baseConfig.tools ? [...baseConfig.tools] : [];
	const specializationTools = specialization.tools ? [...specialization.tools] : [];
	const mergedTools = [...baseTools, ...specializationTools];
	const basePolicy = baseConfig.policy ? { ...baseConfig.policy } : {};
	const specializationPolicy = specialization.policy ? { ...specialization.policy } : {};
	const mergedPolicy = mergePolicies(basePolicy, specializationPolicy);
	const result: Record<string, unknown> = { ...baseConfig };

	if (mergedTools.length > 0) result.tools = mergedTools;
	const systemPrompt = mergeSystemPrompts(baseConfig.systemPrompt, specialization.systemPrompt);
	if (systemPrompt) result.systemPrompt = systemPrompt;
	if (result.model === undefined && specialization.defaultModel !== undefined)
		result.model = specialization.defaultModel;
	if (result.thinkingLevel === undefined && specialization.defaultThinkingLevel) {
		result.thinkingLevel = specialization.defaultThinkingLevel;
	}
	if (hasValues(mergedPolicy)) result.policy = mergedPolicy;

	return result as TConfig & SpecializableHarnessConfig<TTool>;
}
