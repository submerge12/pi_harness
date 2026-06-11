import type { ExecutionEnv } from "@earendil-works/pi-agent-core";
import { join } from "node:path";
import type { AgentProfile } from "../../profile.ts";
import type { ToolRegistration } from "../../../tools/types.ts";
import {
	createGlobTool,
	createGrepTool,
	createLsTool,
	createReadTool,
	createWriteTool,
} from "../../../tools/builtin/index.ts";
import { dataAnalysisSystemPrompt } from "./prompt.ts";

export interface DataAnalysisToolRegistrationOptions {
	env: ExecutionEnv;
	roots?: readonly string[];
	maxOutputChars?: number;
}

function outputRelativePath(filePath: string): string {
	const normalized = filePath.replace(/\\/g, "/");
	if (!normalized.startsWith("outputs/")) throw new Error("Data-analysis writes must target outputs/ paths");
	const relative = normalized.slice("outputs/".length);
	if (!relative || relative === "." || relative === ".." || relative.startsWith("../")) {
		throw new Error("Data-analysis writes must target files inside outputs/");
	}
	return relative;
}

function createOutputsWriteTool(options: DataAnalysisToolRegistrationOptions): ReturnType<typeof createWriteTool> {
	const tool = createWriteTool({
		env: options.env,
		roots: [join(options.env.cwd, "outputs")],
	});
	return {
		...tool,
		description: "Creates or overwrites a UTF-8 text file inside the outputs directory.",
		async execute(toolCallId, params, signal, onUpdate) {
			return await tool.execute(toolCallId, { ...params, path: outputRelativePath(params.path) }, signal, onUpdate);
		},
	};
}

export function createDataAnalysisToolRegistrations(options: DataAnalysisToolRegistrationOptions): ToolRegistration[] {
	return [
		{ tool: createReadTool(options), accessLevel: "read-only" },
		{ tool: createLsTool(options), accessLevel: "read-only" },
		{ tool: createGrepTool(options), accessLevel: "read-only" },
		{ tool: createGlobTool(options), accessLevel: "read-only" },
		{ tool: createOutputsWriteTool(options), accessLevel: "write" },
	];
}

export const dataAnalysisProfile = {
	name: "data-analysis",
	description: "Deterministic local data-analysis agent with guarded filesystem access.",
	systemPrompt: dataAnalysisSystemPrompt,
	tools: [
		({ env, config }) =>
			createDataAnalysisToolRegistrations({
					env,
					roots: config.sandbox?.roots,
					maxOutputChars: config.sandbox?.maxOutputChars,
				}),
	],
	policy: {
		defaults: {
			"read-only": "allow",
			write: "ask",
			destructive: "deny",
			network: "deny",
		},
	},
	thinkingLevel: "medium",
	context: {
		compactionInstructions:
			"Preserve dataset schemas, filters, assumptions, formulas, derived metrics, output paths, and validation state.",
	},
	skills: [],
	templates: [],
} satisfies AgentProfile;

export default dataAnalysisProfile;
