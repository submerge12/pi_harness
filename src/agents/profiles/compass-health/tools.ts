import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
// Static is used implicitly via TypeBox parameter inference
import type { ToolRegistration } from "../../../tools/types.ts";

import type { ToolContext } from "compass-health-agent/tools/context";
import * as handlers from "compass-health-agent/tools/handlers";

// ── Shared context (set by install hook, used by execute closures) ──

let ctx: ToolContext | null = null;

export function setToolContext(context: ToolContext): void {
	ctx = context;
}

export function getToolContext(): ToolContext | null {
	return ctx;
}

function requireCtx(): ToolContext {
	if (!ctx) throw new Error("Compass Health agent not initialized �?install hook has not run.");
	return ctx;
}

// ── Helper: wrap handler result as tool output ──

function jsonResult<T>(result: T): AgentToolResult<T> {
	return {
		content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
		details: result,
	};
}

// ── Parameter schemas ──

const setProfileParams = Type.Object({
	sex: Type.Union([Type.Literal("male"), Type.Literal("female")]),
	ageYears: Type.Number(),
	heightCm: Type.Number(),
	weightKg: Type.Number(),
	activityLevel: Type.Union([
		Type.Literal("sedentary"),
		Type.Literal("lightly_active"),
		Type.Literal("moderately_active"),
		Type.Literal("strength_training"),
	]),
	goal: Type.String(),
});

const nutritionEstimateParams = Type.Object({
	description: Type.String(),
});

const logMealParams = Type.Object({
	date: Type.String(),
	mealType: Type.String(),
	description: Type.String(),
});

const logWaterParams = Type.Object({
	date: Type.String(),
	description: Type.String(),
});

const logExerciseParams = Type.Object({
	date: Type.String(),
	description: Type.String(),
});

const logWeightParams = Type.Object({
	date: Type.String(),
	description: Type.String(),
});

const dailySummaryParams = Type.Object({
	date: Type.String(),
});

const weeklyReportParams = Type.Object({
	endDate: Type.String(),
	sodiumLimitMg: Type.Optional(Type.Number()),
});

const mealCheckinParams = Type.Object({
	date: Type.String(),
	mealType: Type.String(),
	status: Type.Union([
		Type.Literal("followed"),
		Type.Literal("substituted"),
		Type.Literal("skipped"),
	]),
	actualDescription: Type.Optional(Type.String()),
});

const updateCookingRecordParams = Type.Object({
	note: Type.String(),
	recordedAt: Type.Optional(Type.String()),
});

const generateMealPlanParams = Type.Object({
	startDate: Type.Optional(Type.String()),
});

const recipeRecommendParams = Type.Object({
	mealType: Type.String(),
	maxKcal: Type.Optional(Type.Number()),
});

const memoryKind = Type.Union([
	Type.Literal("preference"),
	Type.Literal("dislike"),
	Type.Literal("routine"),
	Type.Literal("note"),
]);

const rememberParams = Type.Object({
	kind: memoryKind,
	subject: Type.String(),
	content: Type.String(),
	sourceText: Type.Optional(Type.String()),
	confidence: Type.Optional(Type.Number()),
});

const recallParams = Type.Object({
	query: Type.String(),
	kinds: Type.Optional(Type.Array(memoryKind)),
	limit: Type.Optional(Type.Number()),
});
const dishMealCategory = Type.Union([
	Type.Literal("breakfast"),
	Type.Literal("main"),
]);

const dishSource = Type.Union([
	Type.Literal("user_nl"),
	Type.Literal("agent_research"),
	Type.Literal("preset"),
]);

const dishDraftIngredientParams = Type.Object({
	name: Type.Optional(Type.String()),
	slug: Type.Optional(Type.String()),
	grams: Type.Number(),
});

const dishDraftParams = Type.Object({
	name: Type.String(),
	mealCategory: dishMealCategory,
	ingredients: Type.Array(dishDraftIngredientParams),
	seasonings: Type.Optional(Type.Array(Type.String())),
	method: Type.Optional(Type.String()),
	source: dishSource,
	notes: Type.Optional(Type.String()),
});

const proposeDishParams = Type.Object({
	naturalLanguage: Type.Optional(Type.String()),
	draft: Type.Optional(dishDraftParams),
});

const dishNutritionParams = Type.Object({
	kcal: Type.Number(),
	proteinGrams: Type.Number(),
	carbsGrams: Type.Number(),
	fatGrams: Type.Number(),
	sodiumMg: Type.Number(),
});

const resolvedDishIngredientParams = Type.Object({
	slug: Type.String(),
	grams: Type.Number(),
});

const saveDishParams = Type.Object({
	name: Type.String(),
	mealCategory: dishMealCategory,
	ingredients: Type.Array(resolvedDishIngredientParams),
	seasonings: Type.Array(Type.String()),
	method: Type.Optional(Type.String()),
	source: dishSource,
	notes: Type.Optional(Type.String()),
	slug: Type.String(),
	nutrition: dishNutritionParams,
	buckets: Type.Array(Type.String()),
	roles: Type.Array(Type.String()),
	unresolved: Type.Array(Type.String()),
});

// ── Tool registrations ──

export function createCompassHealthToolRegistrations(): ToolRegistration<any, any>[] {
	return [
		// ── Write tools ──
		{
			tool: {
				name: "set_profile",
				label: "Set Profile",
				description: "Set or update the user's physical profile and compute calorie/macro targets.",
				parameters: setProfileParams,
				async execute(_toolCallId, params: any) {
					return jsonResult(await handlers.handleSetProfile(requireCtx(), params));
				},
			},
			accessLevel: "write",
		},
		{
			tool: {
				name: "log_meal",
				label: "Log Meal",
				description: "Log a meal and estimate its nutrition from a food description.",
				parameters: logMealParams,
				async execute(_toolCallId, params: any) {
					return jsonResult(await handlers.handleLogMeal(requireCtx(), params));
				},
			},
			accessLevel: "write",
		},
		{
			tool: {
				name: "log_water",
				label: "Log Water",
				description: "Log water intake. Understands ml, cups, and Chinese units (�?.",
				parameters: logWaterParams,
				async execute(_toolCallId, params: any) {
					return jsonResult(await handlers.handleLogWater(requireCtx(), params));
				},
			},
			accessLevel: "write",
		},
		{
			tool: {
				name: "log_exercise",
				label: "Log Exercise",
				description: "Log exercise activity. Parses activity type and duration from description.",
				parameters: logExerciseParams,
				async execute(_toolCallId, params: any) {
					return jsonResult(await handlers.handleLogExercise(requireCtx(), params));
				},
			},
			accessLevel: "write",
		},
		{
			tool: {
				name: "log_weight",
				label: "Log Weight",
				description: "Log body weight. Parses kg from description.",
				parameters: logWeightParams,
				async execute(_toolCallId, params: any) {
					return jsonResult(await handlers.handleLogWeight(requireCtx(), params));
				},
			},
			accessLevel: "write",
		},
		{
			tool: {
				name: "meal_checkin",
				label: "Meal Check-in",
				description: "Record whether a planned meal was followed, substituted, or skipped.",
				parameters: mealCheckinParams,
				async execute(_toolCallId, params: any) {
					return jsonResult(await handlers.handleMealCheckin(requireCtx(), params));
				},
			},
			accessLevel: "write",
		},
		{
			tool: {
				name: "update_cooking_record",
				label: "Cooking Record",
				description: "Save or update a cooking record from a free-text note.",
				parameters: updateCookingRecordParams,
				async execute(_toolCallId, params: any) {
					return jsonResult(await handlers.handleUpdateCookingRecord(requireCtx(), params));
				},
			},
			accessLevel: "write",
		},

		{
			tool: {
				name: "generate_meal_plan",
				label: "Meal Plan",
				description: "Generate a 7-day meal plan using preset dishes and the user's calorie targets.",
				parameters: generateMealPlanParams,
				async execute(_toolCallId, params: any) {
					return jsonResult(await handlers.handleSmartGenerateMealPlan(requireCtx(), params));
				},
			},
			accessLevel: "write",
		},
		{
			tool: {
				name: "remember",
				label: "Remember",
				description: "Store a durable user preference, dislike, routine, or note.",
				parameters: rememberParams,
				async execute(_toolCallId, params: any) {
					return jsonResult(await handlers.handleRemember(requireCtx(), params));
				},
			},
			accessLevel: "write",
		},
		{
			tool: {
				name: "save_dish",
				label: "Save Dish",
				description: "Persist an approved user dish so it becomes a meal-plan candidate.",
				parameters: saveDishParams,
				async execute(_toolCallId, params: any) {
					return jsonResult(await handlers.handleSaveDish(requireCtx(), params));
				},
			},
			accessLevel: "write",
		},
		// ── Read-only tools ──
		{
			tool: {
				name: "nutrition_estimate",
				label: "Nutrition Estimate",
				description: "Estimate nutrition for a food description without logging anything.",
				parameters: nutritionEstimateParams,
				async execute(_toolCallId, params: any) {
					return jsonResult(await handlers.handleNutritionEstimate(requireCtx(), params));
				},
			},
			accessLevel: "read-only",
		},
		{
			tool: {
				name: "daily_summary",
				label: "Daily Summary",
				description: "Summarise one day of logged nutrition, water, and exercise against targets.",
				parameters: dailySummaryParams,
				async execute(_toolCallId, params: any) {
					return jsonResult(await handlers.handleDailySummary(requireCtx(), params));
				},
			},
			accessLevel: "read-only",
		},
		{
			tool: {
				name: "recipe_recommend",
				label: "Recipe Recommend",
				description: "Recommend recipes for a meal type from preset dishes and cooking records.",
				parameters: recipeRecommendParams,
				async execute(_toolCallId, params: any) {
					return jsonResult(await handlers.handleSmartRecipeRecommend(requireCtx(), params));
				},
			},
			accessLevel: "read-only",
		},
		{
			tool: {
				name: "weekly_report",
				label: "Weekly Report",
				description: "Aggregate the last 7 days into a weekly nutrition report with trends.",
				parameters: weeklyReportParams,
				async execute(_toolCallId, params: any) {
					return jsonResult(await handlers.handleWeeklyReport(requireCtx(), params));
				},
			},
			accessLevel: "read-only",
		},
		{
			tool: {
				name: "recall",
				label: "Recall",
				description: "Recall durable user preferences, dislikes, routines, and notes.",
				parameters: recallParams,
				async execute(_toolCallId, params: any) {
					return jsonResult(await handlers.handleRecall(requireCtx(), params));
				},
			},
			accessLevel: "read-only",
		},
		{
			tool: {
				name: "propose_dish",
				label: "Propose Dish",
				description: "Review a proposed user dish with resolved ingredients and computed nutrition without saving it.",
				parameters: proposeDishParams,
				async execute(_toolCallId, params: any) {
					return jsonResult(await handlers.handleProposeDish(requireCtx(), params));
				},
			},
			accessLevel: "read-only",
		},
	];
}
