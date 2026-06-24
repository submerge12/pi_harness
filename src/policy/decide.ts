import type { PermissionLevel, PolicyDecision, PolicyDecisionContext, ScopedPolicy, SubjectPolicyRule, ToolAccessLevel } from "./types.ts";
import { normalizePathSubject, normalizeSubject } from "./subject.ts";
import { isPathWithinWriteScope } from "../execution/write-scope.ts";

const defaultPermissionDefaults: Record<ToolAccessLevel, PermissionLevel> = {
	"read-only": "allow",
	write: "ask",
	destructive: "ask",
	network: "ask",
};

const permissionRank: Record<PermissionLevel, number> = {
	allow: 0,
	ask: 1,
	deny: 2,
};

function stricterPermission(first: PermissionLevel, second: PermissionLevel): PermissionLevel {
	return permissionRank[first] >= permissionRank[second] ? first : second;
}

function accessLevelFor(context: PolicyDecisionContext): ToolAccessLevel {
	if (context.accessLevel) return context.accessLevel;
	if (context.readOnly === true) return "read-only";
	throw new Error("Policy decisions require an explicit accessLevel");
}

function matchSegment(pattern: string, subject: string): boolean {
	const memo = new Map<string, boolean>();

	function match(patternIndex: number, subjectIndex: number): boolean {
		const key = `${patternIndex}:${subjectIndex}`;
		const cached = memo.get(key);
		if (cached !== undefined) return cached;

		let matched: boolean;
		if (patternIndex === pattern.length) {
			matched = subjectIndex === subject.length;
		} else if (pattern[patternIndex] === "*") {
			matched =
				match(patternIndex + 1, subjectIndex) ||
				(subjectIndex < subject.length && match(patternIndex, subjectIndex + 1));
		} else if (pattern[patternIndex] === "?") {
			matched = subjectIndex < subject.length && match(patternIndex + 1, subjectIndex + 1);
		} else {
			matched = pattern[patternIndex] === subject[subjectIndex] && match(patternIndex + 1, subjectIndex + 1);
		}

		memo.set(key, matched);
		return matched;
	}

	return match(0, 0);
}

function splitSubject(subject: string): string[] {
	return normalizePathSubject(subject).split("/");
}

export function matchesSubjectGlob(pattern: string, subject: string): boolean {
	// Supports only *, ?, and whole-segment **. Character classes, brace expansion,
	// extglobs, and filesystem-specific behavior are intentionally not implemented.
	const patternParts = splitSubject(pattern);
	const subjectParts = splitSubject(subject);
	const memo = new Map<string, boolean>();

	function match(patternIndex: number, subjectIndex: number): boolean {
		const key = `${patternIndex}:${subjectIndex}`;
		const cached = memo.get(key);
		if (cached !== undefined) return cached;

		let matched: boolean;
		const patternPart = patternParts[patternIndex];
		if (patternIndex === patternParts.length) {
			matched = subjectIndex === subjectParts.length;
		} else if (patternPart === "**") {
			matched =
				match(patternIndex + 1, subjectIndex) ||
				(subjectIndex < subjectParts.length && match(patternIndex, subjectIndex + 1));
		} else {
			const subjectPart = subjectParts[subjectIndex];
			matched =
				subjectPart !== undefined &&
				matchSegment(patternPart, subjectPart) &&
				match(patternIndex + 1, subjectIndex + 1);
		}

		memo.set(key, matched);
		return matched;
	}

	return match(0, 0);
}

function matchRule(rules: readonly SubjectPolicyRule[] | undefined, toolName: string, subject: string): SubjectPolicyRule | undefined {
	let bestRule: SubjectPolicyRule | undefined;
	for (const rule of rules ?? []) {
		if (rule.toolName !== toolName) continue;
		if (!matchesSubjectGlob(rule.subject, subject)) continue;
		if (!bestRule || permissionRank[rule.level] > permissionRank[bestRule.level]) bestRule = rule;
	}

	return bestRule;
}

function fallbackPermission(policy: ScopedPolicy, toolName: string, accessLevel: ToolAccessLevel): PermissionLevel {
	return policy.tools?.[toolName] ?? policy.defaults?.[accessLevel] ?? defaultPermissionDefaults[accessLevel];
}

function writeScopeDecision(subject: string, context: PolicyDecisionContext, accessLevel: ToolAccessLevel): PolicyDecision | undefined {
	if (!context.writeScope) return undefined;
	if (accessLevel !== "write" && accessLevel !== "destructive") return undefined;
	if (!context.subjectIsPath) return { level: "deny", ruleId: "write-scope" };

	try {
		if (isPathWithinWriteScope(subject, context.writeScope)) return undefined;
	} catch {
		return { level: "deny", ruleId: "write-scope" };
	}

	return { level: "deny", ruleId: "write-scope" };
}

export function decide(policy: ScopedPolicy, toolName: string, subject: string, context: PolicyDecisionContext): PolicyDecision {
	const accessLevel = accessLevelFor(context);
	const writeScopeDenied = writeScopeDecision(subject, context, accessLevel);
	if (writeScopeDenied) return writeScopeDenied;

	const rule = matchRule(policy.rules, toolName, normalizeSubject(subject));
	const policyLevel = rule?.level ?? fallbackPermission(policy, toolName, accessLevel);
	const level = context.permissionOverride ? stricterPermission(policyLevel, context.permissionOverride) : policyLevel;

	return rule?.id ? { level, ruleId: rule.id } : { level };
}
