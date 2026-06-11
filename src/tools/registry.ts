import type { AgentTool, ToolExecutionMode } from "@earendil-works/pi-agent-core";
import type { TSchema } from "typebox";
import type { StoredToolRegistration, ToolAccessLevel, ToolRegistration } from "./types.ts";

function defaultExecutionMode(accessLevel: ToolAccessLevel): ToolExecutionMode {
	if (accessLevel === "read-only" || accessLevel === "network") return "parallel";
	return "sequential";
}

function clonePlainValue<T>(value: T): T {
	if (value === null || typeof value !== "object") return value;
	if (Array.isArray(value)) return value.map((entry) => clonePlainValue(entry)) as T;
	const result: Record<string, unknown> = {};
	for (const [key, entry] of Object.entries(value)) {
		result[key] = clonePlainValue(entry);
	}
	return result as T;
}

function freezePlainValue<T>(value: T): T {
	if (value === null || typeof value !== "object") return value;
	if (Array.isArray(value)) {
		for (const entry of value) freezePlainValue(entry);
		return Object.freeze(value) as T;
	}
	for (const entry of Object.values(value)) freezePlainValue(entry);
	return Object.freeze(value) as T;
}

function cloneRegistration<TParameters extends TSchema, TDetails>(
	registration: ToolRegistration<TParameters, TDetails>,
): StoredToolRegistration<TParameters, TDetails> {
	return {
		tool: freezePlainValue(clonePlainValue(registration.tool)),
		accessLevel: registration.accessLevel,
		permissionOverride: registration.permissionOverride,
	};
}

export class ToolRegistry {
	private registrations = new Map<string, StoredToolRegistration>();

	register<TParameters extends TSchema, TDetails>(registration: ToolRegistration<TParameters, TDetails>): void {
		const name = registration.tool.name;
		if (this.registrations.has(name)) throw new Error(`Duplicate tool registration: ${name}`);
		this.registrations.set(name, cloneRegistration(registration));
	}

	getRegistration(name: string): StoredToolRegistration | undefined {
		const registration = this.registrations.get(name);
		return registration ? cloneRegistration(registration) : undefined;
	}

	listRegistrations(): StoredToolRegistration[] {
		return [...this.registrations.values()].map((registration) => cloneRegistration(registration));
	}

	toAgentTools(): AgentTool[] {
		return [...this.registrations.values()].map((registration) => ({
			...registration.tool,
			executionMode: registration.tool.executionMode ?? defaultExecutionMode(registration.accessLevel),
		}));
	}
}
