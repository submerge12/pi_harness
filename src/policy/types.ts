import type { PermissionLevel, ToolAccessLevel } from "../tools/types.ts";
import type { WriteScope } from "../execution/types.ts";

export type { PermissionLevel, ToolAccessLevel };

export interface SubjectPolicyRule {
	id?: string;
	toolName: string;
	subject: string;
	level: PermissionLevel;
}

export interface ScopedPolicy {
	defaults?: Partial<Record<ToolAccessLevel, PermissionLevel>>;
	tools?: Record<string, PermissionLevel>;
	rules?: readonly SubjectPolicyRule[];
}

export interface PolicyDecisionContext {
	accessLevel?: ToolAccessLevel;
	readOnly?: boolean;
	permissionOverride?: PermissionLevel;
	subjectIsPath?: boolean;
	writeScope?: WriteScope;
}

export interface PolicyDecision {
	level: PermissionLevel;
	ruleId?: string;
}
