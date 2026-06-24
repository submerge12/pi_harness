import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { Static } from "typebox";
import { createAgent } from "../../agents/create-agent.ts";
import { mergeStricterPolicies, type ToolAccessMap } from "../../agents/merge.ts";
import type { AgentProfile } from "../../agents/profile.ts";
import { getProfile } from "../../agents/registry.ts";
import type { HarnessConfig, ResolvedHarnessConfig } from "../../config.ts";
import { taskContractSchema, type TaskContract } from "../../contract/index.ts";
import type { ActiveWorktreeLease, ActiveWorktreeLeaseProvider } from "../../execution/index.ts";
import { isPathWithinWriteScope, normalizeWriteScope } from "../../execution/write-scope.ts";
import type { GenericHarness, GenericHarnessRuntimeOptions } from "../../harness.ts";
import type { StoredToolRegistration } from "../types.ts";

const spawnAgentParameters = Type.Object({
	profile: Type.String(),
	prompt: Type.String(),
	task_contract: Type.Optional(taskContractSchema),
	max_turns: Type.Optional(Type.Integer({ minimum: 1 })),
});

type SpawnAgentParameters = Static<typeof spawnAgentParameters>;

export interface SpawnAgentToolDetails {
	profile: string;
	maxTurns: number;
	stopReason?: AssistantMessage["stopReason"];
	taskContractId?: string;
	assignedSkill?: string;
	gateTier?: TaskContract["gateTier"];
	writeScope?: readonly string[];
}

export type SpawnAgentProfileResolver = (name: string) => AgentProfile;
export type SpawnAgentChildHarness = Pick<GenericHarness, "prompt" | "dispose">;
export type SpawnAgentChildFactory = (
	profile: AgentProfile,
	options: HarnessConfig & GenericHarnessRuntimeOptions,
) => Promise<SpawnAgentChildHarness>;

export interface SpawnAgentToolOptions extends GenericHarnessRuntimeOptions {
	config: ResolvedHarnessConfig;
	profileResolver?: SpawnAgentProfileResolver;
	createChildAgent?: SpawnAgentChildFactory;
	depth?: number;
	maxDepth?: number;
}

function assistantText(message: AssistantMessage): string {
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			if (!part || typeof part !== "object") return "";
			if (!("type" in part) || part.type !== "text") return "";
			return "text" in part && typeof part.text === "string" ? part.text : "";
		})
		.join("");
}

function toolAccessMap(registrations: readonly StoredToolRegistration[] | undefined): ToolAccessMap | undefined {
	if (!registrations || registrations.length === 0) return undefined;
	const accessByTool: Record<string, StoredToolRegistration["accessLevel"]> = {};
	for (const registration of registrations) {
		accessByTool[registration.tool.name] = registration.accessLevel;
	}
	return accessByTool;
}

function buildDelegatedPrompt(prompt: string, taskContract: TaskContract | undefined): string {
	if (!taskContract) return prompt;
	return [
		"TaskContract (authoritative delegation envelope):",
		JSON.stringify(taskContract, null, "\t"),
		"",
		"Instruction:",
		prompt,
	].join("\n");
}

function createContractLeaseProvider(
	taskContract: TaskContract | undefined,
	parentProvider: ActiveWorktreeLeaseProvider["getActiveLease"] | undefined,
): ActiveWorktreeLeaseProvider["getActiveLease"] | undefined {
	if (!taskContract) return parentProvider;
	const writeScope = normalizeWriteScope(taskContract.writeScope, { allowEmpty: true });
	const parentLease = parentProvider?.();
	if (parentLease) assertContractScopeWithinParent(writeScope, parentLease);
	return () => ({ writeScope });
}

function assertContractScopeWithinParent(writeScope: readonly string[], parentLease: ActiveWorktreeLease): void {
	for (const scopePath of writeScope) {
		if (!isPathWithinWriteScope(scopeRoot(scopePath), parentLease.writeScope)) {
			throw new Error(`task contract write scope exceeds active lease: ${scopePath}`);
		}
	}
}

function scopeRoot(scopePath: string): string {
	return scopePath.endsWith("/**") ? scopePath.slice(0, -3) : scopePath;
}

function childActiveToolNames(
	parentActiveToolNames: readonly string[] | undefined,
	taskContract: TaskContract | undefined,
): string[] | undefined {
	const allowedTools = taskContract?.allowedTools;
	if (!allowedTools || allowedTools.length === 0) {
		return parentActiveToolNames ? [...parentActiveToolNames] : undefined;
	}
	const allowed = new Set(allowedTools);
	if (!parentActiveToolNames) return [...allowedTools];
	return parentActiveToolNames.filter((toolName) => allowed.has(toolName));
}

export function createSpawnAgentTool(
	options: SpawnAgentToolOptions,
): AgentTool<typeof spawnAgentParameters, SpawnAgentToolDetails> {
	const profileResolver = options.profileResolver ?? getProfile;
	const createChildAgent = options.createChildAgent ?? createAgent;
	const depth = options.depth ?? options.config.internal?.spawnAgentDepth ?? 0;
	const maxDepth = options.maxDepth ?? 1;
	const toolAccessLevels = toolAccessMap(options.config.toolRegistrations);

	return {
		name: "spawn_agent",
		label: "Spawn Agent",
		description: "Delegates a prompt to another registered agent profile.",
		parameters: spawnAgentParameters,
		async execute(_toolCallId, params: SpawnAgentParameters) {
			if (depth >= maxDepth) throw new Error("spawn_agent depth limit exceeded");

			const maxTurns = params.max_turns ?? 10;
			const childProfile = profileResolver(params.profile);
			const getActiveLease = createContractLeaseProvider(params.task_contract, options.getActiveLease);
			const activeToolNames = childActiveToolNames(options.config.activeToolNames, params.task_contract);
			const childOptions: HarnessConfig & GenericHarnessRuntimeOptions = {
				...options.config,
				...(activeToolNames ? { activeToolNames } : {}),
				...(options.evidenceGateway ? { evidenceGateway: options.evidenceGateway } : {}),
				...(getActiveLease ? { getActiveLease } : {}),
				internal: {
					...options.config.internal,
					spawnAgentDepth: depth + 1,
					inheritedPolicy: options.config.policy,
				},
				policy: mergeStricterPolicies(options.config.policy, childProfile.policy, toolAccessLevels),
			};
			const child = await createChildAgent(childProfile, childOptions);
			try {
				const prompt = buildDelegatedPrompt(params.prompt, params.task_contract);
				const message = await child.prompt(prompt, { maxTurns } as Parameters<GenericHarness["prompt"]>[1]);
				return {
					content: [{ type: "text", text: assistantText(message) }],
					details: {
						profile: childProfile.name,
						maxTurns,
						stopReason: message.stopReason,
						...(params.task_contract
							? {
									taskContractId: params.task_contract.id,
									assignedSkill: params.task_contract.assignedSkill,
									gateTier: params.task_contract.gateTier,
									writeScope: [...params.task_contract.writeScope],
								}
							: {}),
					},
				};
			} finally {
				await child.dispose();
			}
		},
	};
}
