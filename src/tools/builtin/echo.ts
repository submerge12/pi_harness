import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { Static, TSchema } from "typebox";

const defaultEchoParameters = Type.Object({ message: Type.String() });

export interface EchoToolDetails<TParameters extends TSchema> {
	toolCallId: string;
	input: Static<TParameters>;
}

function stableStringify(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
	const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right));
	return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(",")}}`;
}

function echoText(input: unknown): string {
	if (input && typeof input === "object" && "message" in input) {
		const message = (input as { message?: unknown }).message;
		if (typeof message === "string") return message;
	}
	return stableStringify(input);
}

export function createEchoTool(): AgentTool<typeof defaultEchoParameters, EchoToolDetails<typeof defaultEchoParameters>>;
export function createEchoTool(
	name: string,
): AgentTool<typeof defaultEchoParameters, EchoToolDetails<typeof defaultEchoParameters>>;
export function createEchoTool<TParameters extends TSchema>(
	name: string,
	parameters: TParameters,
): AgentTool<TParameters, EchoToolDetails<TParameters>>;
export function createEchoTool<TParameters extends TSchema>(
	name = "echo",
	parameters?: TParameters,
): AgentTool<TParameters | typeof defaultEchoParameters, EchoToolDetails<TParameters | typeof defaultEchoParameters>> {
	const effectiveParameters = parameters ?? defaultEchoParameters;
	return {
		name,
		label: "Echo",
		description: "Echoes the provided input.",
		parameters: effectiveParameters,
		async execute(toolCallId, params) {
			return {
				content: [{ type: "text", text: echoText(params) }],
				details: { toolCallId, input: params },
			};
		},
	};
}
