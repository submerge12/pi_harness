import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { createEchoTool } from "../src/tools/builtin/echo.ts";
import { PermissionGate } from "../src/tools/permission.ts";
import { ToolRegistry } from "../src/tools/registry.ts";
import type { HarnessToolCallEvent, PermissionPolicy, ToolRegistration } from "../src/tools/types.ts";

function createPolicy(tools: PermissionPolicy["tools"] = {}): PermissionPolicy {
	return {
		defaults: {
			"read-only": "allow",
			network: "ask",
			write: "ask",
			destructive: "deny",
		},
		tools,
	};
}

function createToolRegistration(name: string, accessLevel: ToolRegistration["accessLevel"]): ToolRegistration {
	const tool = createEchoTool(name);
	return { tool, accessLevel };
}

function createToolCallEvent(toolName: string, input: Record<string, unknown> = {}): HarnessToolCallEvent {
	return {
		type: "tool_call",
		toolCallId: `${toolName}-call`,
		toolName,
		input,
	};
}

describe("ToolRegistry", () => {
	it("rejects duplicate tool names", () => {
		const registry = new ToolRegistry();
		registry.register(createToolRegistration("echo", "read-only"));

		expect(() => registry.register(createToolRegistration("echo", "network"))).toThrow(
			"Duplicate tool registration: echo",
		);
	});

	it("maps read-only and network tools to parallel execution", () => {
		const registry = new ToolRegistry();
		registry.register(createToolRegistration("read", "read-only"));
		registry.register(createToolRegistration("fetch", "network"));

		expect(registry.toAgentTools().map((tool) => [tool.name, tool.executionMode])).toEqual([
			["read", "parallel"],
			["fetch", "parallel"],
		]);
	});

	it("maps write and destructive tools to sequential execution", () => {
		const registry = new ToolRegistry();
		registry.register(createToolRegistration("write", "write"));
		registry.register(createToolRegistration("remove", "destructive"));

		expect(registry.toAgentTools().map((tool) => [tool.name, tool.executionMode])).toEqual([
			["write", "sequential"],
			["remove", "sequential"],
		]);
	});

	it("keeps registrations immutable from caller mutations", () => {
		const registry = new ToolRegistry();
		const registration = createToolRegistration("echo", "read-only");
		registry.register(registration);
		registration.accessLevel = "destructive";
		registration.permissionOverride = "deny";

		const metadata = registry.getRegistration("echo");
		expect(metadata).toMatchObject({ accessLevel: "read-only", permissionOverride: undefined });
	});

	it("keeps nested tool parameters immutable from caller mutations", () => {
		const registry = new ToolRegistry();
		const parameters = Type.Object({ message: Type.String() });
		registry.register({ tool: createEchoTool("echo", parameters), accessLevel: "read-only" });
		(parameters.properties as Record<string, unknown>).extra = Type.String();

		const metadata = registry.getRegistration("echo");

		expect(Object.keys((metadata?.tool.parameters as typeof parameters).properties)).toEqual(["message"]);
		expect(() => {
			((metadata?.tool.parameters as typeof parameters).properties as Record<string, unknown>).mutated = Type.String();
		}).toThrow();
	});
});

describe("PermissionGate", () => {
	it("blocks deny defaults", async () => {
		const registry = new ToolRegistry();
		registry.register(createToolRegistration("remove", "destructive"));
		const gate = new PermissionGate(registry, createPolicy());

		await expect(gate.handleToolCall(createToolCallEvent("remove"))).resolves.toEqual({
			block: true,
			reason: "Tool remove is denied by policy",
		});
	});

	it("allows allow defaults", async () => {
		const registry = new ToolRegistry();
		registry.register(createToolRegistration("read", "read-only"));
		const gate = new PermissionGate(registry, createPolicy());

		await expect(gate.handleToolCall(createToolCallEvent("read"))).resolves.toBeUndefined();
	});

	it("allows ask when the callback approves", async () => {
		const registry = new ToolRegistry();
		registry.register(createToolRegistration("fetch", "network"));
		const gate = new PermissionGate(registry, createPolicy(), {
			askCallback: async (toolName, args) => toolName === "fetch" && args.url === "https://example.invalid",
		});

		await expect(
			gate.handleToolCall(createToolCallEvent("fetch", { url: "https://example.invalid" })),
		).resolves.toBeUndefined();
	});

	it("blocks ask when the callback denies", async () => {
		const registry = new ToolRegistry();
		registry.register(createToolRegistration("fetch", "network"));
		const gate = new PermissionGate(registry, createPolicy(), { askCallback: async () => false });

		await expect(gate.handleToolCall(createToolCallEvent("fetch"))).resolves.toEqual({
			block: true,
			reason: "Tool fetch requires approval",
		});
	});

	it("blocks ask by default when no callback exists", async () => {
		const registry = new ToolRegistry();
		registry.register(createToolRegistration("fetch", "network"));
		const gate = new PermissionGate(registry, createPolicy());

		await expect(gate.handleToolCall(createToolCallEvent("fetch"))).resolves.toEqual({
			block: true,
			reason: "Tool fetch requires approval",
		});
	});

	it("applies deny before ask before allow", async () => {
		const registry = new ToolRegistry();
		registry.register({ ...createToolRegistration("echo", "read-only"), permissionOverride: "deny" });
		const gate = new PermissionGate(registry, createPolicy({ echo: "allow" }), { askCallback: async () => true });

		await expect(gate.handleToolCall(createToolCallEvent("echo"))).resolves.toEqual({
			block: true,
			reason: "Tool echo is denied by policy",
		});
	});

	it("lets tool-specific policy override default deny or ask", async () => {
		const registry = new ToolRegistry();
		registry.register(createToolRegistration("remove", "destructive"));
		registry.register(createToolRegistration("write", "write"));
		const gate = new PermissionGate(registry, createPolicy({ remove: "allow", write: "allow" }));

		await expect(gate.handleToolCall(createToolCallEvent("remove"))).resolves.toBeUndefined();
		await expect(gate.handleToolCall(createToolCallEvent("write"))).resolves.toBeUndefined();
	});

	it("keeps registration-level deny stronger than policy allow", async () => {
		const registry = new ToolRegistry();
		registry.register({ ...createToolRegistration("remove", "destructive"), permissionOverride: "deny" });
		const gate = new PermissionGate(registry, createPolicy({ remove: "allow" }));

		await expect(gate.handleToolCall(createToolCallEvent("remove"))).resolves.toEqual({
			block: true,
			reason: "Tool remove is denied by policy",
		});
	});

	it("installs on a harness-like object", async () => {
		const registry = new ToolRegistry();
		registry.register(createToolRegistration("read", "read-only"));
		const gate = new PermissionGate(registry, createPolicy());
		let installedHandler: ((event: HarnessToolCallEvent) => Promise<{ block?: boolean; reason?: string } | undefined>) | undefined;
		const unsubscribe = () => {};

		const result = gate.install({
			on(type, handler) {
				expect(type).toBe("tool_call");
				installedHandler = handler;
				return unsubscribe;
			},
		});

		expect(result).toBe(unsubscribe);
		await expect(installedHandler?.(createToolCallEvent("read"))).resolves.toBeUndefined();
	});

	it("executes echo deterministically", async () => {
		const schema = Type.Object({ message: Type.String() });
		const tool = createEchoTool("echo", schema);

		await expect(tool.execute("call-1", { message: "hello" })).resolves.toEqual({
			content: [{ type: "text", text: "hello" }],
			details: { toolCallId: "call-1", input: { message: "hello" } },
		});
	});
});
