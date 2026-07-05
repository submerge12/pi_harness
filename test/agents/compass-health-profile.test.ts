import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
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
		handleProactiveCheck: vi.fn(async () => ({
			message: "\u{1F9CA} Thaw reminder: delegated localized thaw message",
		})),
		handleGetProfile: vi.fn(async (): Promise<{ profile: { targetKcal: number } | null }> => ({
			profile: { targetKcal: 1800 },
		})),
		handleLogMeal: vi.fn(async () => ({
			log: { id: "diet-log-1", mealType: "lunch" },
			nutrition: { kcal: 330, proteinGrams: 62 },
		})),
		handleRemember: vi.fn(async (): Promise<any> => ({
			status: "remembered" as const,
			memory: { id: "memory-1", kind: "preference", subject: "breakfast" },
		})),
		handleRecall: vi.fn(async () => ({
			memories: [{ id: "memory-1", kind: "preference", subject: "breakfast" }],
		})),
	};
});

vi.mock("compass-health-agent", () => ({
	compassHealthProfileSpec: mocks.spec,
	createToolContextFromEnv: mocks.createToolContextFromEnv,
}));

vi.mock("compass-health-agent/tools/handlers", () => ({
	handleGetProfile: mocks.handleGetProfile,
	handleLogMeal: mocks.handleLogMeal,
	handleRemember: mocks.handleRemember,
	handleRecall: mocks.handleRecall,
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

		await expect(compassHealthProfile.proactiveCheck(fakeContext)).resolves.toBe(
			"\u{1F9CA} Thaw reminder: delegated localized thaw message",
		);
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

	it("keeps the profile as a thin source-of-truth adapter", () => {
		const profilePath = join(process.cwd(), "src/agents/profiles/compass-health/profile.ts");
		const promptPath = join(process.cwd(), "src/agents/profiles", "compass-health", "prompt.ts");
		const source = readFileSync(profilePath, "utf8");
		const duplicatedMeatConstant = ["MEAT", "SLUGS"].join("_");
		const duplicatedMeatFinder = ["findMeat", "Ingredients"].join("");
		const promptImportPattern = `from ["']\\.${"/"}prompt`;

		expect(source).toContain("compassHealthProfileSpec");
		expect(source).toContain("createToolContextFromEnv");
		expect(source).toContain("handlers.handleProactiveCheck");
		expect(source).toContain("satisfies AgentProfile");
		expect(source).not.toContain("compassHealthProfile: AgentProfile");
		expect(source).not.toMatch(new RegExp([
			duplicatedMeatConstant,
			duplicatedMeatFinder,
			promptImportPattern,
		].join("|")));
		expect(existsSync(promptPath)).toBe(false);
	});

	it("records sanitized evidence receipts for successful compass-health domain writes", async () => {
		const { createCompassHealthToolRegistrations, setToolContext } = await import(
			"../../src/agents/profiles/compass-health/tools.ts"
		);
		const entries: any[] = [];
		const evidenceGateway = {
			captureOutput: vi.fn(async (input: any) => {
				const entry = {
					id: input.id,
					command: input.command,
					subject: input.subject,
					allowed: input.allowed,
					writeScope: input.writeScope,
					actualWritePaths: input.actualWritePaths,
					exitCode: input.exitCode ?? 0,
					stdoutRef: ".evidence-local/test/stdout",
					stderrRef: ".evidence-local/test/stderr",
					bytes: { stdout: 0, stderr: 0, total: 0 },
					binary: false,
					truncated: false,
					sha256: "sha256",
					stderrSha256: "stderr-sha256",
					redactions: 0,
					capturedAt: "2026-07-01T00:00:00.000Z",
					stdout: input.stdout,
				};
				entries.push(entry);
				return entry;
			}),
			captureCommand: vi.fn(),
		};
		const writeScope = ["compass-health-agent://database/compass_health/diet_logs"];
		const getPermissionDecision = vi.fn(() => ({
			subject: "log_meal",
			allowed: { level: "allow" as const, ruleId: "test-allow" },
			writeScope,
		}));
		setToolContext(mocks.ctx as never);

		const registrations = createCompassHealthToolRegistrations({
			evidenceGateway,
			getPermissionDecision,
		} as never);
		const logMeal = registrations.find((registration) => registration.tool.name === "log_meal");
		if (!logMeal) throw new Error("expected log_meal tool registration");
		const params = {
			date: "2026-07-01",
			mealType: "lunch",
			description: "sensitive meal description should not be persisted",
		};

		await expect(logMeal.tool.execute("call-log-meal", params)).resolves.toMatchObject({
			details: { log: { id: "diet-log-1" } },
		});

		expect(mocks.handleLogMeal).toHaveBeenCalledWith(mocks.ctx, params);
		expect(evidenceGateway.captureOutput).toHaveBeenCalledTimes(1);
		expect(entries[0]).toMatchObject({
			command: "compass-health domain write: log_meal",
			subject: "compass-health-agent://database/compass_health/diet_logs",
			allowed: { level: "allow", ruleId: "test-allow" },
			writeScope,
			actualWritePaths: ["compass-health-agent://database/compass_health/diet_logs"],
			exitCode: 0,
		});
		expect(entries[0].stdout).toContain("\"toolName\":\"log_meal\"");
		expect(entries[0].stdout).toContain("\"table\":\"diet_logs\"");
		expect(entries[0].stdout).not.toContain(params.description);
	});

	it("does not record a memory write receipt when remember asks for confirmation", async () => {
		const { createCompassHealthToolRegistrations, setToolContext } = await import(
			"../../src/agents/profiles/compass-health/tools.ts"
		);
		const evidenceGateway = {
			captureOutput: vi.fn(),
			captureCommand: vi.fn(),
		};
		mocks.handleRemember.mockResolvedValueOnce({
			needsConfirmation: {
				reason: "low-confidence-memory",
				confidence: 0.4,
			},
		});
		setToolContext(mocks.ctx as never);

		const registrations = createCompassHealthToolRegistrations({
			evidenceGateway,
			getPermissionDecision: vi.fn(() => ({
				subject: "remember",
				allowed: { level: "allow" as const, ruleId: "test-allow" },
				writeScope: ["compass-health-agent://database/compass_health/memory_records"],
			})),
		} as never);
		const remember = registrations.find((registration) => registration.tool.name === "remember");
		if (!remember) throw new Error("expected remember tool registration");
		const params = {
			kind: "preference",
			subject: "breakfast",
			content: "tentative preference should not be persisted",
			sourceText: "Maybe I prefer savory breakfasts",
			confidence: 0.4,
		};

		await expect(remember.tool.execute("call-remember-confirm", params)).resolves.toMatchObject({
			details: { needsConfirmation: { reason: "low-confidence-memory" } },
		});

		expect(mocks.handleRemember).toHaveBeenCalledWith(mocks.ctx, params);
		expect(evidenceGateway.captureOutput).not.toHaveBeenCalled();
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

		const remember = registrations.find((registration) => registration.tool.name === "remember");
		const recall = registrations.find((registration) => registration.tool.name === "recall");
		const rememberParams = {
			kind: "preference",
			subject: "breakfast",
			content: "prefers savory breakfasts",
			sourceText: "I like savory breakfasts",
			confidence: 0.9,
		};
		const recallParams = {
			query: "breakfast preferences",
			kinds: ["preference"],
			limit: 3,
		};

		expect(remember?.accessLevel).toBe("write");
		expect(recall?.accessLevel).toBe("read-only");
		expect(remember?.tool.description).toContain("durable user preference");
		expect(recall?.tool.description).toContain("Recall durable user preferences");
		expect(Value.Check(remember?.tool.parameters as any, rememberParams)).toBe(true);
		expect(Value.Check(recall?.tool.parameters as any, recallParams)).toBe(true);
		await expect(remember?.tool.execute("call-3", rememberParams)).resolves.toMatchObject({
			details: { status: "remembered" },
		});
		await expect(recall?.tool.execute("call-4", recallParams)).resolves.toMatchObject({
			details: { memories: [{ id: "memory-1" }] },
		});
		expect(mocks.handleRemember).toHaveBeenCalledWith(mocks.ctx, rememberParams);
		expect(mocks.handleRecall).toHaveBeenCalledWith(mocks.ctx, recallParams);

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
		}
		expect(proposeDishDraftSchema.required ?? []).not.toContain("seasonings");
		expect(saveDishSchema.required ?? []).toContain("seasonings");
	});
});
