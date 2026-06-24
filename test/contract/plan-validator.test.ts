import { describe, expect, it } from "vitest";
import { validatePlan } from "../../src/contract/plan-validator.ts";

const validTask = {
	id: "task-a",
	goal: "Add contract schemas",
	rawRequest: "Add contract schemas",
	hardConstraints: [{ kind: "path", value: "src/contract/**", source: "user" }],
	assignedSkill: "contract",
	writeScope: ["src/contract/**"],
	allowedTools: ["shell_command"],
	gateTier: "G1",
};

describe("validatePlan", () => {
	it("accepts a valid minimal plan package", () => {
		const result = validatePlan({
			tasks: [
				validTask,
				{
					...validTask,
					id: "task-b",
					writeScope: ["test/contract/**"],
				},
			],
			dependencies: [{ taskId: "task-b", dependsOn: "task-a" }],
		});

		expect(result).toEqual({ ok: true, errors: [] });
	});

	it("returns stable schema errors with paths", () => {
		const result = validatePlan({
			tasks: [
				{
					...validTask,
					goal: 42,
					gateTier: "G5",
				},
			],
			dependencies: [],
		});

		expect(result.ok).toBe(false);
		expect(result.errors).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ code: "PLAN_E001", path: "/tasks/0/goal" }),
				expect.objectContaining({ code: "PLAN_E001", path: "/tasks/0/gateTier" }),
			]),
		);
	});

	it("rejects duplicate task ids with a stable path", () => {
		const result = validatePlan({
			tasks: [
				validTask,
				{ ...validTask, goal: "Build duplicate path", writeScope: ["test/contract/**"] },
			],
			dependencies: [],
		});

		expect(result.errors).toEqual([
			{
				code: "PLAN_E012",
				path: "/tasks/1/id",
				message: "Duplicate task id: task-a already defined at /tasks/0/id",
			},
		]);
	});

	it("rejects dependencies with an unknown task id", () => {
		const result = validatePlan({
			tasks: [validTask],
			dependencies: [{ taskId: "missing-task", dependsOn: "task-a" }],
		});

		expect(result.errors).toEqual([
			{
				code: "PLAN_E013",
				path: "/dependencies/0/taskId",
				message: "Unknown dependency task id: missing-task",
			},
		]);
	});

	it("rejects dependencies with an unknown target", () => {
		const result = validatePlan({
			tasks: [validTask],
			dependencies: [{ taskId: "task-a", dependsOn: "missing-task" }],
		});

		expect(result.errors).toEqual([
			{
				code: "PLAN_E014",
				path: "/dependencies/0/dependsOn",
				message: "Unknown dependency target: missing-task",
			},
		]);
	});

	it("detects dependency cycles deterministically", () => {
		const result = validatePlan({
			tasks: [
				validTask,
				{ ...validTask, id: "task-b", writeScope: ["test/contract/**"] },
				{ ...validTask, id: "task-c", writeScope: ["schemas/**"] },
			],
			dependencies: [
				{ taskId: "task-b", dependsOn: "task-a" },
				{ taskId: "task-c", dependsOn: "task-b" },
				{ taskId: "task-a", dependsOn: "task-c" },
			],
		});

		expect(result.errors).toEqual([
			{
				code: "PLAN_E010",
				path: "/dependencies",
				message: "Dependency cycle detected: task-a -> task-c -> task-b -> task-a",
			},
		]);
	});

	it("detects overlapping write scopes deterministically", () => {
		const result = validatePlan({
			tasks: [
				validTask,
				{ ...validTask, id: "task-b", writeScope: ["src/contract/schemas/**"] },
			],
			dependencies: [],
		});

		expect(result.errors).toEqual([
			{
				code: "PLAN_E011",
				path: "/tasks/1/writeScope/0",
				message: "Write scope overlaps with task-a at /tasks/0/writeScope/0",
			},
		]);
	});

	it("detects overlapping write scopes after lexical path cleanup", () => {
		const result = validatePlan({
			tasks: [
				{ ...validTask, writeScope: ["src/**"] },
				{ ...validTask, id: "task-b", writeScope: ["./src/contract/**"] },
			],
			dependencies: [],
		});

		expect(result.errors).toEqual([
			{
				code: "PLAN_E011",
				path: "/tasks/1/writeScope/0",
				message: "Write scope overlaps with task-a at /tasks/0/writeScope/0",
			},
		]);
	});

	it("allows distinct normalized write scopes", () => {
		const result = validatePlan({
			tasks: [
				{ ...validTask, writeScope: ["./src/contract/**"] },
				{ ...validTask, id: "task-b", writeScope: ["test/contract/**"] },
			],
			dependencies: [],
		});

		expect(result).toEqual({ ok: true, errors: [] });
	});
});
