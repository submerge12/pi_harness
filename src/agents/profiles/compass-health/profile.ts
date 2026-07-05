import { compassHealthProfileSpec, createToolContextFromEnv } from "compass-health-agent";
import * as handlers from "compass-health-agent/tools/handlers";
import type { AgentProfile } from "../../profile.ts";
import { createCompassHealthToolRegistrations, getToolContext, setToolContext } from "./tools.ts";

export { createCompassHealthToolRegistrations } from "./tools.ts";

const compassHealthProfileAdapter = {
	name: compassHealthProfileSpec.name,
	description: compassHealthProfileSpec.description,
	systemPrompt: compassHealthProfileSpec.systemPrompt,
	model: compassHealthProfileSpec.model,
	thinkingLevel: compassHealthProfileSpec.thinkingLevel,
	policy: compassHealthProfileSpec.policy,
	context: compassHealthProfileSpec.context,
	scheduledTasks: compassHealthProfileSpec.scheduledTasks,
	tools: [(context) => createCompassHealthToolRegistrations(context)],
	proactiveCheck: async (): Promise<string> => {
		const ctx = getToolContext();
		if (!ctx) return "Compass Health agent not initialized.";
		return (await handlers.handleProactiveCheck(ctx)).message;
	},
	install: async () => {
		const ctx = await createToolContextFromEnv();
		setToolContext(ctx);
		return async () => {
			await ctx.close();
		};
	},
	skills: [],
	templates: [],
} satisfies AgentProfile;

export const compassHealthProfile = compassHealthProfileAdapter as AgentProfile;

export default compassHealthProfile;
