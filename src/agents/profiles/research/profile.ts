import type { ExecutionEnv } from "@earendil-works/pi-agent-core";
import type { EvidenceGateway } from "../../../evidence/index.ts";
import type { AgentProfile } from "../../profile.ts";
import type { ToolPermissionDecisionLookup, ToolRegistration } from "../../../tools/types.ts";
import {
	createFetchTool,
	createGlobTool,
	createGrepTool,
	createLsTool,
	createReadTool,
	type FetchImplementation,
} from "../../../tools/builtin/index.ts";
import { researchSystemPrompt } from "./prompt.ts";

export interface ResearchToolRegistrationOptions {
	env: ExecutionEnv;
	roots?: readonly string[];
	maxOutputChars?: number;
	fetch?: FetchImplementation;
	fetchMaxBytes?: number;
	evidenceGateway?: EvidenceGateway;
	getPermissionDecision?: ToolPermissionDecisionLookup;
}

export function createResearchToolRegistrations(options: ResearchToolRegistrationOptions): ToolRegistration[] {
	return [
		{
			tool: createFetchTool({
				fetch: options.fetch,
				maxBytes: options.fetchMaxBytes,
				evidenceGateway: options.evidenceGateway,
				getPermissionDecision: options.getPermissionDecision,
			}),
			accessLevel: "network",
		},
		{ tool: createReadTool(options), accessLevel: "read-only" },
		{ tool: createLsTool(options), accessLevel: "read-only" },
		{ tool: createGrepTool(options), accessLevel: "read-only" },
		{ tool: createGlobTool(options), accessLevel: "read-only" },
	];
}

export const researchProfile = {
	name: "research",
	description: "Source-first research agent with citations and no write defaults.",
	systemPrompt: researchSystemPrompt,
	tools: [
		({ env, config, evidenceGateway, getPermissionDecision }) =>
			createResearchToolRegistrations({
				env,
				roots: config.sandbox?.roots,
				maxOutputChars: config.sandbox?.maxOutputChars,
				fetchMaxBytes: config.sandbox?.fetchMaxBytes,
				evidenceGateway,
				getPermissionDecision,
			}),
	],
	policy: {
		defaults: {
			"read-only": "allow",
			write: "deny",
			destructive: "deny",
			network: "allow",
		},
	},
	thinkingLevel: "medium",
	context: {
		compactionInstructions: "Preserve sources, URLs, dates, claims, evidence, citations, and unresolved verification gaps.",
	},
	skills: [],
	templates: [],
} satisfies AgentProfile;

export default researchProfile;
