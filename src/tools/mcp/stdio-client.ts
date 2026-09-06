/**
 * D3: spawn an MCP server over stdio and connect a client to it.
 *
 * Kept deliberately thin — everything interesting lives in the adapter, which
 * talks to `McpClientLike` so unit tests need no child process.
 *
 * The client pins the modern (2026-07-28) negotiation: compass-health serves
 * that revision natively and rejects the 2025 handshake unless it is started
 * with `COMPASS_HEALTH_MCP_LEGACY_CLIENTS=serve`. Pinning avoids depending on
 * that opt-in.
 */
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

import { McpToolSourceUnavailableError, type McpClientLike } from "./types.ts";

/** MCP protocol revision this harness speaks. */
export const MCP_PROTOCOL_VERSION = "2026-07-28";

export interface McpStdioServerSpec {
	command: string;
	args?: readonly string[];
	cwd?: string;
	/** Server environment. Merged over `process.env` unless `inheritEnv` is false. */
	env?: Record<string, string>;
	inheritEnv?: boolean;
	/** Handshake timeout in milliseconds. */
	connectTimeoutMs?: number;
	clientName?: string;
	clientVersion?: string;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;
/** How many trailing stderr lines are quoted back when startup fails. */
const STDERR_TAIL_LINES = 5;

function stringEnv(source: NodeJS.ProcessEnv): Record<string, string> {
	const result: Record<string, string> = {};
	for (const [key, value] of Object.entries(source)) {
		if (typeof value === "string") result[key] = value;
	}
	return result;
}

/**
 * A subclass — deliberately, not a cosmetic one.
 *
 * The SDK runs its `server/discover` era probe on a DISPOSABLE SIBLING process
 * only when the transport is *exactly* `StdioClientTransport`; for subclasses it
 * probes in place (see `readStdioServerParams` in the client bundle). Probing in
 * place is what this harness wants: one child process instead of two, and — via
 * the stderr tail below — the server's own diagnostics when it dies during the
 * probe. The sibling path discards its stderr, which turns "the database is
 * unreachable" into an opaque negotiation failure.
 */
class InPlaceStdioClientTransport extends StdioClientTransport {
	readonly stderrTail: string[] = [];

	override async start(): Promise<void> {
		await super.start();
		const stream = this.stderr;
		if (!stream) return;
		let pending = "";
		stream.on("data", (chunk: Buffer | string) => {
			pending += String(chunk);
			const lines = pending.split(/\r?\n/);
			pending = lines.pop() ?? "";
			for (const line of lines) {
				if (line.trim().length === 0) continue;
				this.stderrTail.push(line.trim());
				if (this.stderrTail.length > STDERR_TAIL_LINES) this.stderrTail.shift();
			}
		});
	}
}

/**
 * Spawn the server and complete the MCP handshake.
 *
 * Throws {@link McpToolSourceUnavailableError} when the process cannot be
 * started or the handshake fails, so callers can fall back deterministically.
 * The server's last stderr lines are appended when it printed any, because a
 * server that exits at startup is the common cause and its own message names it.
 */
export async function connectStdioMcpClient(spec: McpStdioServerSpec): Promise<McpClientLike> {
	const env = {
		...(spec.inheritEnv === false ? {} : stringEnv(process.env)),
		...spec.env,
	};
	const transport = new InPlaceStdioClientTransport({
		command: spec.command,
		args: [...(spec.args ?? [])],
		env,
		// Server diagnostics must not be interleaved into this process's stderr,
		// and the tail is quoted back on failure.
		stderr: "pipe",
		...(spec.cwd ? { cwd: spec.cwd } : {}),
	});
	const client = new Client({
		name: spec.clientName ?? "pi-harness",
		version: spec.clientVersion ?? "0.1.0",
	});
	// Pinned negotiation: no probe of the 2025 era, no legacy fallback.
	client.setVersionNegotiation({ mode: { pin: MCP_PROTOCOL_VERSION } });

	try {
		await client.connect(transport, { timeout: spec.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS });
	} catch (error) {
		try {
			await client.close();
		} catch {
			// The connect already failed; closing is best effort.
		}
		const reason = error instanceof Error ? error.message : String(error);
		const stderr = transport.stderrTail.length > 0 ? `; server stderr: ${transport.stderrTail.join(" | ")}` : "";
		throw new McpToolSourceUnavailableError(
			`could not start MCP server \`${spec.command} ${(spec.args ?? []).join(" ")}\`: ${reason}${stderr}`,
			error,
		);
	}
	return client as unknown as McpClientLike;
}
