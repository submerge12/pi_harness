/**
 * D3: unit tests for the MCP tool source adapter.
 *
 * Everything here runs against a fake MCP client — no child process, no
 * database. The real server is exercised by the env-gated integration test in
 * `test/integration/mcp-health-tool-source.test.ts`.
 */
import { beforeEach, describe, expect, it } from "vitest";

import {
	closeHealthMcpSession,
	getHealthMcpSession,
	healthAccessLevel,
	healthMcpServerEnv,
	HEALTH_RUN_HANDLE_PROTOCOL,
	resolveHealthToolRegistrations,
	resolveToolSource,
} from "../../src/agents/profiles/compass-health-mcp.ts";
import { openMcpToolSession } from "../../src/tools/mcp/adapter.ts";
import {
	McpToolCallError,
	McpToolSourceUnavailableError,
	type McpCallResult,
	type McpClientLike,
	type McpToolDescriptor,
} from "../../src/tools/mcp/types.ts";
import type { ToolRegistration } from "../../src/tools/types.ts";

interface FakeCall {
	name: string;
	arguments: Record<string, unknown>;
}

const RUN_HANDLE = "run-handle-0001";

function textResult(payload: unknown, isError = false): McpCallResult {
	return {
		content: [{ type: "text", text: JSON.stringify(payload) }],
		structuredContent: payload as Record<string, unknown>,
		...(isError ? { isError: true } : {}),
	};
}

const DEFAULT_TOOLS: McpToolDescriptor[] = [
	{
		name: "health_get_system_status",
		description: "[read-only] Liveness.",
		inputSchema: { type: "object", properties: {} },
		_meta: { "compass.health/risk": "read-only" },
	},
	{
		name: "health_begin_run",
		description: "[state-change] Open a run.",
		inputSchema: {
			type: "object",
			properties: { objective: { type: "string" }, idempotencyKey: { type: "string" } },
			required: ["objective", "idempotencyKey"],
		},
		_meta: { "compass.health/risk": "state-change" },
	},
	{
		name: "health_end_run",
		description: "[state-change] Close a run.",
		inputSchema: {
			type: "object",
			properties: { runHandle: { type: "string" }, outcome: { type: "string" } },
			required: ["runHandle", "outcome"],
		},
		_meta: { "compass.health/risk": "state-change" },
	},
	{
		name: "health_get_daily_state",
		description: "[read-only] Read one projected daily health state.",
		inputSchema: {
			type: "object",
			properties: { runHandle: { type: "string" }, date: { type: "string" } },
			required: ["runHandle"],
		},
		_meta: { "compass.health/risk": "read-only" },
	},
	{
		name: "health_log_meal",
		description: "[revocable-write] Log a meal.",
		inputSchema: {
			type: "object",
			properties: {
				runHandle: { type: "string" },
				idempotencyKey: { type: "string" },
				description: { type: "string" },
			},
			required: ["runHandle", "idempotencyKey", "description"],
		},
		_meta: { "compass.health/risk": "revocable-write" },
	},
	{
		name: "health_search_training_media",
		description: "[read-only] No run handle needed.",
		inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
		_meta: { "compass.health/risk": "read-only" },
	},
];

class FakeMcpClient implements McpClientLike {
	readonly calls: FakeCall[] = [];
	closed = 0;
	responses = new Map<string, McpCallResult>();

	private readonly tools: McpToolDescriptor[];

	constructor(tools: McpToolDescriptor[] = DEFAULT_TOOLS) {
		this.tools = tools;
	}

	async listTools(): Promise<{ tools: McpToolDescriptor[] }> {
		return { tools: this.tools.map((tool) => ({ ...tool })) };
	}

	async callTool(request: { name: string; arguments?: Record<string, unknown> }): Promise<McpCallResult> {
		this.calls.push({ name: request.name, arguments: { ...request.arguments } });
		const canned = this.responses.get(request.name);
		if (canned) return canned;
		if (request.name === "health_begin_run") return textResult({ runHandle: RUN_HANDLE, stateRevision: 3 });
		if (request.name === "health_get_system_status") return textResult({ status: "ok" });
		return textResult({ ok: true, tool: request.name });
	}

	async close(): Promise<void> {
		this.closed += 1;
	}
}

function keys(index: { value: number }): (toolName: string) => string {
	return (toolName: string) => `key-${toolName}-${index.value++}`;
}

function byName(registrations: ToolRegistration[], name: string): ToolRegistration {
	const found = registrations.find((entry) => entry.tool.name === name);
	if (!found) throw new Error(`no registration for ${name}`);
	return found;
}

function schemaOf(registration: ToolRegistration): Record<string, unknown> {
	return registration.tool.parameters as unknown as Record<string, unknown>;
}

async function openFakeSession(client: FakeMcpClient) {
	return await openMcpToolSession(client, {
		runHandle: HEALTH_RUN_HANDLE_PROTOCOL,
		resolveAccessLevel: healthAccessLevel,
		filterTool: (tool) => tool.name !== "health_begin_run" && tool.name !== "health_end_run",
		newIdempotencyKey: keys({ value: 1 }),
		warn: () => undefined,
	});
}

describe("MCP adapter: opening sequence", () => {
	it("checks status, opens the run, then lists tools", async () => {
		const client = new FakeMcpClient();
		const session = await openFakeSession(client);

		expect(client.calls.map((call) => call.name)).toEqual([
			"health_get_system_status",
			"health_begin_run",
		]);
		expect(session.runHandle).toBe(RUN_HANDLE);
		const begin = client.calls[1]!;
		expect(begin.arguments["objective"]).toBe(HEALTH_RUN_HANDLE_PROTOCOL.objective);
		expect(begin.arguments["inputChannel"]).toBe("mcp");
		expect(begin.arguments["idempotencyKey"]).toBe("key-health_begin_run-1");
	});

	it("reads the run handle from the text envelope when structured content is absent", async () => {
		const client = new FakeMcpClient();
		client.responses.set("health_begin_run", {
			content: [{ type: "text", text: JSON.stringify({ runHandle: "text-handle" }) }],
		});
		const session = await openFakeSession(client);
		expect(session.runHandle).toBe("text-handle");
	});

	it("fails when the status check reports an error", async () => {
		const client = new FakeMcpClient();
		client.responses.set(
			"health_get_system_status",
			textResult({ error: "domain_unavailable", message: "database down" }, true),
		);
		await expect(openFakeSession(client)).rejects.toBeInstanceOf(McpToolSourceUnavailableError);
		await expect(openFakeSession(client)).rejects.toThrow(/domain_unavailable.*database down/);
	});

	it("fails when the run cannot be opened", async () => {
		const client = new FakeMcpClient();
		client.responses.set(
			"health_begin_run",
			textResult({ error: "unknown_user_binding", message: "no binding" }, true),
		);
		await expect(openFakeSession(client)).rejects.toThrow(/MCP run open failed \(unknown_user_binding\)/);
	});

	it("fails when the run opens without a handle", async () => {
		const client = new FakeMcpClient();
		client.responses.set("health_begin_run", textResult({ journeyId: "j1" }));
		await expect(openFakeSession(client)).rejects.toThrow(/returned no runHandle/);
	});
});

describe("MCP adapter: schema and access-level mapping", () => {
	it("adapts every non-ledger tool and drops the ledger tools", async () => {
		const client = new FakeMcpClient();
		const session = await openFakeSession(client);
		const names = session.registrations.map((entry) => entry.tool.name).sort();
		expect(names).toEqual([
			"health_get_daily_state",
			"health_get_system_status",
			"health_log_meal",
			"health_search_training_media",
		]);
	});

	it("maps read-only risk to read-only and every other risk to write", async () => {
		const session = await openFakeSession(new FakeMcpClient());
		expect(byName(session.registrations, "health_get_daily_state").accessLevel).toBe("read-only");
		expect(byName(session.registrations, "health_log_meal").accessLevel).toBe("write");
	});

	it("strips injected arguments from the schema the model sees", async () => {
		const session = await openFakeSession(new FakeMcpClient());
		const schema = schemaOf(byName(session.registrations, "health_log_meal"));
		const properties = schema["properties"] as Record<string, unknown>;
		expect(Object.keys(properties)).toEqual(["description"]);
		expect(schema["required"]).toEqual(["description"]);
	});

	it("leaves schemas untouched when they declare no injected arguments", async () => {
		const session = await openFakeSession(new FakeMcpClient());
		const schema = schemaOf(byName(session.registrations, "health_search_training_media"));
		expect(schema["required"]).toEqual(["query"]);
		expect(Object.keys(schema["properties"] as Record<string, unknown>)).toEqual(["query"]);
	});

	it("derives a human label and keeps the server description", async () => {
		const session = await openFakeSession(new FakeMcpClient());
		const registration = byName(session.registrations, "health_get_daily_state");
		expect(registration.tool.label).toBe("Health Get Daily State");
		expect(registration.tool.description).toBe("[read-only] Read one projected daily health state.");
	});
});

describe("MCP adapter: call threading and result mapping", () => {
	it("injects the run handle and a fresh idempotency key per call", async () => {
		const client = new FakeMcpClient();
		const session = await openFakeSession(client);
		const logMeal = byName(session.registrations, "health_log_meal").tool;

		await logMeal.execute("call-1", { description: "牛肉面" } as never);
		await logMeal.execute("call-2", { description: "鸡蛋" } as never);

		const calls = client.calls.filter((call) => call.name === "health_log_meal");
		expect(calls).toHaveLength(2);
		expect(calls[0]!.arguments).toEqual({
			description: "牛肉面",
			runHandle: RUN_HANDLE,
			idempotencyKey: "key-health_log_meal-2",
		});
		expect(calls[1]!.arguments["idempotencyKey"]).toBe("key-health_log_meal-3");
	});

	it("does not inject arguments a tool never declared", async () => {
		const client = new FakeMcpClient();
		const session = await openFakeSession(client);
		await byName(session.registrations, "health_search_training_media").tool.execute(
			"call-1",
			{ query: "squat" } as never,
		);
		const call = client.calls.find((entry) => entry.name === "health_search_training_media")!;
		expect(call.arguments).toEqual({ query: "squat" });
	});

	it("returns MCP content as text and structured content as details", async () => {
		const client = new FakeMcpClient();
		client.responses.set("health_get_daily_state", textResult({ localDate: "2026-09-05", revision: 4 }));
		const session = await openFakeSession(client);
		const result = await byName(session.registrations, "health_get_daily_state").tool.execute(
			"call-1",
			{} as never,
		);
		expect(result.content).toEqual([{ type: "text", text: '{"localDate":"2026-09-05","revision":4}' }]);
		expect(result.details).toEqual({ localDate: "2026-09-05", revision: 4 });
	});

	it("throws a typed error when the server flags the result", async () => {
		const client = new FakeMcpClient();
		client.responses.set(
			"health_log_meal",
			textResult({ error: "validation_failed", message: "runHandle is required" }, true),
		);
		const session = await openFakeSession(client);
		const execute = byName(session.registrations, "health_log_meal").tool.execute;
		await expect(execute("call-1", { description: "x" } as never)).rejects.toBeInstanceOf(McpToolCallError);
		await expect(execute("call-2", { description: "x" } as never)).rejects.toThrow(
			"health_log_meal failed (validation_failed): runHandle is required",
		);
	});

	it("reads the error code out of a text-only error envelope", async () => {
		const client = new FakeMcpClient();
		client.responses.set("health_log_meal", {
			content: [{ type: "text", text: JSON.stringify({ error: "state_conflict", message: "stale" }) }],
			isError: true,
		});
		const session = await openFakeSession(client);
		await expect(
			byName(session.registrations, "health_log_meal").tool.execute("c", { description: "x" } as never),
		).rejects.toThrow("health_log_meal failed (state_conflict): stale");
	});
});

describe("MCP adapter: close", () => {
	it("ends the run then closes the client, and is idempotent", async () => {
		const client = new FakeMcpClient();
		const session = await openFakeSession(client);
		await session.close();
		await session.close();

		const end = client.calls.find((call) => call.name === "health_end_run");
		expect(end?.arguments).toEqual({
			runHandle: RUN_HANDLE,
			outcome: "completed",
			idempotencyKey: "key-health_end_run-2",
		});
		expect(client.closed).toBe(1);
	});

	it("still closes the client, with a warning, when ending the run throws", async () => {
		const client = new FakeMcpClient();
		const warnings: string[] = [];
		const session = await openMcpToolSession(client, {
			runHandle: HEALTH_RUN_HANDLE_PROTOCOL,
			newIdempotencyKey: keys({ value: 1 }),
			warn: (message) => warnings.push(message),
		});
		client.callTool = async () => {
			throw new Error("pipe closed");
		};

		await session.close();

		expect(client.closed).toBe(1);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("MCP run close failed: pipe closed");
	});
});

describe("health tool source resolution", () => {
	const previous = process.env["PI_HARNESS_TOOL_SOURCE"];

	beforeEach(async () => {
		delete process.env["PI_HARNESS_TOOL_SOURCE"];
		await closeHealthMcpSession("test-profile");
	});

	function inProcessTools(): ToolRegistration[] {
		return [
			{
				accessLevel: "read-only",
				tool: {
					name: "in_process_tool",
					label: "In Process",
					description: "fallback tool",
					parameters: { type: "object", properties: {} } as never,
					execute: async () => ({ content: [{ type: "text", text: "ok" }], details: null }),
				},
			},
		];
	}

	it("defaults to in-process", () => {
		expect(resolveToolSource()).toBe("in-process");
		expect(resolveToolSource({ toolSource: undefined })).toBe("in-process");
	});

	it("honours the config field over the environment", () => {
		process.env["PI_HARNESS_TOOL_SOURCE"] = "mcp";
		expect(resolveToolSource({ toolSource: "in-process" })).toBe("in-process");
		expect(resolveToolSource()).toBe("mcp");
		process.env["PI_HARNESS_TOOL_SOURCE"] = "nonsense";
		expect(resolveToolSource()).toBe("in-process");
		if (previous === undefined) delete process.env["PI_HARNESS_TOOL_SOURCE"];
		else process.env["PI_HARNESS_TOOL_SOURCE"] = previous;
	});

	it("uses in-process tools without ever connecting when the source is in-process", async () => {
		let connected = false;
		const registrations = await resolveHealthToolRegistrations({
			profileName: "test-profile",
			config: { toolSource: "in-process" },
			inProcess: inProcessTools,
			connect: async () => {
				connected = true;
				return new FakeMcpClient();
			},
		});
		expect(connected).toBe(false);
		expect(registrations.map((entry) => entry.tool.name)).toEqual(["in_process_tool"]);
	});

	it("uses MCP tools and records the session when the source is mcp", async () => {
		const client = new FakeMcpClient();
		const registrations = await resolveHealthToolRegistrations({
			profileName: "test-profile",
			config: { toolSource: "mcp" },
			inProcess: inProcessTools,
			connect: async () => client,
			warn: () => undefined,
		});
		expect(registrations.map((entry) => entry.tool.name)).toContain("health_log_meal");
		expect(registrations.map((entry) => entry.tool.name)).not.toContain("in_process_tool");
		expect(getHealthMcpSession("test-profile")).toBeDefined();

		await closeHealthMcpSession("test-profile");
		expect(getHealthMcpSession("test-profile")).toBeUndefined();
		expect(client.closed).toBe(1);
	});

	it("falls back to in-process and warns with the cause when the server will not start", async () => {
		const warnings: string[] = [];
		const registrations = await resolveHealthToolRegistrations({
			profileName: "test-profile",
			config: { toolSource: "mcp" },
			inProcess: inProcessTools,
			connect: async () => {
				throw new McpToolSourceUnavailableError("could not start MCP server `node stdio.js`: ENOENT");
			},
			warn: (message) => warnings.push(message),
		});
		expect(registrations.map((entry) => entry.tool.name)).toEqual(["in_process_tool"]);
		expect(getHealthMcpSession("test-profile")).toBeUndefined();
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("test-profile falling back to in-process health tools");
		expect(warnings[0]).toContain("ENOENT");
	});

	it("falls back and closes the child when the opening sequence fails", async () => {
		const client = new FakeMcpClient();
		client.responses.set("health_begin_run", textResult({ error: "unknown_user_binding", message: "no" }, true));
		const warnings: string[] = [];
		const registrations = await resolveHealthToolRegistrations({
			profileName: "test-profile",
			config: { toolSource: "mcp" },
			inProcess: inProcessTools,
			connect: async () => client,
			warn: (message) => warnings.push(message),
		});
		expect(registrations.map((entry) => entry.tool.name)).toEqual(["in_process_tool"]);
		expect(client.closed).toBe(1);
		expect(warnings[0]).toContain("unknown_user_binding");
	});
});

describe("health MCP server environment", () => {
	it("supplies the actor and runtime the harness registers under", () => {
		const overridden = ["COMPASS_HEALTH_ACTOR", "COMPASS_HEALTH_RUNTIME_NAME"].filter(
			(key) => (process.env[key]?.trim() ?? "") !== "",
		);
		const env = healthMcpServerEnv();
		expect(env["COMPASS_HEALTH_ACTOR_TYPE"]).toBe("agent");
		expect(env["COMPASS_HEALTH_ALLOW_USER_PROVISIONING"]).toBe("false");
		expect(env["COMPASS_HEALTH_MEDIA_RUNTIME"]).toBe("embedded");
		if (overridden.length === 0) {
			expect(env["COMPASS_HEALTH_ACTOR"]).toBe("pi-harness");
			expect(env["COMPASS_HEALTH_RUNTIME_NAME"]).toBe("pi-harness");
		}
	});

	it("lets the ambient environment override a default", () => {
		const previous = process.env["COMPASS_HEALTH_ACTOR"];
		process.env["COMPASS_HEALTH_ACTOR"] = "custom-actor";
		try {
			expect(healthMcpServerEnv()["COMPASS_HEALTH_ACTOR"]).toBe("custom-actor");
		} finally {
			if (previous === undefined) delete process.env["COMPASS_HEALTH_ACTOR"];
			else process.env["COMPASS_HEALTH_ACTOR"] = previous;
		}
	});
});
