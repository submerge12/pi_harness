/**
 * D3: MCP tool source — shared types.
 *
 * A profile can obtain its tools either from its own in-process factories or
 * from an MCP server. The adapter below speaks only to `McpClientLike`, so the
 * unit tests can drive it with a fake client and the real client stays a thin
 * spawn-and-connect wrapper.
 */

/** Where a profile's tools come from. `in-process` stays the default. */
export type ToolSource = "mcp" | "in-process";

export const TOOL_SOURCES: readonly ToolSource[] = ["mcp", "in-process"] as const;

export function isToolSource(value: unknown): value is ToolSource {
	return value === "mcp" || value === "in-process";
}

/** One tool as reported by `tools/list`. */
export interface McpToolDescriptor {
	name: string;
	description?: string;
	inputSchema: Record<string, unknown>;
	_meta?: Record<string, unknown>;
}

/** One `tools/call` result, in the subset this adapter consumes. */
export interface McpCallResult {
	content?: Array<{ type: string; text?: string; [key: string]: unknown }>;
	structuredContent?: Record<string, unknown>;
	isError?: boolean;
}

/**
 * The slice of `@modelcontextprotocol/client`'s `Client` the adapter uses.
 * Keeping it structural means unit tests need no child process.
 */
export interface McpClientLike {
	listTools(): Promise<{ tools: McpToolDescriptor[] }>;
	callTool(request: { name: string; arguments?: Record<string, unknown> }): Promise<McpCallResult>;
	close(): Promise<void>;
}

/**
 * How the server's run ledger is opened, threaded and closed.
 *
 * compass-health requires this: `health_begin_run` mints a runHandle that every
 * tool declaring a `runHandle` property must carry, and `health_end_run` closes
 * it. The shape is configurable so the adapter is not compass-specific.
 */
export interface McpRunHandleProtocol {
	/** Read-only liveness tool called once before opening the run. Optional. */
	statusTool?: string;
	/** Tool that opens the run (e.g. `health_begin_run`). */
	beginTool: string;
	/** Tool that closes the run (e.g. `health_end_run`). Optional. */
	endTool?: string;
	/** Argument name carrying the handle into every other call. */
	handleArgument: string;
	/** Field of the begin result holding the handle. */
	handleResultField: string;
	/** One-line objective recorded on the run. */
	objective: string;
	/** Extra arguments merged into the begin call (e.g. `inputChannel`). */
	beginArguments?: Record<string, unknown>;
	/** Outcome reported when the session closes cleanly. */
	endOutcome?: string;
	/** Argument name for a per-call idempotency key, auto-filled when declared. */
	idempotencyArgument?: string;
}

/** A tool-call failure reported by the server as `isError: true`. */
export class McpToolCallError extends Error {
	readonly toolName: string;
	readonly code: string;

	constructor(toolName: string, code: string, message: string) {
		super(`${toolName} failed (${code}): ${message}`);
		this.name = "McpToolCallError";
		this.toolName = toolName;
		this.code = code;
	}
}

/** The MCP process could not be started, connected to, or opened. */
export class McpToolSourceUnavailableError extends Error {
	override readonly cause?: unknown;

	constructor(message: string, cause?: unknown) {
		super(message);
		this.name = "McpToolSourceUnavailableError";
		this.cause = cause;
	}
}
