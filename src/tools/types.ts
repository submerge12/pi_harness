import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ActiveWorktreeLease } from "../execution/types.ts";
import type { SubjectPolicyRule } from "../policy/types.ts";
import type { TSchema } from "typebox";

export type ToolAccessLevel = "read-only" | "write" | "destructive" | "network";
export type PermissionLevel = "deny" | "ask" | "allow";

export interface ToolRegistration<TParameters extends TSchema = TSchema, TDetails = unknown> {
	tool: AgentTool<TParameters, TDetails>;
	accessLevel: ToolAccessLevel;
	permissionOverride?: PermissionLevel;
}

export type StoredToolRegistration<TParameters extends TSchema = TSchema, TDetails = unknown> = Readonly<
	ToolRegistration<TParameters, TDetails>
>;

export interface PermissionPolicy {
	defaults: Record<ToolAccessLevel, PermissionLevel>;
	tools?: Record<string, PermissionLevel>;
	rules?: readonly SubjectPolicyRule[];
}

export interface HarnessToolCallEvent {
	type: "tool_call";
	toolCallId: string;
	toolName: string;
	input: Record<string, unknown>;
}

export interface ToolCallPermissionResult {
	block?: boolean;
	reason?: string;
}

export interface AskPermissionContext {
	subject?: string;
}

export type AskPermissionCallback = (
	toolName: string,
	args: Record<string, unknown>,
	context?: AskPermissionContext,
) => boolean | Promise<boolean>;

export interface ToolPermissionEvidenceDecision {
	subject: string;
	allowed: {
		level: PermissionLevel;
		ruleId?: string;
	};
	writeScope?: readonly string[];
}

export interface ToolPermissionDecisionRecord extends ToolPermissionEvidenceDecision {
	toolCallId: string;
	toolName: string;
}

export type ToolPermissionDecisionCallback = (decision: ToolPermissionDecisionRecord) => void;
export type ToolPermissionDecisionLookup = (toolCallId: string) => ToolPermissionEvidenceDecision | undefined;

export interface PermissionGateOptions {
	askCallback?: AskPermissionCallback;
	getActiveLease?: () => ActiveWorktreeLease | undefined;
	getActiveToolNames?: () => readonly string[] | undefined;
	onDecision?: ToolPermissionDecisionCallback;
}

export interface HarnessToolCallSubscriber {
	on(
		type: "tool_call",
		handler: (event: HarnessToolCallEvent) => Promise<ToolCallPermissionResult | undefined>,
	): () => void;
}
