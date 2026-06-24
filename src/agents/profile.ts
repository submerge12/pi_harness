import type { ExecutionEnv, PromptTemplate, Skill, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { KnownProvider } from "@earendil-works/pi-ai";
import type { ResolvedHarnessConfig } from "../config.ts";
import type { TokenBudgetRatios } from "../context/token-budget.ts";
import type { CheckpointStore } from "../checkpoint/index.ts";
import type { EvidenceGateway } from "../evidence/index.ts";
import type { ActiveWorktreeLeaseProvider } from "../execution/index.ts";
import type { GenericHarness } from "../harness.ts";
import type { ScheduledTaskDefinition } from "../scheduler/types.ts";
import type { PermissionPolicy, ToolPermissionDecisionLookup, ToolRegistration } from "../tools/types.ts";

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
	evidenceGateway?: EvidenceGateway;
	getPermissionDecision?: ToolPermissionDecisionLookup;
	getActiveLease?: ActiveWorktreeLeaseProvider["getActiveLease"];
	checkpoint?: CheckpointStore;
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
	scheduledTasks?: readonly ScheduledTaskDefinition[];
	proactiveCheck?: (context: AgentToolFactoryContext) => Promise<string>;
	install?: AgentProfileInstall;
}
