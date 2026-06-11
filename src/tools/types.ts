import type { AgentTool } from "@earendil-works/pi-agent-core";
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

export type AskPermissionCallback = (toolName: string, args: Record<string, unknown>) => boolean | Promise<boolean>;

export interface PermissionGateOptions {
	askCallback?: AskPermissionCallback;
}

export interface HarnessToolCallSubscriber {
	on(
		type: "tool_call",
		handler: (event: HarnessToolCallEvent) => Promise<ToolCallPermissionResult | undefined>,
	): () => void;
}
