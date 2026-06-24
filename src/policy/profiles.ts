import type { WriteScope } from "../execution/types.ts";
import { normalizeWriteScope } from "../execution/write-scope.ts";
import type { ScopedPolicy } from "./types.ts";

export type PermissionProfileName = "read-only" | "workspace-write" | "network";

export interface CommandRule {
	id: string;
	action: "allow" | "deny";
	pattern: RegExp;
	reason?: string;
}

export interface CommandRuleDecision {
	allowed: boolean;
	ruleId?: string;
	reason?: string;
}

export interface ResolvedPermissionProfile {
	name: PermissionProfileName;
	policy: ScopedPolicy;
	commandRules: readonly CommandRule[];
	writeScope?: WriteScope;
}

export interface PermissionProfileOptions {
	writeScope?: WriteScope;
}

export interface RunPolicy {
	budget?: {
		maxUsd?: number;
		maxTurns?: number;
	};
	repairLimits?: {
		maxAttempts?: number;
		maxRewinds?: number;
	};
	gateTiers?: Partial<Record<"G0" | "G1" | "G2" | "G3" | "G4", "auto" | "review" | "human">>;
}

const dangerousCommandRules: readonly CommandRule[] = [
	{
		id: "deny-bulk-delete",
		action: "deny",
		pattern: /\b(?:rm\s+-rf|del\s+\/s|rd\s+\/s|rmdir\s+\/s|Remove-Item\b[^\n\r]*-Recurse)\b/i,
		reason: "bulk deletion is not allowed",
	},
];

export function resolvePermissionProfile(
	name: PermissionProfileName,
	options: PermissionProfileOptions = {},
): ResolvedPermissionProfile {
	const writeScope = options.writeScope ? normalizeWriteScope(options.writeScope, { allowEmpty: true }) : undefined;
	if (name === "read-only") {
		return {
			name,
			policy: {
				defaults: {
					"read-only": "allow",
					write: "deny",
					destructive: "deny",
					network: "deny",
				},
			},
			commandRules: dangerousCommandRules,
			...(writeScope ? { writeScope } : {}),
		};
	}
	if (name === "network") {
		return {
			name,
			policy: {
				defaults: {
					"read-only": "allow",
					write: "deny",
					destructive: "deny",
					network: "allow",
				},
			},
			commandRules: dangerousCommandRules,
			...(writeScope ? { writeScope } : {}),
		};
	}
	return {
		name,
		policy: {
			defaults: {
				"read-only": "allow",
				write: "allow",
				destructive: "allow",
				network: "ask",
			},
		},
		commandRules: dangerousCommandRules,
		...(writeScope ? { writeScope } : {}),
	};
}

export function evaluateCommandRules(
	rules: readonly CommandRule[] | undefined,
	command: string,
): CommandRuleDecision {
	for (const rule of rules ?? []) {
		if (!rule.pattern.test(command)) continue;
		return {
			allowed: rule.action === "allow",
			ruleId: rule.id,
		};
	}
	return { allowed: true };
}
