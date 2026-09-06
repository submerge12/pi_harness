/**
 * D3: integration test against the REAL compass-health MCP server.
 *
 * Gated on `PI_HARNESS_MCP_INTEGRATION=1` because it spawns the server, which
 * needs the compass-health-agent build output and a reachable PostgreSQL.
 * Run it with:
 *
 *   PI_HARNESS_MCP_INTEGRATION=1 \
 *   DATABASE_URL=postgres://compass:compass@localhost:5433/compass_health \
 *   npx vitest --run test/integration/mcp-health-tool-source.test.ts
 *
 * It opens exactly one run through the documented ritual and closes it, so the
 * only durable trace is one audited agent_runs row.
 */
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
	healthAccessLevel,
	healthMcpServerSpec,
	HEALTH_RUN_HANDLE_PROTOCOL,
} from "../../src/agents/profiles/compass-health-mcp.ts";
import { connectStdioMcpClient } from "../../src/tools/mcp/stdio-client.ts";
import { openMcpToolSession } from "../../src/tools/mcp/adapter.ts";

const ENABLED = process.env["PI_HARNESS_MCP_INTEGRATION"] === "1";
const EXPECTED_TOOL_COUNT = 33;
/** The two ledger tools the adapter drives itself and never exposes. */
const LEDGER_TOOL_COUNT = 2;

describe.runIf(ENABLED)("compass-health MCP tool source (integration)", () => {
	it("spawns the server, lists 33 tools, and adapts all but the ledger pair", async () => {
		const spec = healthMcpServerSpec();
		const entry = spec.args?.[0];
		expect(entry, "server entry point").toBeDefined();
		if (!existsSync(entry!)) {
			throw new Error(
				`compass-health MCP entry not found at ${entry}. ` +
					"Build compass-health-agent, or set PI_HARNESS_HEALTH_MCP_ENTRY.",
			);
		}

		const client = await connectStdioMcpClient(spec);
		const listed = await client.listTools();
		expect(listed.tools).toHaveLength(EXPECTED_TOOL_COUNT);
		expect(listed.tools.every((tool) => tool.name.startsWith("health_"))).toBe(true);
		expect(listed.tools.map((tool) => tool.name)).toEqual(
			expect.arrayContaining(["health_get_system_status", "health_begin_run", "health_end_run"]),
		);

		const session = await openMcpToolSession(client, {
			runHandle: HEALTH_RUN_HANDLE_PROTOCOL,
			resolveAccessLevel: healthAccessLevel,
			filterTool: (tool) => tool.name !== "health_begin_run" && tool.name !== "health_end_run",
		});
		try {
			expect(session.runHandle).toMatch(/^[0-9a-f-]{36}$/);
			expect(session.registrations).toHaveLength(EXPECTED_TOOL_COUNT - LEDGER_TOOL_COUNT);
			expect(session.registrations.some((entry) => entry.accessLevel === "read-only")).toBe(true);
			expect(session.registrations.some((entry) => entry.accessLevel === "write")).toBe(true);

			// A read that the server requires a run handle for: the adapter must
			// supply it without the schema ever exposing it.
			const dailyState = session.registrations.find(
				(entry) => entry.tool.name === "health_get_daily_state",
			);
			expect(dailyState).toBeDefined();
			const schema = dailyState!.tool.parameters as unknown as Record<string, unknown>;
			expect(Object.keys(schema["properties"] as Record<string, unknown>)).not.toContain("runHandle");

			const result = await dailyState!.tool.execute("integration-1", {} as never);
			expect(result.content[0]?.type).toBe("text");
			expect(String((result.content[0] as { text: string }).text)).toContain("daily-health-state");
		} finally {
			await session.close();
		}
	}, 120_000);
});
