import type { ExecutionEnv } from "@earendil-works/pi-agent-core";
import type { AgentProfile } from "../../profile.ts";
import type { ToolRegistration } from "../../../tools/types.ts";
import {
	createBashTool,
	createEditTool,
	createFetchTool,
	createGlobTool,
	createGrepTool,
	createLsTool,
	createReadTool,
	createWriteTool,
	type FetchImplementation,
} from "../../../tools/builtin/index.ts";
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
			tool: createBashTool({ ...options, defaultTimeoutSeconds: options.bashTimeoutSeconds }),
			accessLevel: "destructive",
		},
		{ tool: createFetchTool({ fetch: options.fetch, maxBytes: options.fetchMaxBytes }), accessLevel: "network" },
	];
}

export const codingProfile = {
	name: "coding",
	description: "Software engineering agent for code changes, tests, and review loops.",
	systemPrompt: codingSystemPrompt,
	tools: [
		({ env, config }) =>
			createCodingToolRegistrations({
				env,
				roots: config.sandbox?.roots,
				maxOutputChars: config.sandbox?.maxOutputChars,
				bashTimeoutSeconds: config.sandbox?.bashTimeoutSeconds,
				fetchMaxBytes: config.sandbox?.fetchMaxBytes,
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
