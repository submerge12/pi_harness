import type { Constraint } from "../contract/index.ts";

export interface ConstraintExtractionRule {
	kind: string;
	pattern: RegExp;
	source?: string;
	value?: (match: RegExpMatchArray) => string | undefined;
}

export interface IntakeOptions {
	extractionRules?: readonly ConstraintExtractionRule[];
	requiredConstraintKinds?: readonly string[];
	rewrite?: (rawRequest: string, hardConstraints: readonly Constraint[]) => string;
}

export type IntakeStatus = "complete" | "needs_clarification";

export interface IntakeResult {
	status: IntakeStatus;
	rawRequest: string;
	normalizedRequest: string;
	hardConstraints: readonly Constraint[];
	missingConstraintKinds: readonly string[];
}

export function runIntake(rawRequest: string, options: IntakeOptions = {}): IntakeResult {
	const hardConstraints = Object.freeze(extractHardConstraints(rawRequest, options.extractionRules ?? []));
	const missingConstraintKinds = Object.freeze(findMissingConstraintKinds(hardConstraints, options.requiredConstraintKinds ?? []));
	const complete = missingConstraintKinds.length === 0;
	const normalizedRequest = !complete && options.rewrite ? options.rewrite(rawRequest, hardConstraints) : rawRequest;

	return Object.freeze({
		status: complete ? "complete" : "needs_clarification",
		rawRequest,
		normalizedRequest,
		hardConstraints,
		missingConstraintKinds,
	});
}

export function extractHardConstraints(
	rawRequest: string,
	rules: readonly ConstraintExtractionRule[],
): Constraint[] {
	const constraints: Constraint[] = [];
	for (const rule of rules) {
		const pattern = cloneGlobalPattern(rule.pattern);
		for (const match of rawRequest.matchAll(pattern)) {
			const value = rule.value?.(match) ?? match[1] ?? match[0];
			if (!value) continue;
			constraints.push({
				kind: rule.kind,
				value,
				...(rule.source ? { source: rule.source } : {}),
			});
		}
	}
	return constraints;
}

function findMissingConstraintKinds(
	constraints: readonly Constraint[],
	requiredKinds: readonly string[],
): string[] {
	const presentKinds = new Set(constraints.map((constraint) => constraint.kind));
	return [...requiredKinds].filter((kind) => !presentKinds.has(kind));
}

function cloneGlobalPattern(pattern: RegExp): RegExp {
	return new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
}
