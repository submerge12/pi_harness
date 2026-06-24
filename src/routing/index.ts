import type { Constraint, TaskContract } from "../contract/index.ts";
import { runIntake, type IntakeOptions, type IntakeResult } from "../intake/index.ts";

export interface RouteCandidate {
	name: string;
	skill?: string;
	triggers?: readonly (string | RegExp)[];
	constraints?: readonly string[];
}

export interface SemanticRouteScore {
	name: string;
	score: number;
}

export type SemanticRouteMatcher = (
	request: string,
	candidates: readonly RouteCandidate[],
) => readonly SemanticRouteScore[];

export interface RoutingOptions {
	routes: readonly RouteCandidate[];
	semanticMatcher?: SemanticRouteMatcher;
}

export interface RouteMatch {
	route: RouteCandidate;
	method: "deterministic" | "semantic";
	score?: number;
}

export type FrontPipelineInput = { rawRequest: string } | { taskContract: TaskContract };

export interface FrontPipelineOptions {
	intake?: IntakeOptions;
	routing: RoutingOptions;
}

export type FrontPipelineResult =
	| {
			entryStage: "execute";
			taskContract: TaskContract;
			hardConstraints: readonly Constraint[];
	  }
	| {
			entryStage: "intake";
			intake: IntakeResult;
	  }
	| {
			entryStage: "route";
			intake: IntakeResult;
			route?: RouteMatch;
	  };

export function runRequestFrontPipeline(
	input: FrontPipelineInput,
	options: FrontPipelineOptions,
): FrontPipelineResult {
	if ("taskContract" in input) {
		return {
			entryStage: "execute",
			taskContract: input.taskContract,
			hardConstraints: input.taskContract.hardConstraints,
		};
	}

	const intake = runIntake(input.rawRequest, options.intake);
	if (intake.status === "needs_clarification") {
		return { entryStage: "intake", intake };
	}

	return {
		entryStage: "route",
		intake,
		route: selectRoute(intake.normalizedRequest, intake.hardConstraints, options.routing),
	};
}

export function selectRoute(
	request: string,
	hardConstraints: readonly Constraint[],
	options: RoutingOptions,
): RouteMatch | undefined {
	const candidates = options.routes.filter((candidate) => satisfiesHardConstraints(candidate, hardConstraints));
	const deterministic = candidates.find((candidate) => matchesTrigger(request, candidate.triggers ?? []));
	if (deterministic) return { route: deterministic, method: "deterministic" };

	const semanticScores = options.semanticMatcher?.(request, candidates) ?? [];
	for (const score of [...semanticScores].sort((left, right) => right.score - left.score)) {
		const route = candidates.find((candidate) => candidate.name === score.name);
		if (route) return { route, method: "semantic", score: score.score };
	}

	return undefined;
}

export function satisfiesHardConstraints(
	candidate: RouteCandidate,
	hardConstraints: readonly Constraint[],
): boolean {
	if (hardConstraints.length === 0) return true;
	const candidateConstraints = new Set(candidate.constraints ?? []);
	return hardConstraints.every((constraint) => {
		const kindValue = `${constraint.kind}:${constraint.value}`;
		return candidateConstraints.has(kindValue) || candidateConstraints.has(constraint.kind) || candidateConstraints.has(constraint.value);
	});
}

function matchesTrigger(request: string, triggers: readonly (string | RegExp)[]): boolean {
	for (const trigger of triggers) {
		if (typeof trigger === "string" && request.includes(trigger)) return true;
		if (trigger instanceof RegExp && trigger.test(request)) return true;
	}
	return false;
}
