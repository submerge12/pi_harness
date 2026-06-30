import { Value } from "typebox/value";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const ctx = { close: vi.fn(async () => undefined) };
	const spec = {
		name: "compass-health" as const,
		description: "delegated compass description",
		systemPrompt: "delegated compass prompt",
		model: { provider: "deepseek" as const, modelId: "delegated-model" },
		thinkingLevel: "medium" as const,
		policy: {
			defaults: {
				"read-only": "allow" as const,
				write: "allow" as const,
				destructive: "deny" as const,
				network: "deny" as const,
			},
		},
		context: { compactionInstructions: "delegated compaction" },
		scheduledTasks: [{
			id: "delegated-task",
			agentProfile: "compass-health" as const,
			taskType: "proactive_check" as const,
			schedule: { cron: "0 9 * * *" },
		}],
	};
	return {
		ctx,
		spec,
		createToolContextFromEnv: vi.fn(async () => ctx),
		handleProactiveCheck: vi.fn(async () => ({ message: "delegated proactive message" })),
		handleGetProfile: vi.fn(async (): Promise<{ profile: { targetKcal: number } | null }> => ({
			profile: { targetKcal: 1800 },
		})),
	};
});

vi.mock("compass-health-agent", () => ({
	compassHealthProfileSpec: mocks.spec,
	createToolContextFromEnv: mocks.createToolContextFromEnv,
}));

vi.mock("compass-health-agent/tools/handlers", () => ({
	handleGetProfile: mocks.handleGetProfile,
	handleProactiveCheck: mocks.handleProactiveCheck,
}));

afterEach(async () => {
	vi.clearAllMocks();
	const { clearProfilesForTests } = await import("../../src/agents/registry.ts");
	clearProfilesForTests();
});

describe("compass health profile adapter", () => {
	it("delegates profile metadata, installation, and proactive checks to compass-health-agent", async () => {
		const { compassHealthProfile } = await import("../../src/agents/profiles/compass-health/profile.ts");
		const { getToolContext } = await import("../../src/agents/profiles/compass-health/tools.ts");

		expect(compassHealthProfile.description).toBe(mocks.spec.description);
		expect(compassHealthProfile.systemPrompt).toBe(mocks.spec.systemPrompt);
		expect(compassHealthProfile.model).toEqual(mocks.spec.model);
		expect(compassHealthProfile.policy).toEqual(mocks.spec.policy);
		expect(compassHealthProfile.context).toEqual(mocks.spec.context);
		expect(compassHealthProfile.scheduledTasks).toEqual(mocks.spec.scheduledTasks);

		if (!compassHealthProfile.install || !compassHealthProfile.proactiveCheck) {
			throw new Error("expected compass health profile lifecycle hooks");
		}
		const fakeHarness = {} as Parameters<typeof compassHealthProfile.install>[0];
		const fakeContext = {} as Parameters<typeof compassHealthProfile.proactiveCheck>[0];
		const dispose = await compassHealthProfile.install(fakeHarness);
		expect(mocks.createToolContextFromEnv).toHaveBeenCalledTimes(1);
		expect(getToolContext()).toBe(mocks.ctx);

		await expect(compassHealthProfile.proactiveCheck(fakeContext)).resolves.toBe("delegated proactive message");
		expect(mocks.handleProactiveCheck).toHaveBeenCalledWith(mocks.ctx);

		await dispose?.();
		expect(mocks.ctx.close).toHaveBeenCalledTimes(1);
	});

	it("keeps compass-health registered through the built-in profile registry", async () => {
		const { registerBuiltInProfiles } = await import("../../src/agents/profiles/index.ts");
		const { listProfiles } = await import("../../src/agents/registry.ts");

		registerBuiltInProfiles();

		expect(listProfiles()).toContainEqual({
			name: "compass-health",
			description: mocks.spec.description,
		});
	});

	it("constrains set_profile goal to canonical goal values", async () => {
		const { createCompassHealthToolRegistrations } = await import(
			"../../src/agents/profiles/compass-health/tools.ts"
		);

		const registrations = createCompassHealthToolRegistrations();
		const setProfile = registrations.find((registration) => registration.tool.name === "set_profile");
		if (!setProfile) throw new Error("expected set_profile tool registration");

		const setProfileSchema = setProfile.tool.parameters as any;
		const goalSchema = setProfileSchema.properties.goal as { anyOf?: Array<{ const?: string }> };
		const emittedGoalConstants = (goalSchema.anyOf ?? []).map((variant) => variant.const);
		const canonicalGoals = [
			"improve_health",
			"body_recomp",
			"fat_loss_slow",
			"fat_loss_moderate",
			"fat_loss_fast",
			"muscle_gain_slow",
			"muscle_gain_moderate",
			"muscle_gain_fast",
		];
		const validProfile = {
			sex: "female",
			ageYears: 35,
			heightCm: 165,
			weightKg: 68,
			activityLevel: "moderately_active",
			goal: "fat_loss_moderate",
		};

		expect(new Set(emittedGoalConstants)).toEqual(new Set(canonicalGoals));
		expect(emittedGoalConstants).toHaveLength(canonicalGoals.length);
		expect(setProfile.tool.description).toContain("canonical value");
		expect(setProfile.tool.description).toContain("slow/moderate/fast");
		expect(setProfile.tool.description).toContain("fat_loss_moderate");
		for (const goal of canonicalGoals) {
			expect(Value.Check(setProfileSchema, { ...validProfile, goal })).toBe(true);
		}
		expect(Value.Check(setProfileSchema, { ...validProfile, goal: "fat_loss_extreme" })).toBe(false);
	});

	it("exposes current compass-health tool surface metadata", async () => {
		const { createCompassHealthToolRegistrations, setToolContext } = await import(
			"../../src/agents/profiles/compass-health/tools.ts"
		);
		setToolContext(mocks.ctx as never);

		const registrations = createCompassHealthToolRegistrations();
		const getProfile = registrations.find((registration) => registration.tool.name === "get_profile");
		mocks.handleGetProfile
			.mockResolvedValueOnce({ profile: { targetKcal: 1800 } })
			.mockResolvedValueOnce({ profile: null });

		expect(getProfile?.accessLevel).toBe("read-only");
		expect(getProfile?.tool.parameters).toMatchObject({ type: "object", properties: {} });
		expect(((getProfile?.tool.parameters as any).required ?? [])).toEqual([]);
		await expect(getProfile?.tool.execute("call-1", {})).resolves.toMatchObject({
			details: { profile: { targetKcal: 1800 } },
		});
		await expect(getProfile?.tool.execute("call-2", {})).resolves.toMatchObject({
			details: { profile: null },
		});
		expect(mocks.handleGetProfile).toHaveBeenNthCalledWith(1, mocks.ctx, {});
		expect(mocks.handleGetProfile).toHaveBeenNthCalledWith(2, mocks.ctx, {});

		const proposeDish = registrations.find((registration) => registration.tool.name === "propose_dish");
		const saveDish = registrations.find((registration) => registration.tool.name === "save_dish");
		const proposeDishDraftSchema = (proposeDish?.tool.parameters as any).properties.draft;
		const saveDishSchema = saveDish?.tool.parameters as any;

		for (const schema of [proposeDishDraftSchema, saveDishSchema]) {
			for (const field of ["role", "sideKind", "selfContained"]) {
				expect(schema.properties).toHaveProperty(field);
				expect(schema.required ?? []).not.toContain(field);
			}
		}
		for (const schema of [proposeDishDraftSchema, saveDishSchema]) {
			expect(schema.properties.seasonings).toMatchObject({
				type: "array",
				items: { type: "string" },
			});
			expect(schema.required ?? []).toContain("seasonings");
		}
	});
});
