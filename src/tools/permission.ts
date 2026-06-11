import type {
	HarnessToolCallEvent,
	HarnessToolCallSubscriber,
	PermissionGateOptions,
	PermissionLevel,
	PermissionPolicy,
	StoredToolRegistration,
	ToolCallPermissionResult,
} from "./types.ts";
import type { ToolRegistry } from "./registry.ts";

const permissionRank: Record<PermissionLevel, number> = {
	allow: 0,
	ask: 1,
	deny: 2,
};

function stricterPermission(first: PermissionLevel, second: PermissionLevel): PermissionLevel {
	return permissionRank[first] >= permissionRank[second] ? first : second;
}

function resolvePermission(registration: StoredToolRegistration, policy: PermissionPolicy): PermissionLevel {
	const configuredLevel = policy.tools?.[registration.tool.name] ?? policy.defaults[registration.accessLevel];
	const overrideLevel = registration.permissionOverride;
	return overrideLevel ? stricterPermission(configuredLevel, overrideLevel) : configuredLevel;
}

export class PermissionGate {
	private registry: ToolRegistry;
	private policy: PermissionPolicy;
	private options: PermissionGateOptions;

	constructor(registry: ToolRegistry, policy: PermissionPolicy, options: PermissionGateOptions = {}) {
		this.registry = registry;
		this.policy = {
			defaults: { ...policy.defaults },
			tools: policy.tools ? { ...policy.tools } : undefined,
		};
		this.options = { ...options };
	}

	install(harness: HarnessToolCallSubscriber): () => void {
		return harness.on("tool_call", (event) => this.handleToolCall(event));
	}

	async handleToolCall(event: HarnessToolCallEvent): Promise<ToolCallPermissionResult | undefined> {
		const registration = this.registry.getRegistration(event.toolName);
		if (!registration) return { block: true, reason: `Unknown tool ${event.toolName}` };

		const permission = resolvePermission(registration, this.policy);
		if (permission === "deny") return { block: true, reason: `Tool ${event.toolName} is denied by policy` };
		if (permission === "allow") return undefined;

		const approved = await this.options.askCallback?.(event.toolName, { ...event.input });
		return approved ? undefined : { block: true, reason: `Tool ${event.toolName} requires approval` };
	}
}
