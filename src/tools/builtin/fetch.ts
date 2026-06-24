import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { Static } from "typebox";
import type { EvidenceGateway } from "../../evidence/index.ts";
import { getEvidenceCapturedOutput } from "../../evidence/index.ts";
import type { ToolPermissionDecisionLookup } from "../types.ts";

const DEFAULT_MAX_BYTES = 1_000_000;

const fetchParameters = Type.Object({
	url: Type.String(),
	maxBytes: Type.Optional(Type.Number({ minimum: 1 })),
});

export type FetchImplementation = (url: string, init: { method: "GET"; signal?: AbortSignal }) => Promise<Response>;

export interface FetchToolOptions {
	fetch?: FetchImplementation;
	maxBytes?: number;
	evidenceGateway?: EvidenceGateway;
	getPermissionDecision?: ToolPermissionDecisionLookup;
}

export interface FetchToolDetails {
	toolCallId: string;
	url: string;
	status: number;
	truncated: boolean;
	bytesRead: number;
}

interface CappedText {
	text: string;
	truncated: boolean;
	bytesRead: number;
}

type FetchParameters = Static<typeof fetchParameters>;

export function createFetchTool(options: FetchToolOptions = {}): AgentTool<typeof fetchParameters, FetchToolDetails> {
	return {
		name: "fetch",
		label: "Fetch",
		description: "Fetches an HTTP or HTTPS URL with GET and a response size cap.",
		parameters: fetchParameters,
		async execute(toolCallId: string, params: FetchParameters, signal?: AbortSignal) {
			const url = parseHttpUrl(params.url);
			const fetchImpl = options.fetch ?? globalThis.fetch;
			const maxBytes = params.maxBytes ?? options.maxBytes ?? DEFAULT_MAX_BYTES;
			const response = await fetchImpl(url.toString(), { method: "GET", signal });
			const body = await captureFetchEvidence(options, toolCallId, url.toString(), await readResponseText(response, maxBytes), response.status);
			return {
				content: [{ type: "text", text: formatResponse(response, body, maxBytes) }],
				details: { toolCallId, url: url.toString(), status: response.status, truncated: body.truncated, bytesRead: body.bytesRead },
			};
		},
	};
}

async function captureFetchEvidence(
	options: FetchToolOptions,
	toolCallId: string,
	url: string,
	body: CappedText,
	status: number,
): Promise<CappedText> {
	if (!options.evidenceGateway) return body;

	const permissionDecision = options.getPermissionDecision?.(toolCallId);
	const entry = await options.evidenceGateway.captureOutput({
		id: toolCallId,
		command: `fetch ${url}`,
		subject: permissionDecision?.subject ?? url,
		allowed: permissionDecision?.allowed ?? { level: "ask" },
		...(permissionDecision?.writeScope ? { writeScope: permissionDecision.writeScope } : {}),
		actualWritePaths: [],
		stdout: body.text,
		exitCode: status,
	});
	const captured = getEvidenceCapturedOutput(entry);
	if (!captured) throw new Error(`Evidence output unavailable for ${toolCallId}`);

	return {
		...body,
		text: captured.stdout,
		bytesRead: new TextEncoder().encode(captured.stdout).byteLength,
	};
}

async function readResponseText(response: Response, maxBytes: number): Promise<CappedText> {
	if (!response.body) return cappedArrayBuffer(await response.arrayBuffer(), maxBytes);
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let bytesRead = 0;
	while (true) {
		const result = await reader.read();
		if (result.done) return decodeChunks(chunks, false, bytesRead);
		const remaining = maxBytes - bytesRead;
		if (remaining <= 0) {
			await reader.cancel();
			return decodeChunks(chunks, true, bytesRead);
		}
		if (result.value.byteLength > remaining) {
			chunks.push(result.value.slice(0, remaining));
			await reader.cancel();
			return decodeChunks(chunks, true, maxBytes);
		}
		chunks.push(result.value);
		bytesRead += result.value.byteLength;
	}
}

function cappedArrayBuffer(buffer: ArrayBuffer, maxBytes: number): CappedText {
	const bytes = new Uint8Array(buffer);
	const truncated = bytes.byteLength > maxBytes;
	const capped = truncated ? bytes.slice(0, maxBytes) : bytes;
	return { text: new TextDecoder().decode(capped), truncated, bytesRead: capped.byteLength };
}

function decodeChunks(chunks: readonly Uint8Array[], truncated: boolean, bytesRead: number): CappedText {
	const bytes = new Uint8Array(bytesRead);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return { text: new TextDecoder().decode(bytes), truncated, bytesRead };
}

function formatResponse(response: Response, body: CappedText, maxBytes: number): string {
	const contentType = response.headers.get("content-type");
	const headers = contentType ? `\ncontent-type: ${contentType}` : "";
	const notice = body.truncated ? `\n\n[Output truncated to ${maxBytes} bytes.]` : "";
	return `status: ${response.status}${headers}\n\n${body.text}${notice}`;
}

function parseHttpUrl(value: string): URL {
	const url = new URL(value);
	if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`Unsupported URL protocol: ${url.protocol}`);
	return url;
}
