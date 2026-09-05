/**
 * D3: adapt an MCP server's `tools/list` into pi-harness `ToolRegistration`s.
 *
 * The adapter owns three things the model must not have to think about:
 *
 * 1. the opening sequence — a liveness call, then the run-ledger open that
 *    mints the handle every subsequent call carries;
 * 2. argument threading — `runHandle` and `idempotencyKey` are injected per
 *    call and stripped from the schema the model sees, so the model cannot
 *    invent, omit, or reuse them;
 * 3. result and error mapping — MCP content/structuredContent becomes an
 *    `AgentToolResult`, and `isError: true` becomes a thrown
 *    {@link McpToolCallError}, matching pi's "throw on failure" tool contract.
 */
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { TSchema } from "typebox";

import type { ToolAccessLevel, ToolRegistration } from "../types.ts";
import {
	McpToolCallError,
	McpToolSourceUnavailableError,
	type McpCallResult,
	type McpClientLike,
	type McpRunHandleProtocol,
	type McpToolDescriptor,
} from "./types.ts";

export interface McpAdapterOptions {
	/** Run-ledger protocol. Omit for servers that need no handle. */
	runHandle?: McpRunHandleProtocol;
	/** Map a listed tool onto a harness access level. Defaults to `write`. */
	resolveAccessLevel?: (tool: McpToolDescriptor) => ToolAccessLevel;
	/** Drop tools from the adapted surface (e.g. the ledger tools themselves). */
	filterTool?: (tool: McpToolDescriptor) => boolean;
	/** Generates idempotency keys. Injected for deterministic tests. */
	newIdempotencyKey?: (toolName: string) => string;
	/** Warning sink. Defaults to `console.warn`. */
	warn?: (message: string) => void;
}

export interface McpToolSession {
	/** Adapted tools, ready for `ToolRegistry.register`. */
	registrations: ToolRegistration[];
	/** The open run handle, when the server uses a run ledger. */
	runHandle?: string;
	/** Close the run (best effort) and the client. Safe to call twice. */
	close(): Promise<void>;
}

const DEFAULT_END_OUTCOME = "completed";

function defaultIdempotencyKey(toolName: string): string {
	return `pi-harness-${toolName}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/** `health_get_daily_state` -> `Health Get Daily State`. */
function toLabel(name: string): string {
	return name
		.split(/[_\-.]+/)
		.filter((part) => part.length > 0)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(" ");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Remove adapter-injected arguments from the schema shown to the model.
 * The returned object is a plain JSON Schema; pi-ai accepts those alongside
 * TypeBox schemas, so no TypeBox round-trip is needed.
 */
function stripInjectedArguments(
	inputSchema: Record<string, unknown>,
	injected: readonly string[],
): { schema: Record<string, unknown>; declared: Set<string> } {
	const declared = new Set<string>();
	if (injected.length === 0) return { schema: { ...inputSchema }, declared };

	const properties = isRecord(inputSchema["properties"]) ? { ...inputSchema["properties"] } : undefined;
	for (const name of injected) {
		if (properties && name in properties) {
			declared.add(name);
			delete properties[name];
		}
	}
	const required = Array.isArray(inputSchema["required"])
		? inputSchema["required"].filter((entry) => typeof entry !== "string" || !declared.has(entry))
		: undefined;

	const schema: Record<string, unknown> = { ...inputSchema };
	if (properties) schema["properties"] = properties;
	if (required) schema["required"] = required;
	return { schema, declared };
}

function resultText(result: McpCallResult): string {
	const texts = (result.content ?? [])
		.filter((entry) => entry.type === "text" && typeof entry.text === "string")
		.map((entry) => entry.text as string);
	if (texts.length > 0) return texts.join("\n");
	if (result.structuredContent) return JSON.stringify(result.structuredContent, null, 2);
	return "";
}

/** Pull `{ error, message }` out of an error result, whatever shape it took. */
function errorDetails(result: McpCallResult): { code: string; message: string } {
	const structured = result.structuredContent;
	if (structured) {
		const code = structured["error"] ?? structured["code"];
		const message = structured["message"];
		if (typeof code === "string") {
			return { code, message: typeof message === "string" ? message : code };
		}
	}
	const text = resultText(result);
	try {
		const parsed: unknown = JSON.parse(text);
		if (isRecord(parsed) && typeof parsed["error"] === "string") {
			const message = parsed["message"];
			return { code: parsed["error"], message: typeof message === "string" ? message : parsed["error"] };
		}
	} catch {
		// Not JSON — fall through to the raw text.
	}
	return { code: "tool_error", message: text || "unknown MCP tool error" };
}

function toAgentToolResult(result: McpCallResult): AgentToolResult<unknown> {
	return {
		content: [{ type: "text", text: resultText(result) }],
		details: result.structuredContent ?? null,
	};
}

/** Read the run handle out of the begin-run result, tolerating either envelope. */
function readRunHandle(result: McpCallResult, field: string): string {
	const structured = result.structuredContent;
	if (structured && typeof structured[field] === "string") return structured[field];
	try {
		const parsed: unknown = JSON.parse(resultText(result));
		if (isRecord(parsed) && typeof parsed[field] === "string") return parsed[field];
	} catch {
		// fall through
	}
	throw new McpToolSourceUnavailableError(`MCP run open returned no ${field}`);
}

/**
 * Perform the opening sequence, list the tools, and adapt each one.
 *
 * The client must already be connected. On any failure the caller is expected
 * to fall back to its in-process tools; the thrown error names the cause.
 */
export async function openMcpToolSession(
	client: McpClientLike,
	options: McpAdapterOptions = {},
): Promise<McpToolSession> {
	const warn = options.warn ?? ((message: string) => console.warn(message));
	const newKey = options.newIdempotencyKey ?? defaultIdempotencyKey;
	const protocol = options.runHandle;
	const idempotencyArgument = protocol?.idempotencyArgument;

	let runHandle: string | undefined;
	if (protocol) {
		if (protocol.statusTool) {
			const status = await client.callTool({ name: protocol.statusTool, arguments: {} });
			if (status.isError) {
				const { code, message } = errorDetails(status);
				throw new McpToolSourceUnavailableError(
					`MCP status check ${protocol.statusTool} failed (${code}): ${message}`,
				);
			}
		}
		const beginArguments: Record<string, unknown> = {
			objective: protocol.objective,
			...protocol.beginArguments,
		};
		if (idempotencyArgument && beginArguments[idempotencyArgument] === undefined) {
			beginArguments[idempotencyArgument] = newKey(protocol.beginTool);
		}
		const begin = await client.callTool({ name: protocol.beginTool, arguments: beginArguments });
		if (begin.isError) {
			const { code, message } = errorDetails(begin);
			throw new McpToolSourceUnavailableError(`MCP run open failed (${code}): ${message}`);
		}
		runHandle = readRunHandle(begin, protocol.handleResultField);
	}

	const listed = await client.listTools();
	const injectable = [
		...(protocol ? [protocol.handleArgument] : []),
		...(idempotencyArgument ? [idempotencyArgument] : []),
	];

	const registrations: ToolRegistration[] = [];
	for (const tool of listed.tools) {
		if (options.filterTool && !options.filterTool(tool)) continue;
		const inputSchema = isRecord(tool.inputSchema) ? tool.inputSchema : { type: "object" };
		const { schema, declared } = stripInjectedArguments(inputSchema, injectable);
		const needsHandle = protocol !== undefined && declared.has(protocol.handleArgument);
		const needsKey = idempotencyArgument !== undefined && declared.has(idempotencyArgument);
		const toolName = tool.name;

		registrations.push({
			accessLevel: options.resolveAccessLevel?.(tool) ?? "write",
			tool: {
				name: toolName,
				label: toLabel(toolName),
				description: tool.description ?? `MCP tool ${toolName}`,
				// Plain JSON Schema; pi-ai validates TypeBox and JSON Schema alike.
				parameters: schema as unknown as TSchema,
				async execute(_toolCallId: string, params: unknown): Promise<AgentToolResult<unknown>> {
					const args: Record<string, unknown> = isRecord(params) ? { ...params } : {};
					if (needsHandle && protocol) {
						if (!runHandle) {
							throw new McpToolCallError(toolName, "run_handle_missing", "the MCP run is not open");
						}
						args[protocol.handleArgument] = runHandle;
					}
					if (needsKey && idempotencyArgument && args[idempotencyArgument] === undefined) {
						args[idempotencyArgument] = newKey(toolName);
					}
					const result = await client.callTool({ name: toolName, arguments: args });
					if (result.isError) {
						const { code, message } = errorDetails(result);
						throw new McpToolCallError(toolName, code, message);
					}
					return toAgentToolResult(result);
				},
			},
		});
	}

	let closed = false;
	return {
		registrations,
		...(runHandle ? { runHandle } : {}),
		async close(): Promise<void> {
			if (closed) return;
			closed = true;
			if (protocol?.endTool && runHandle) {
				const endArguments: Record<string, unknown> = {
					[protocol.handleArgument]: runHandle,
					outcome: protocol.endOutcome ?? DEFAULT_END_OUTCOME,
				};
				if (idempotencyArgument) endArguments[idempotencyArgument] = newKey(protocol.endTool);
				try {
					await client.callTool({ name: protocol.endTool, arguments: endArguments });
				} catch (error) {
					warn(`pi-harness: MCP run close failed: ${describe(error)}`);
				}
			}
			try {
				await client.close();
			} catch (error) {
				warn(`pi-harness: MCP client close failed: ${describe(error)}`);
			}
		},
	};
}

export function describe(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}
