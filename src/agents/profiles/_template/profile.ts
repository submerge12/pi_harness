import type { AgentProfile } from "../../profile.ts";
import { systemPrompt } from "./prompt.ts";

export const profile = {
	name: "__AGENT_NAME__",
	description: "Describe the agent's narrow mission and primary workflow.",
	systemPrompt,
	tools: [],
	policy: {
		defaults: {
			"read-only": "allow",
			write: "ask",
			destructive: "ask",
			network: "ask",
		},
	},
	model: {
		provider: "deepseek",
		modelId: "deepseek-v4-pro",
	},
	thinkingLevel: "medium",
	context: {
		compactionInstructions:
			"Preserve the agent mission, user constraints, tool decisions, unresolved blockers, and final output requirements.",
	},
	skills: [],
	templates: [],
} satisfies AgentProfile;

export default profile;
