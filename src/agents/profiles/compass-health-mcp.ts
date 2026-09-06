/**
 * D3: compass-health tools sourced from the compass-health MCP server.
 *
 * The harness may take the health tool surface from the MCP server instead of
 * the in-process factories. In-process stays the default and the automatic
 * fallback: when the MCP process cannot be started or its opening sequence
 * fails, the profile logs a warning naming the cause and registers its
 * in-process tools instead, so a health agent never comes up tool-less.
 *
 * Opening sequence mirrored from compass-health's MCP startup ritual:
 *   1. connect over stdio, pinned to protocol 2026-07-28;
 *   2. `health_get_system_status` — end-to-end liveness;
 *   3. `health_begin_run` — mints the runHandle every other tool requires;
 *   4. every call carries that handle plus a fresh idempotency key;
 *   5. `health_end_run` on dispose.
 */
import { fileURLToPath } from "node:url";

import type { ResolvedHarnessConfig } from "../../config.ts";
import { describe } from "../../tools/mcp/adapter.ts";
import {
	connectStdioMcpClient,
	isToolSource,
	openMcpToolSession,
	type McpClientLike,
	type McpRunHandleProtocol,
	type McpStdioServerSpec,
	type McpToolDescriptor,
	type McpToolSession,
	type ToolSource,
} from "../../tools/mcp/index.ts";
import type { ToolAccessLevel, ToolRegistration } from "../../tools/types.ts";

/** compass-health's `_meta` risk key, used to derive the access level. */
const RISK_META_KEY = "compass.health/risk";

/** Ledger tools the adapter drives itself; never exposed to the model. */
const LEDGER_TOOLS = new Set(["health_begin_run", "health_end_run"]);

export const HEALTH_RUN_HANDLE_PROTOCOL: McpRunHandleProtocol = {
	statusTool: "health_get_system_status",
	beginTool: "health_begin_run",
	endTool: "health_end_run",
	handleArgument: "runHandle",
	handleResultField: "runHandle",
	objective: "pi-harness health agent session",
	beginArguments: { inputChannel: "mcp" },
	endOutcome: "completed",
	idempotencyArgument: "idempotencyKey",
};

/**
 * Environment the compass-health MCP server requires. Anything already set in
 * the process environment wins, so a deployment can override without code
 * changes; these are the pi-harness defaults.
 */
export function healthMcpServerEnv(): Record<string, string> {
	const defaults: Record<string, string> = {
		COMPASS_HEALTH_ACTOR: "pi-harness",
		COMPASS_HEALTH_ACTOR_TYPE: "agent",
		COMPASS_HEALTH_ALLOW_USER_PROVISIONING: "false",
		COMPASS_HEALTH_MEDIA_RUNTIME: "embedded",
		COMPASS_HEALTH_PROJECTION_WORKER_MODE: "embedded",
		COMPASS_HEALTH_RUNTIME_NAME: "pi-harness",
		COMPASS_HEALTH_USER_BINDING: "default-user",
	};
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(defaults)) {
		env[key] = process.env[key]?.trim() || value;
	}
	const databaseUrl = process.env["COMPASS_HEALTH_DATABASE_URL"]?.trim() || process.env["DATABASE_URL"]?.trim();
	if (databaseUrl) env["DATABASE_URL"] = databaseUrl;
	return env;
}

/** Default entry point: the sibling compass-health-agent build output. */
function defaultServerEntry(): string {
	return fileURLToPath(new URL("../../../../compass-health-agent/dist/mcp/stdio.js", import.meta.url));
}

export function healthMcpServerSpec(): McpStdioServerSpec {
	const entry = process.env["PI_HARNESS_HEALTH_MCP_ENTRY"]?.trim() || defaultServerEntry();
	const cwd = process.env["PI_HARNESS_HEALTH_MCP_CWD"]?.trim();
	return {
		command: process.env["PI_HARNESS_HEALTH_MCP_COMMAND"]?.trim() || process.execPath,
		args: [entry],
		env: healthMcpServerEnv(),
		clientName: "pi-harness",
		...(cwd ? { cwd } : {}),
	};
}

/** compass-health risk tier -> harness access level. Non-reads are writes. */
export function healthAccessLevel(tool: McpToolDescriptor): ToolAccessLevel {
	const risk = tool._meta?.[RISK_META_KEY];
	return risk === "read-only" ? "read-only" : "write";
}

/**
 * Resolve the configured tool source.
 * Precedence: explicit config field, then `PI_HARNESS_TOOL_SOURCE`, then
 * `in-process`. An unrecognised value falls back to `in-process`.
 */
export function resolveToolSource(config?: Pick<ResolvedHarnessConfig, "toolSource">): ToolSource {
	if (config?.toolSource && isToolSource(config.toolSource)) return config.toolSource;
	const fromEnv = process.env["PI_HARNESS_TOOL_SOURCE"]?.trim();
	if (isToolSource(fromEnv)) return fromEnv;
	return "in-process";
}

// ── session registry ─────────────────────────────────────────────────────────
//
// `createAgent` resolves tool factories BEFORE calling `profile.install`, so the
// factory opens the session and stores it here; the profile's install hook then
// returns a disposer that closes it.

const sessions = new Map<string, McpToolSession>();

export function getHealthMcpSession(profileName: string): McpToolSession | undefined {
	return sessions.get(profileName);
}

/** Close and forget a profile's MCP session. Safe when none is open. */
export async function closeHealthMcpSession(profileName: string): Promise<void> {
	const session = sessions.get(profileName);
	if (!session) return;
	sessions.delete(profileName);
	await session.close();
}

export interface HealthToolSourceOptions {
	profileName: string;
	/** Tools used when the source is in-process, or when MCP is unavailable. */
	inProcess: () => ToolRegistration[] | Promise<ToolRegistration[]>;
	config?: Pick<ResolvedHarnessConfig, "toolSource">;
	/** Test seam: supply a client instead of spawning the real server. */
	connect?: () => Promise<McpClientLike>;
	warn?: (message: string) => void;
}

/**
 * Return a health profile's tools from the configured source, falling back to
 * the in-process registrations when MCP is unavailable.
 */
export async function resolveHealthToolRegistrations(
	options: HealthToolSourceOptions,
): Promise<ToolRegistration[]> {
	const warn = options.warn ?? ((message: string) => console.warn(message));
	const source = resolveToolSource(options.config);
	if (source !== "mcp") return await options.inProcess();

	try {
		const client = await (options.connect ?? (() => connectStdioMcpClient(healthMcpServerSpec())))();
		let session: McpToolSession;
		try {
			session = await openMcpToolSession(client, {
				runHandle: HEALTH_RUN_HANDLE_PROTOCOL,
				resolveAccessLevel: healthAccessLevel,
				filterTool: (tool) => !LEDGER_TOOLS.has(tool.name),
				warn,
			});
		} catch (error) {
			// The process started but the ritual failed — do not leak the child.
			await client.close().catch(() => undefined);
			throw error;
		}
		await closeHealthMcpSession(options.profileName);
		sessions.set(options.profileName, session);
		return session.registrations;
	} catch (error) {
		warn(
			`pi-harness: ${options.profileName} falling back to in-process health tools — ` +
				`MCP tool source unavailable: ${describe(error)}`,
		);
		return await options.inProcess();
	}
}

/**
 * Install-hook disposer for a health profile: closes the MCP session when one
 * was opened, and always runs `inProcessDispose` when it was given.
 */
export function healthProfileDisposer(
	profileName: string,
	inProcessDispose?: () => void | Promise<void>,
): () => Promise<void> {
	return async () => {
		await closeHealthMcpSession(profileName);
		if (inProcessDispose) await inProcessDispose();
	};
}
