import type { ExecutionEnv, PromptTemplate, Skill, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { KnownProvider } from "@earendil-works/pi-ai";
import type { ResolvedHarnessConfig } from "../config.ts";
import type { TokenBudgetRatios } from "../context/token-budget.ts";
import type { GenericHarness } from "../harness.ts";
import type { PermissionPolicy, ToolRegistration } from "../tools/types.ts";

export interface AgentModelDefault {
	provider: KnownProvider;
	modelId: string;
}

export interface AgentContextDefaults {
	ratios?: TokenBudgetRatios;
	compactionInstructions?: string;
}

export interface AgentToolFactoryContext {
	env: ExecutionEnv;
	config: ResolvedHarnessConfig;
}

export type AgentToolRegistrationFactory = (
	context: AgentToolFactoryContext,
) => ToolRegistration | readonly ToolRegistration[] | Promise<ToolRegistration | readonly ToolRegistration[]>;

export type AgentToolDefinition = ToolRegistration | AgentToolRegistrationFactory;

export type AgentProfileDisposer = () => void | Promise<void>;

export type AgentProfileInstall = (
	harness: GenericHarness,
) => void | AgentProfileDisposer | Promise<void | AgentProfileDisposer>;

export interface AgentProfile {
	name: string;
	description: string;
	systemPrompt: string;
	tools?: readonly AgentToolDefinition[];
	policy?: PermissionPolicy;
	model?: AgentModelDefault;
	thinkingLevel?: ThinkingLevel;
	context?: AgentContextDefaults;
	skills?: readonly Skill[];
	templates?: readonly PromptTemplate[];
	install?: AgentProfileInstall;
}
