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
	};
});

vi.mock("compass-health-agent", () => ({
	compassHealthProfileSpec: mocks.spec,
	createToolContextFromEnv: mocks.createToolContextFromEnv,
}));

vi.mock("compass-health-agent/tools/handlers", () => ({
	handleProactiveCheck: mocks.handleProactiveCheck,
}));

afterEach(async () => {
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
});
