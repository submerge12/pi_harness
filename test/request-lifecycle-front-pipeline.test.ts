import { describe, expect, it } from "vitest";
import type { TaskContract } from "../src/contract/index.ts";
import { runIntake } from "../src/intake/index.ts";
import { runRequestFrontPipeline, selectRoute } from "../src/routing/index.ts";

const taskContract: TaskContract = {
	id: "task-a",
	goal: "Implement request lifecycle",
	rawRequest: "Implement the request lifecycle plan",
	hardConstraints: [{ kind: "write-scope", value: "src/**", source: "user" }],
	assignedSkill: "coding.implementation",
	writeScope: ["src"],
	gateTier: "G1",
};

describe("request lifecycle front pipeline", () => {
	it("preserves raw input and freezes extracted hard constraints", () => {
		const result = runIntake("please use write-scope:src/**", {
			extractionRules: [
				{
					kind: "write-scope",
					pattern: /write-scope:([^\s]+)/,
					source: "user",
				},
			],
		});

		expect(result.rawRequest).toBe("please use write-scope:src/**");
		expect(result.hardConstraints).toEqual([{ kind: "write-scope", value: "src/**", source: "user" }]);
		expect(Object.isFrozen(result)).toBe(true);
		expect(Object.isFrozen(result.hardConstraints)).toBe(true);
	});

	it("skips rewrite for complete requests and only rewrites incomplete requests", () => {
		const completeRewriteCalls: string[] = [];
		const complete = runIntake("please use write-scope:src/**", {
			requiredConstraintKinds: ["write-scope"],
			extractionRules: [{ kind: "write-scope", pattern: /write-scope:([^\s]+)/ }],
			rewrite: (raw) => {
				completeRewriteCalls.push(raw);
				return "rewritten";
			},
		});

		const incomplete = runIntake("please implement this", {
			requiredConstraintKinds: ["write-scope"],
			extractionRules: [{ kind: "write-scope", pattern: /write-scope:([^\s]+)/ }],
			rewrite: (raw) => `${raw}\nMissing write scope.`,
		});

		expect(complete.status).toBe("complete");
		expect(complete.normalizedRequest).toBe("please use write-scope:src/**");
		expect(completeRewriteCalls).toEqual([]);
		expect(incomplete.status).toBe("needs_clarification");
		expect(incomplete.missingConstraintKinds).toEqual(["write-scope"]);
		expect(incomplete.normalizedRequest).toContain("Missing write scope.");
	});

	it("routes deterministically before semantic fallback and filters by hard constraints", () => {
		const routes = [
			{
				name: "docs",
				triggers: [/implement/i],
				constraints: ["write-scope:docs/**"],
			},
			{
				name: "code",
				triggers: [/implement/i],
				constraints: ["write-scope:src/**"],
			},
			{
				name: "semantic-code",
				constraints: ["write-scope:src/**"],
			},
		];

		expect(
			selectRoute("implement", [{ kind: "write-scope", value: "src/**" }], {
				routes,
				semanticMatcher: () => [{ name: "semantic-code", score: 0.99 }],
			}),
		).toEqual({ route: routes[1], method: "deterministic" });

		expect(
			selectRoute("build", [{ kind: "write-scope", value: "src/**" }], {
				routes,
				semanticMatcher: () => [{ name: "semantic-code", score: 0.99 }],
			}),
		).toEqual({ route: routes[2], method: "semantic", score: 0.99 });
	});

	it("uses TaskContract as the skip signal for stages 1-4", () => {
		const result = runRequestFrontPipeline(
			{ taskContract },
			{
				routing: { routes: [] },
			},
		);

		expect(result).toEqual({
			entryStage: "execute",
			taskContract,
			hardConstraints: taskContract.hardConstraints,
		});
	});
});
