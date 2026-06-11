import { describe, expect, it } from "vitest";
import { codingProfile, createCodingToolRegistrations } from "../src/agents/profiles/coding/profile.ts";
import { researchProfile, createResearchToolRegistrations } from "../src/agents/profiles/research/profile.ts";
import { dataAnalysisProfile, createDataAnalysisToolRegistrations } from "../src/agents/profiles/data-analysis/profile.ts";

function expectPolicyDefaults(profile: { policy: { defaults: Record<string, string> } }, defaults: Record<string, string>): void {
	expect(profile.policy.defaults).toEqual(defaults);
}

describe("built-in agent profiles", () => {
	it("defines the coding profile with review-safe defaults", () => {
		expect(codingProfile.name).toBe("coding");
		expect(codingProfile.thinkingLevel).toBe("high");
		expectPolicyDefaults(codingProfile, {
			"read-only": "allow",
			write: "ask",
			destructive: "ask",
			network: "ask",
		});
		expect(codingProfile.systemPrompt).toContain("small, reviewed diffs");
		expect(codingProfile.systemPrompt).toContain("never fabricate test results");
		expect(codingProfile.context.compactionInstructions).toContain("file paths");
		expect(codingProfile.context.compactionInstructions).toContain("failing tests");
		expect(codingProfile.skills.map((skill) => skill.name)).toEqual(["review", "fix-tests"]);
	});

	it("registers the coding built-in tools with the expected access levels", () => {
		expect(createCodingToolRegistrations({ env: fakeEnv() }).map((registration) => [registration.tool.name, registration.accessLevel])).toEqual([
			["read", "read-only"],
			["ls", "read-only"],
			["grep", "read-only"],
			["glob", "read-only"],
			["write", "write"],
			["edit", "write"],
			["bash", "destructive"],
			["fetch", "network"],
		]);
	});

	it("defines the research profile with source-first network access and no write defaults", () => {
		expect(researchProfile.name).toBe("research");
		expect(researchProfile.thinkingLevel).toBe("medium");
		expectPolicyDefaults(researchProfile, {
			"read-only": "allow",
			write: "deny",
			destructive: "deny",
			network: "allow",
		});
		expect(researchProfile.systemPrompt).toContain("separate claims from evidence");
		expect(researchProfile.systemPrompt).toContain("cite sources");
		expect(researchProfile.context.compactionInstructions).toContain("sources");
		expect(researchProfile.context.compactionInstructions).toContain("claims");
		expect(createResearchToolRegistrations({ env: fakeEnv() }).map((registration) => [registration.tool.name, registration.accessLevel])).toEqual([
			["fetch", "network"],
			["read", "read-only"],
			["ls", "read-only"],
			["grep", "read-only"],
			["glob", "read-only"],
		]);
	});

	it("defines the data-analysis profile with deterministic outputs and guarded filesystem defaults", () => {
		expect(dataAnalysisProfile.name).toBe("data-analysis");
		expect(dataAnalysisProfile.thinkingLevel).toBe("medium");
		expectPolicyDefaults(dataAnalysisProfile, {
			"read-only": "allow",
			write: "ask",
			destructive: "deny",
			network: "deny",
		});
		expect(dataAnalysisProfile.systemPrompt).toContain("deterministic tables");
		expect(dataAnalysisProfile.systemPrompt).toContain("./outputs");
		expect(dataAnalysisProfile.context.compactionInstructions).toContain("schemas");
		expect(dataAnalysisProfile.context.compactionInstructions).toContain("metrics");
		expect(createDataAnalysisToolRegistrations({ env: fakeEnv() }).map((registration) => [registration.tool.name, registration.accessLevel])).toEqual([
			["read", "read-only"],
			["ls", "read-only"],
			["grep", "read-only"],
			["glob", "read-only"],
			["write", "write"],
		]);
	});

	it("enforces data-analysis write and network boundaries in profile tools", async () => {
		const registrations = createDataAnalysisToolRegistrations({ env: fakeEnv() });
		const write = registrations.find((registration) => registration.tool.name === "write");

		if (!write) throw new Error("missing data-analysis write tool");

		expect(registrations.some((registration) => registration.tool.name === "bash")).toBe(false);
		expect(registrations.some((registration) => registration.accessLevel === "network")).toBe(false);
		await expect(write.tool.execute("call-1", { path: "summary.json", content: "{}" })).rejects.toThrow(
			"outputs/",
		);
	});

	it("does not ship unsafe allow defaults for write, destructive, or network access", () => {
		const profiles = [codingProfile, researchProfile, dataAnalysisProfile];

		for (const profile of profiles) {
			expect(profile.policy.defaults.write).not.toBe("allow");
			expect(profile.policy.defaults.destructive).not.toBe("allow");
		}
		expect(codingProfile.policy.defaults.network).not.toBe("allow");
		expect(dataAnalysisProfile.policy.defaults.network).toBe("deny");
	});
});

function fakeEnv(): Parameters<typeof createCodingToolRegistrations>[0]["env"] {
	return {
		cwd: ".",
		async absolutePath() {
			return { ok: true, value: "." };
		},
		async joinPath(parts: string[]) {
			return { ok: true, value: parts.join("/") };
		},
		async readTextFile() {
			return { ok: true, value: "" };
		},
		async readBinaryFile() {
			return { ok: true, value: new Uint8Array() };
		},
		async writeFile() {
			return { ok: true, value: undefined };
		},
		async appendFile() {
			return { ok: true, value: undefined };
		},
		async listDir() {
			return { ok: true, value: [] };
		},
		async fileInfo() {
			return { ok: true, value: { kind: "directory", name: ".", path: ".", size: 0, mtimeMs: 0 } };
		},
		async canonicalPath() {
			return { ok: true, value: "." };
		},
		async exists() {
			return { ok: true, value: true };
		},
		async createDir() {
			return { ok: true, value: undefined };
		},
		async remove() {
			return { ok: true, value: undefined };
		},
		async createTempDir() {
			return { ok: true, value: "." };
		},
		async createTempFile() {
			return { ok: true, value: "." };
		},
		async readTextLines() {
			return { ok: true, value: [] };
		},
		async exec() {
			return { ok: true, value: { stdout: "", stderr: "", exitCode: 0 } };
		},
		async cleanup() {},
	};
}
