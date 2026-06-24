import { describe, expect, it } from "vitest";
import { decide } from "../../src/policy/decide.ts";
import {
	evaluateCommandRules,
	resolvePermissionProfile,
	type RunPolicy,
} from "../../src/policy/index.ts";

describe("permission profiles", () => {
	it("resolves read-only to deny write, destructive, and network subjects", () => {
		const profile = resolvePermissionProfile("read-only", { writeScope: ["src"] });

		expect(decide(profile.policy, "write", "src/file.ts", {
			accessLevel: "write",
			subjectIsPath: true,
			writeScope: profile.writeScope,
		})).toEqual({ level: "deny" });
		expect(decide(profile.policy, "fetch", "https://example.test", { accessLevel: "network" })).toEqual({
			level: "deny",
		});
	});

	it("resolves workspace-write to allow only paths inside the declared write scope", () => {
		const profile = resolvePermissionProfile("workspace-write", { writeScope: ["src"] });

		expect(decide(profile.policy, "write", "src/file.ts", {
			accessLevel: "write",
			subjectIsPath: true,
			writeScope: profile.writeScope,
		})).toEqual({ level: "allow" });
		expect(decide(profile.policy, "write", "secrets/key.txt", {
			accessLevel: "write",
			subjectIsPath: true,
			writeScope: profile.writeScope,
		})).toEqual({ level: "deny", ruleId: "write-scope" });
	});

	it("blocks denied commands before execution", () => {
		const profile = resolvePermissionProfile("workspace-write", { writeScope: ["src"] });

		expect(evaluateCommandRules(profile.commandRules, "npm test")).toEqual({ allowed: true });
		expect(evaluateCommandRules(profile.commandRules, "rm -rf dist")).toEqual({
			allowed: false,
			ruleId: "deny-bulk-delete",
		});
	});

	it("carries RunPolicy gate and budget controls", () => {
		const runPolicy: RunPolicy = {
			budget: { maxUsd: 1 },
			repairLimits: { maxAttempts: 2 },
			gateTiers: { G3: "human" },
		};

		expect(runPolicy.gateTiers?.G3).toBe("human");
	});
});
