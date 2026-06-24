import type { ExecutionEnv } from "@earendil-works/pi-agent-core";
import type { CheckpointStore } from "../../../checkpoint/index.ts";
import type { EvidenceGateway } from "../../../evidence/index.ts";
import type { CommandRule } from "../../../policy/index.ts";
import type { AgentProfile } from "../../profile.ts";
import type { ToolPermissionDecisionLookup, ToolRegistration } from "../../../tools/types.ts";
import {
	createBashTool,
	createEditTool,
	createFetchTool,
	createGlobTool,
	createGrepTool,
	createLsTool,
	createReadTool,
	createSpawnAgentTool,
	createWriteTool,
	type FetchImplementation,
} from "../../../tools/builtin/index.ts";
import type { ActiveWorktreeLeaseProvider } from "../../../execution/index.ts";
import type { ResolvedHarnessConfig } from "../../../config.ts";
import { codingSystemPrompt } from "./prompt.ts";
import { fixTestsSkill } from "./skills/fix-tests.ts";
import { reviewSkill } from "./skills/review.ts";

export interface CodingToolRegistrationOptions {
	env: ExecutionEnv;
	roots?: readonly string[];
	maxOutputChars?: number;
	bashTimeoutSeconds?: number;
	fetch?: FetchImplementation;
	fetchMaxBytes?: number;
	evidenceGateway?: EvidenceGateway;
	getPermissionDecision?: ToolPermissionDecisionLookup;
	getActiveLease?: ActiveWorktreeLeaseProvider["getActiveLease"];
	checkpoint?: CheckpointStore;
	commandRules?: readonly CommandRule[];
	config: ResolvedHarnessConfig;
}

export function createCodingToolRegistrations(options: CodingToolRegistrationOptions): ToolRegistration[] {
	return [
		{ tool: createReadTool(options), accessLevel: "read-only" },
		{ tool: createLsTool(options), accessLevel: "read-only" },
		{ tool: createGrepTool(options), accessLevel: "read-only" },
		{ tool: createGlobTool(options), accessLevel: "read-only" },
		{ tool: createWriteTool(options), accessLevel: "write" },
		{ tool: createEditTool(options), accessLevel: "write" },
		{
			tool: createSpawnAgentTool({
				config: options.config,
				evidenceGateway: options.evidenceGateway,
				getActiveLease: options.getActiveLease,
			}),
			accessLevel: "destructive",
		},
		{
			tool: createBashTool({ ...options, defaultTimeoutSeconds: options.bashTimeoutSeconds }),
			accessLevel: "destructive",
		},
		{
			tool: createFetchTool({
				fetch: options.fetch,
				maxBytes: options.fetchMaxBytes,
				evidenceGateway: options.evidenceGateway,
				getPermissionDecision: options.getPermissionDecision,
			}),
			accessLevel: "network",
		},
	];
}

export const codingProfile = {
	name: "coding",
	description: "Software engineering agent for code changes, tests, and review loops.",
	systemPrompt: codingSystemPrompt,
	tools: [
		({ env, config, evidenceGateway, getPermissionDecision, getActiveLease, checkpoint }) =>
			createCodingToolRegistrations({
				env,
				config,
				roots: config.sandbox?.roots,
				maxOutputChars: config.sandbox?.maxOutputChars,
				bashTimeoutSeconds: config.sandbox?.bashTimeoutSeconds,
				fetchMaxBytes: config.sandbox?.fetchMaxBytes,
				evidenceGateway,
				getPermissionDecision,
				getActiveLease,
				checkpoint,
				commandRules: config.commandRules,
			}),
	],
	policy: {
		defaults: {
			"read-only": "allow",
			write: "ask",
			destructive: "ask",
			network: "ask",
		},
	},
	thinkingLevel: "high",
	context: {
		compactionInstructions:
			"Preserve file paths, changed files, decisions, commands run, failing tests, reviewer findings, and unresolved blockers.",
	},
	skills: [reviewSkill, fixTestsSkill],
	templates: [],
} satisfies AgentProfile;

export default codingProfile;
