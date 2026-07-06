import { describe, expect, it, vi } from "vitest";

// Framework e2e for CHA-MPV2-9 / Change 3 (as amended): drives the REAL
// compass-health-agent handleSwapMeal through the pi-harness registration
// path (permission decision -> handler -> write-scope evidence receipt).
// Skips when the optional compass-health-agent package is not installed
// (the public-clone CI matrix); everything else in this file must run
// against the package's built dist, not a mock.
const chaHandlers = await import("compass-health-agent/tools/handlers").then(
	(module) => module,
	() => null,
);

// The reviewed CHA A2 fixture (tests/handlers/swap-meal.test.ts): a light
// default day where chaoshan_beef_soup is in the week's selected pool and
// lever-valid, while black_pepper_chicken_breast is a real catalog main that
// is lever-valid but OUTSIDE the pool — isolating pool membership as the gate.
const TEST_DATE = "2026-07-08";

type EntryRow = Record<string, unknown> & { id: string; planDate: string; mealType: string; status: string };

function row(id: string, mealType: string, kcal: number, proteinGrams: number): EntryRow {
	return {
		id,
		userId: "user-id",
		planDate: TEST_DATE,
		mealType,
		dishName: mealType,
		recipeSlug: mealType === "lunch" ? "chicken_carrot_rice" : `${mealType}_dish`,
		status: "planned",
		ingredientsJson: [],
		seasoningsJson: [],
		caloriesKcal: kcal,
		proteinGrams,
		carbsGrams: 50,
		fatGrams: 15,
		sodiumMg: 500,
	};
}

function catalogRecord(
	slug: string,
	kcalPer100g: number,
	proteinGramsPer100g: number,
	carbsGramsPer100g: number,
	fatGramsPer100g: number,
	sodiumMgPer100g: number,
): Record<string, unknown> {
	return {
		slug,
		weightType: "raw",
		defaultGrams: null,
		defaultUnit: null,
		kcalPer100g,
		proteinGramsPer100g,
		carbsGramsPer100g,
		fatGramsPer100g,
		sodiumMgPer100g,
	};
}

const CATALOG = {
	foods: [
		catalogRecord("beef_tenderloin", 107, 22.2, 2.4, 0.9, 75.1),
		catalogRecord("scallion", 32, 1.8, 7.3, 0.2, 16),
		catalogRecord("chicken_breast", 118, 19.4, 2.5, 5, 34.4),
		catalogRecord("onion", 40, 1.1, 9.3, 0.1, 4),
		catalogRecord("egg", 139, 13.1, 2.4, 8.6, 131.5),
		catalogRecord("tofu", 84, 6.6, 3.4, 5.3, 5.6),
		catalogRecord("soy_milk", 33, 3, 1.8, 1.6, 3),
		catalogRecord("yogurt_high_protein", 63, 11, 4.5, 0, 38),
		catalogRecord("brown_rice", 348, 7.7, 75, 2.7, 5.4),
		catalogRecord("broccoli", 27, 3.5, 3.7, 0.6, 46.7),
		catalogRecord("bok_choy", 14, 1.4, 2.4, 0.3, 132.2),
		catalogRecord("shiitake_fresh", 26, 2.2, 5.2, 0.3, 1.4),
		catalogRecord("olive_oil", 884, 0, 0, 99.9, 2),
	],
	naturalUnits: [],
};

function makeContext(options: {
	updates: { entryId: string; data: Record<string, unknown> }[];
	rows?: EntryRow[];
	rangeRows?: EntryRow[];
	statusUpdates?: { entryId: string; status: string }[];
	mutateRowsOnUpdate?: boolean;
}) {
	const rows = options.rows ?? [
		row("row-breakfast", "breakfast", 450, 28),
		row("row-lunch", "lunch", 520, 32),
		row("row-dinner", "dinner", 560, 35),
	];
	return {
		userId: "user-id",
		locale: "en",
		catalog: CATALOG,
		seasoningRecords: [],
		repo: {
			getLatestBmrProfile: async () => ({
				targetKcal: 1771,
				proteinTargetGrams: 140,
				fatTargetGrams: 49,
				carbsTargetGrams: 192,
			}),
			listUserDishes: async () => [],
			listActiveMemories: async () => [],
			listRejectedSeasoningSlugs: async () => [],
			listMealPlanEntriesRange: async (_userId: string, startDate: string, endDate: string) =>
				(options.rangeRows ?? []).filter((item) => item.planDate >= startDate && item.planDate <= endDate),
			listDietLogsRange: async () => [],
			listMealPlanEntries: async (_userId: string, date?: string) =>
				rows.filter((item) => item.planDate === date),
			updateMealPlanEntryDish: async (entryId: string, data: Record<string, unknown>) => {
				options.updates.push({ entryId, data });
				if (options.mutateRowsOnUpdate === true) {
					const stored = rows.find((item) => item.id === entryId);
					if (stored !== undefined) Object.assign(stored, data);
				}
			},
			updateMealPlanStatus: async (entryId: string, status: string) => {
				options.statusUpdates?.push({ entryId, status });
			},
			insertDietLog: async () => ({ id: "diet-log-1" }),
		},
		close: async () => undefined,
	};
}

async function frameworkSwapMeal(context: ReturnType<typeof makeContext>) {
	const { createCompassHealthToolRegistrations, setToolContext } = await import(
		"../../src/agents/profiles/compass-health/tools.ts"
	);
	setToolContext(context as never);

	const receipts: any[] = [];
	const evidenceGateway = {
		captureOutput: vi.fn(async (input: any) => {
			receipts.push(input);
			return input;
		}),
		captureCommand: vi.fn(),
	};
	const registrations = createCompassHealthToolRegistrations({
		evidenceGateway,
		getPermissionDecision: vi.fn(() => ({
			subject: "swap_meal",
			allowed: { level: "allow" as const, ruleId: "test-allow" },
			writeScope: ["compass-health-agent://database/compass_health/meal_plan_entries"],
		})),
	} as never);
	const swapMeal = registrations.find((registration) => registration.tool.name === "swap_meal");
	if (!swapMeal) throw new Error("expected swap_meal tool registration");
	const mealCheckin = registrations.find((registration) => registration.tool.name === "meal_checkin");
	if (!mealCheckin) throw new Error("expected meal_checkin tool registration");
	return { swapMeal, mealCheckin, receipts };
}

describe.skipIf(!chaHandlers)("swap_meal framework e2e (Change 3 as amended, real handlers)", () => {
	it("persists a swap to a pre-vetted alternate through the framework path and keeps the day lever-valid", async () => {
		const updates: { entryId: string; data: Record<string, unknown> }[] = [];
		const statusUpdates: { entryId: string; status: string }[] = [];
		const context = makeContext({ updates, statusUpdates, mutateRowsOnUpdate: true });
		const { swapMeal, mealCheckin, receipts } = await frameworkSwapMeal(context);

		const result = await swapMeal.tool.execute("call-swap-accept", {
			date: TEST_DATE,
			mealType: "lunch",
			alternateSlug: "chaoshan_beef_soup",
		});

		const details = result.details as any;
		expect(details.entryId).toBe("row-lunch");
		expect(details.newDish.slug).toBe("chaoshan_beef_soup");
		// The day stays lever-valid after the swap.
		expect(details.withinEnergyBand).toBe(true);
		expect(details.meetsProteinFloor).toBe(true);

		// Persisted through the repository layer: meal_plan_entries row updated.
		expect(updates).toHaveLength(1);
		expect(updates[0]?.entryId).toBe("row-lunch");
		expect(updates[0]?.data["recipeSlug"]).toBe("chaoshan_beef_soup");

		// The framework's runtime write-scope receipt names meal_plan_entries.
		expect(receipts).toHaveLength(1);
		expect(receipts[0]).toMatchObject({
			command: "compass-health domain write: swap_meal",
			subject: "compass-health-agent://database/compass_health/meal_plan_entries",
			actualWritePaths: ["compass-health-agent://database/compass_health/meal_plan_entries"],
		});

		// meal_checkin still attaches to the swapped entry (round-trip).
		const checkin = await mealCheckin.tool.execute("call-checkin", {
			date: TEST_DATE,
			mealType: "lunch",
			status: "followed",
		});
		expect((checkin.details as any).entryId).toBe("row-lunch");
		expect(statusUpdates).toEqual([{ entryId: "row-lunch", status: "followed" }]);
	});

	it("rejects a lever-valid main outside the week's selected pool through the framework with nothing written", async () => {
		const updates: { entryId: string; data: Record<string, unknown> }[] = [];
		const context = makeContext({ updates });
		const { swapMeal, receipts } = await frameworkSwapMeal(context);

		await expect(swapMeal.tool.execute("call-swap-outside-pool", {
			date: TEST_DATE,
			mealType: "lunch",
			alternateSlug: "black_pepper_chicken_breast",
		})).rejects.toThrow(/not one of this entry's pre-vetted alternates: it is outside this week's selected pool/);

		expect(updates).toEqual([]);
		expect(receipts).toEqual([]);
	});

	it("rejects a target already planned on the adjacent day with nothing written", async () => {
		const updates: { entryId: string; data: Record<string, unknown> }[] = [];
		const context = makeContext({
			updates,
			rangeRows: [
				{ ...row("row-next-lunch", "lunch", 520, 32), planDate: "2026-07-09", recipeSlug: "chaoshan_beef_soup" },
			],
		});
		const { swapMeal, receipts } = await frameworkSwapMeal(context);

		await expect(swapMeal.tool.execute("call-swap-adjacent", {
			date: TEST_DATE,
			mealType: "lunch",
			alternateSlug: "chaoshan_beef_soup",
		})).rejects.toThrow(/not one of this entry's pre-vetted alternates/);

		expect(updates).toEqual([]);
		expect(receipts).toEqual([]);
	});
});
