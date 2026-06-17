import type { AgentProfile } from "../../profile.ts";
import type { ScheduledTaskDefinition } from "../../../scheduler/types.ts";
import { systemPrompt } from "./prompt.ts";
import { createCompassHealthToolRegistrations, setToolContext, getToolContext } from "./tools.ts";

import { initToolContext } from "compass-health-agent/tools/context";
import * as handlers from "compass-health-agent/tools/handlers";

export { createCompassHealthToolRegistrations } from "./tools.ts";

const PROFILE_NAME = "compass-health";

const scheduledTasks: readonly ScheduledTaskDefinition[] = [
	{
		id: "compass-health:meal_checkin_breakfast",
		agentProfile: PROFILE_NAME,
		taskType: "proactive_check",
		schedule: { cron: "30 8 * * *" },
	},
	{
		id: "compass-health:meal_checkin_lunch",
		agentProfile: PROFILE_NAME,
		taskType: "proactive_check",
		schedule: { cron: "30 12 * * *" },
	},
	{
		id: "compass-health:meal_checkin_dinner",
		agentProfile: PROFILE_NAME,
		taskType: "proactive_check",
		schedule: { cron: "30 18 * * *" },
	},
	{
		id: "compass-health:midnight_daily_summary",
		agentProfile: PROFILE_NAME,
		taskType: "proactive_check",
		schedule: { cron: "0 0 * * *" },
	},
];

function todayIso(): string {
	return new Date().toISOString().slice(0, 10);
}

function yesterdayIso(): string {
	const d = new Date();
	d.setDate(d.getDate() - 1);
	return d.toISOString().slice(0, 10);
}

async function proactiveCheck(): Promise<string> {
	const ctx = getToolContext();
	if (!ctx) return "Compass Health agent not initialized.";

	const hour = new Date().getHours();
	const today = todayIso();

	if (hour >= 23 || hour < 1) {
		const summary = await handlers.handleDailySummary(ctx, { date: yesterdayIso() });
		return `Daily summary for ${summary.date}: ${summary.eaten.kcal} kcal eaten (target ${summary.target.kcal}), ${summary.remaining.kcal} kcal remaining. Water: ${summary.water.totalMl}ml. Exercise: ${summary.exercise.kcalBurned} kcal burned.`;
	}

	const mealType = hour < 10 ? "breakfast" : hour < 14 ? "lunch" : "dinner";
	const entries = await ctx.repo.listMealPlanEntries(ctx.userId, today);
	const planned = entries.find((e) => e.mealType === mealType && e.status === "planned");
	if (!planned) return `No planned ${mealType} for ${today}.`;

	return `Meal check-in: your planned ${mealType} is「${planned.dishName}」(${planned.caloriesKcal} kcal, ${planned.proteinGrams}g protein). Did you follow the plan, substitute, or skip?`;
}

export const compassHealthProfile = {
	name: PROFILE_NAME,
	description: "Bilingual health and nutrition agent: meal logging, calorie tracking, weekly meal plans.",
	systemPrompt,
	tools: [
		() => createCompassHealthToolRegistrations(),
	],
	policy: {
		defaults: {
			"read-only": "allow",
			write: "allow",
			destructive: "deny",
			network: "deny",
		},
	},
	model: {
		provider: "deepseek",
		modelId: "deepseek-v4-pro",
	},
	thinkingLevel: "medium",
	context: {
		compactionInstructions:
			"Preserve the user's profile (sex, age, height, weight, goal), today's logged meals and their nutrition, daily targets, and any pending meal-plan check-ins.",
	},
	scheduledTasks,
	proactiveCheck: async () => proactiveCheck(),
	install: async () => {
		const userId = process.env["COMPASS_HEALTH_USER_ID"] ?? "default-user";
		const locale = (process.env["COMPASS_HEALTH_LOCALE"] ?? "zh") as "zh" | "en";
		const databaseUrl = process.env["COMPASS_HEALTH_DATABASE_URL"] ?? process.env["DATABASE_URL"];

		const ctx = await initToolContext({
			externalUserId: userId,
			locale,
			databaseUrl,
		});
		setToolContext(ctx);

		return async () => {
			await ctx.close();
		};
	},
	skills: [],
	templates: [],
} satisfies AgentProfile;

export default compassHealthProfile;
