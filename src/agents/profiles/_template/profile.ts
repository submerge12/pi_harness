import { DEFAULT_MODEL_PROFILE } from "../../../model-profiles/registry.ts";
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
		provider: DEFAULT_MODEL_PROFILE.provider,
		modelId: DEFAULT_MODEL_PROFILE.modelId,
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
