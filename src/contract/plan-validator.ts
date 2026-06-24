import { Value } from "typebox/value";
import { posix } from "node:path";
import { planPackageSchema } from "./schemas/plan-package.ts";
import type { PlanPackage } from "./schemas/plan-package.ts";
import type { PlanLintError, PlanLintResult } from "./types.ts";

export function validatePlan(plan: unknown): PlanLintResult {
	if (!Value.Check(planPackageSchema, plan)) {
		return {
			ok: false,
			errors: Value.Errors(planPackageSchema, plan).map((error) => ({
				code: "PLAN_E001",
				path: error.instancePath || "/",
				message: error.message,
			})),
		};
	}

	const errors = [
		...findDuplicateTaskIds(plan),
		...findUnknownDependencyTasks(plan),
		findDependencyCycle(plan),
		findWriteScopeOverlap(plan),
	].filter((error): error is PlanLintError => error !== undefined);
	return { ok: errors.length === 0, errors };
}

function findDuplicateTaskIds(plan: PlanPackage): PlanLintError[] {
	const firstTaskIndexById = new Map<string, number>();
	const errors: PlanLintError[] = [];

	for (let taskIndex = 0; taskIndex < plan.tasks.length; taskIndex += 1) {
		const task = plan.tasks[taskIndex];
		const firstTaskIndex = firstTaskIndexById.get(task.id);
		if (firstTaskIndex === undefined) {
			firstTaskIndexById.set(task.id, taskIndex);
			continue;
		}

		errors.push({
			code: "PLAN_E012",
			path: `/tasks/${taskIndex}/id`,
			message: `Duplicate task id: ${task.id} already defined at /tasks/${firstTaskIndex}/id`,
		});
	}

	return errors;
}

function findUnknownDependencyTasks(plan: PlanPackage): PlanLintError[] {
	const taskIds = new Set(plan.tasks.map((task) => task.id));
	const errors: PlanLintError[] = [];

	for (let dependencyIndex = 0; dependencyIndex < plan.dependencies.length; dependencyIndex += 1) {
		const dependency = plan.dependencies[dependencyIndex];
		if (!taskIds.has(dependency.taskId)) {
			errors.push({
				code: "PLAN_E013",
				path: `/dependencies/${dependencyIndex}/taskId`,
				message: `Unknown dependency task id: ${dependency.taskId}`,
			});
		}
		if (!taskIds.has(dependency.dependsOn)) {
			errors.push({
				code: "PLAN_E014",
				path: `/dependencies/${dependencyIndex}/dependsOn`,
				message: `Unknown dependency target: ${dependency.dependsOn}`,
			});
		}
	}

	return errors;
}

function findDependencyCycle(plan: PlanPackage): PlanLintError | undefined {
	const taskOrder = new Map(plan.tasks.map((task, index) => [task.id, index]));
	const dependenciesByTask = new Map<string, string[]>();
	for (const task of plan.tasks) dependenciesByTask.set(task.id, []);
	for (const dependency of plan.dependencies) {
		if (!taskOrder.has(dependency.taskId) || !taskOrder.has(dependency.dependsOn)) continue;
		dependenciesByTask.get(dependency.taskId)?.push(dependency.dependsOn);
	}
	for (const dependencies of dependenciesByTask.values()) {
		dependencies.sort((left, right) => (taskOrder.get(left) ?? 0) - (taskOrder.get(right) ?? 0));
	}

	const visited = new Set<string>();
	const visiting = new Set<string>();
	const stack: string[] = [];

	for (const task of plan.tasks) {
		const cycle = visitDependency(task.id, dependenciesByTask, visited, visiting, stack);
		if (cycle !== undefined) {
			return {
				code: "PLAN_E010",
				path: "/dependencies",
				message: `Dependency cycle detected: ${cycle.join(" -> ")}`,
			};
		}
	}

	return undefined;
}

function visitDependency(
	taskId: string,
	dependenciesByTask: Map<string, string[]>,
	visited: Set<string>,
	visiting: Set<string>,
	stack: string[],
): string[] | undefined {
	if (visited.has(taskId)) return undefined;
	if (visiting.has(taskId)) return stack.slice(stack.indexOf(taskId)).concat(taskId);

	visiting.add(taskId);
	stack.push(taskId);
	for (const dependency of dependenciesByTask.get(taskId) ?? []) {
		const cycle = visitDependency(dependency, dependenciesByTask, visited, visiting, stack);
		if (cycle !== undefined) return cycle;
	}
	stack.pop();
	visiting.delete(taskId);
	visited.add(taskId);
	return undefined;
}

function findWriteScopeOverlap(plan: PlanPackage): PlanLintError | undefined {
	for (let rightTaskIndex = 0; rightTaskIndex < plan.tasks.length; rightTaskIndex += 1) {
		const rightTask = plan.tasks[rightTaskIndex];
		for (let rightScopeIndex = 0; rightScopeIndex < rightTask.writeScope.length; rightScopeIndex += 1) {
			const rightScope = rightTask.writeScope[rightScopeIndex] ?? "";
			for (let leftTaskIndex = 0; leftTaskIndex < rightTaskIndex; leftTaskIndex += 1) {
				const leftTask = plan.tasks[leftTaskIndex];
				for (let leftScopeIndex = 0; leftScopeIndex < leftTask.writeScope.length; leftScopeIndex += 1) {
					const leftScope = leftTask.writeScope[leftScopeIndex] ?? "";
					if (writeScopesOverlap(leftScope, rightScope)) {
						return {
							code: "PLAN_E011",
							path: `/tasks/${rightTaskIndex}/writeScope/${rightScopeIndex}`,
							message: `Write scope overlaps with ${leftTask.id} at /tasks/${leftTaskIndex}/writeScope/${leftScopeIndex}`,
						};
					}
				}
			}
		}
	}

	return undefined;
}

function writeScopesOverlap(left: string, right: string): boolean {
	const leftRoot = writeScopeRoot(left);
	const rightRoot = writeScopeRoot(right);
	if (leftRoot === "" || rightRoot === "") return leftRoot === rightRoot;
	return leftRoot === rightRoot || leftRoot.startsWith(`${rightRoot}/`) || rightRoot.startsWith(`${leftRoot}/`);
}

function writeScopeRoot(scope: string): string {
	const root = scope
		.replace(/\\/g, "/")
		.replace(/\/\*\*$/, "")
		.replace(/\/\*$/, "")
		.replace(/\/+$/, "");
	const normalized = root === "" ? "" : posix.normalize(root);
	return normalized === "." ? "" : normalized.replace(/\/+$/, "");
}
