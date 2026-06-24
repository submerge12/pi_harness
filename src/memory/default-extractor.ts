import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { UserMemoryRecord, UserMemoryTrust } from "./schemas/user-memory.ts";

export interface DefaultMemoryExtractorInput {
	rawRequest: string;
	message: AssistantMessage;
	scope: string;
	subject: string;
	now: number;
}

export function extractDefaultMemoryCandidates(input: DefaultMemoryExtractorInput): UserMemoryRecord[] {
	return [
		...extractUserPreferenceMemories(input.rawRequest, input),
		...extractTaggedFactMemories(assistantText(input.message), input),
	];
}

function extractUserPreferenceMemories(
	rawRequest: string,
	options: DefaultMemoryExtractorInput,
): UserMemoryRecord[] {
	const match = /\bI\s+(?:prefer|like)\s+([A-Za-z0-9 _.,-]{2,80})/i.exec(rawRequest);
	if (!match?.[1]) return [];
	const object = cleanupObject(match[1].replace(/\b(?:when|for|and|please)\b.*$/i, ""));
	if (!object) return [];
	return [createRecord({
		scope: options.scope,
		subject: options.subject,
		predicate: "prefers",
		object,
		source: "user request",
		trust: "user_confirmed",
		now: options.now,
	})];
}

function extractTaggedFactMemories(
	text: string,
	options: DefaultMemoryExtractorInput,
): UserMemoryRecord[] {
	const records: UserMemoryRecord[] = [];
	const pattern = /^(tool-evidenced|model-inferred):\s*([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\s*=\s*(.+)$/gim;
	for (const match of text.matchAll(pattern)) {
		const tag = match[1];
		const subject = match[2];
		const predicate = match[3];
		const object = cleanupObject(match[4] ?? "");
		if (!subject || !predicate || !object) continue;
		records.push(createRecord({
			scope: options.scope,
			subject,
			predicate,
			object,
			source: tag === "tool-evidenced" ? "tool evidence" : "model inference",
			trust: tag === "tool-evidenced" ? "tool_evidenced" : "model_inferred",
			now: options.now,
		}));
	}
	return records;
}

function createRecord(input: {
	scope: string;
	subject: string;
	predicate: string;
	object: string;
	source: string;
	trust: UserMemoryTrust;
	now: number;
}): UserMemoryRecord {
	return {
		id: stableMemoryId(input),
		scope: input.scope,
		subject: input.subject,
		predicate: input.predicate,
		object: input.object,
		validFrom: input.now,
		observedAt: input.now,
		lastConfirmedAt: input.now,
		source: input.source,
		trust: input.trust,
		sensitivity: input.trust === "model_inferred" ? "inferred" : "personal",
	};
}

function cleanupObject(value: string): string {
	return value.trim().replace(/[.。!?！？]+$/g, "").trim();
}

function stableMemoryId(input: {
	scope: string;
	subject: string;
	predicate: string;
	object: string;
	trust: UserMemoryTrust;
}): string {
	const base = `${input.scope}-${input.subject}-${input.predicate}-${input.object}-${input.trust}`;
	return base.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

function assistantText(message: AssistantMessage): string {
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			if (!part || typeof part !== "object") return "";
			if (!("type" in part) || part.type !== "text") return "";
			return "text" in part && typeof part.text === "string" ? part.text : "";
		})
		.join("\n");
}
