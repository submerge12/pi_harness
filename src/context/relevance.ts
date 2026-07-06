import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { createTombstoneAnchor } from "./lifecycle.ts";
import {
	estimateMessageTokens as estimateSingleMessageTokens,
	estimateMessagesTokens,
} from "./token-estimator.ts";

export const DEFAULT_PRUNE_MIN_TURNS_KEPT = 10;
export const DEFAULT_PRUNE_MAX_RESULT_TOKENS = 6000;

export type PrunableReason = "superseded-tool-result" | "oversized-tool-result" | "dead-end-branch";
export type PruneReason =
	| "superseded_tool_result"
	| "oversized_unreferenced_tool_result"
	| "dead_end_branch_marker";
export type PruneAction = "tombstone_tool_result" | "remove_messages";

export interface RelevanceOptions {
	minTurnsKept?: number;
	maxResultTokens?: number;
}

export interface ToolCallInfo {
	id: string;
	name: string;
	argumentsText: string;
	subject?: string;
}

export interface PrunableSpan {
	id: string;
	startIndex: number;
	endIndex: number;
	startTurnIndex: number;
	endTurnIndex: number;
	tokens: number;
	reason: PrunableReason;
	toolCallIds: string[];
	summary: string;
}

export interface PruneCandidate {
	id: string;
	action: PruneAction;
	reason: PruneReason;
	start: number;
	end: number;
	startTurnIndex: number;
	endTurnIndex: number;
	tokens: number;
	tokensBefore: number;
	tokensAfter: number;
	tokensRemoved: number;
	replacementText?: string;
	pairedToolCallIndex?: number;
	toolCallId?: string;
}

interface ToolGroup {
	startIndex: number;
	endIndex: number;
	toolCalls: ToolCallInfo[];
	resultIndexes: number[];
	tokens: number;
	isError: boolean;
	text: string;
	subjects: string[];
}

export function findPrunableSpans(messages: AgentMessage[], options: RelevanceOptions = {}): PrunableSpan[] {
	const minTurnsKept = options.minTurnsKept ?? DEFAULT_PRUNE_MIN_TURNS_KEPT;
	const maxResultTokens = options.maxResultTokens ?? DEFAULT_PRUNE_MAX_RESULT_TOKENS;
	const protectedStart = findProtectedStartIndex(messages, minTurnsKept);
	const groups = buildToolGroups(messages);
	const spans: PrunableSpan[] = [];
	const usedRanges: Array<{ startIndex: number; endIndex: number }> = [];

	for (const [index, group] of groups.entries()) {
		if (isProtectedSpan(messages, group.startIndex, group.endIndex, protectedStart)) continue;
		const reason = classifyGroup(group, groups.slice(index + 1), messages, maxResultTokens);
		if (!reason) continue;
		if (usedRanges.some((range) => rangesOverlap(range.startIndex, range.endIndex, group.startIndex, group.endIndex))) {
			continue;
		}
		usedRanges.push({ startIndex: group.startIndex, endIndex: group.endIndex });
		spans.push(createSpan(messages, group, reason));
	}

	return spans.sort((left, right) => left.startIndex - right.startIndex);
}

export function detectPruningCandidates(messages: AgentMessage[], options: RelevanceOptions = {}): PruneCandidate[] {
	const minTurnsKept = options.minTurnsKept ?? DEFAULT_PRUNE_MIN_TURNS_KEPT;
	const maxResultTokens = options.maxResultTokens ?? DEFAULT_PRUNE_MAX_RESULT_TOKENS;
	const protectedStart = findProtectedStartIndex(messages, minTurnsKept);
	const groups = buildToolGroups(messages);
	const candidates: PruneCandidate[] = [];

	for (const [index, group] of groups.entries()) {
		const reason = classifyGroup(group, groups.slice(index + 1), messages, maxResultTokens);
		if (
			(reason === "superseded-tool-result" || reason === "oversized-tool-result") &&
			canUseToolResultCandidate(messages, group, protectedStart)
		) {
			addCandidate(candidates, createToolResultCandidate(messages, group, reason));
		}
	}
	for (const candidate of createDeadEndCandidates(messages, protectedStart)) {
		addCandidate(candidates, candidate);
	}

	return candidates.sort((left, right) => left.start - right.start);
}

export function applyPrunableSpans(messages: AgentMessage[], spans: readonly PrunableSpan[]): AgentMessage[] {
	if (spans.length === 0) return messages;
	const sorted = [...spans].sort((left, right) => left.startIndex - right.startIndex);
	const result: AgentMessage[] = [];
	let spanIndex = 0;
	for (let index = 0; index < messages.length; index++) {
		const span = sorted[spanIndex];
		if (span && index === span.startIndex) {
			index = span.endIndex - 1;
			spanIndex++;
			continue;
		}
		result.push(messages[index]);
	}
	return result;
}

function classifyGroup(
	group: ToolGroup,
	laterGroups: readonly ToolGroup[],
	messages: readonly AgentMessage[],
	maxResultTokens: number,
): PrunableReason | undefined {
	if (isPrunedResult(group)) return undefined;
	if (isDeadEnd(group)) return "dead-end-branch";
	if (isSuperseded(group, laterGroups)) return "superseded-tool-result";
	if (group.tokens > maxResultTokens && !isReferencedLater(group, messages)) return "oversized-tool-result";
	return undefined;
}

function createSpan(messages: readonly AgentMessage[], group: ToolGroup, reason: PrunableReason): PrunableSpan {
	const startTurnIndex = turnIndexAt(messages, group.startIndex);
	const endTurnIndex = turnIndexAt(messages, group.endIndex - 1);
	const toolCallIds = group.toolCalls.map((call) => call.id);
	return {
		id: `${group.startIndex}:${group.endIndex}:${reason}:${toolCallIds.join(",")}`,
		startIndex: group.startIndex,
		endIndex: group.endIndex,
		startTurnIndex,
		endTurnIndex,
		tokens: group.tokens,
		reason,
		toolCallIds,
		summary: `${reason} at turns ${startTurnIndex}-${endTurnIndex}`,
	};
}

function createToolResultCandidate(
	messages: readonly AgentMessage[],
	group: ToolGroup,
	reason: Extract<PrunableReason, "superseded-tool-result" | "oversized-tool-result">,
): PruneCandidate {
	const resultIndex = group.resultIndexes[0] ?? group.endIndex - 1;
	const candidateReason = reason === "superseded-tool-result" ? "superseded_tool_result" : "oversized_unreferenced_tool_result";
	const replacementText = createTombstoneText(candidateReason, turnIndexAt(messages, resultIndex));
	const tokensBefore = estimateSingleMessageTokens(messages[resultIndex]);
	const tokensAfter = estimateSingleMessageTokens(withTextContent(messages[resultIndex], replacementText));
	const tokensRemoved = Math.max(0, tokensBefore - tokensAfter);

	return {
		id: `${candidateReason}:${group.startIndex}:${resultIndex}`,
		action: "tombstone_tool_result",
		reason: candidateReason,
		start: resultIndex,
		end: resultIndex,
		startTurnIndex: turnIndexAt(messages, group.startIndex),
		endTurnIndex: turnIndexAt(messages, resultIndex),
		tokens: tokensRemoved,
		tokensBefore,
		tokensAfter,
		tokensRemoved,
		replacementText,
		pairedToolCallIndex: group.startIndex,
		toolCallId: group.toolCalls[0]?.id,
	};
}

function createDeadEndCandidates(messages: readonly AgentMessage[], protectedStart: number): PruneCandidate[] {
	const candidates: PruneCandidate[] = [];
	for (let index = 0; index < messages.length; index++) {
		if (!isExplicitDeadEndMarker(messages[index])) continue;
		const startIndex = findPreviousUserIndex(messages, index - 1);
		if (startIndex < 0 || isProtectedSpan(messages, startIndex, index, protectedStart)) continue;
		const tokensBefore = estimateMessagesTokens(messages.slice(startIndex, index));
		candidates.push({
			id: `dead-end:${startIndex}:${index - 1}`,
			action: "remove_messages",
			reason: "dead_end_branch_marker",
			start: startIndex,
			end: index - 1,
			startTurnIndex: turnIndexAt(messages, startIndex),
			endTurnIndex: turnIndexAt(messages, index - 1),
			tokens: tokensBefore,
			tokensBefore,
			tokensAfter: 0,
			tokensRemoved: tokensBefore,
		});
	}
	return candidates;
}

function canUseToolResultCandidate(messages: readonly AgentMessage[], group: ToolGroup, protectedStart: number): boolean {
	if (group.resultIndexes.length !== 1 || group.toolCalls.length !== 1) {
		return false;
	}
	const resultIndex = group.resultIndexes[0];
	if (resultIndex === undefined || isProtectedSpan(messages, resultIndex, resultIndex + 1, protectedStart)) {
		return false;
	}
	if (isProtectedSpan(messages, group.startIndex, group.startIndex + 1, protectedStart)) {
		return false;
	}
	return !isPrunedResult(group);
}

function addCandidate(candidates: PruneCandidate[], candidate: PruneCandidate): void {
	if (candidate.tokensRemoved <= 0 && candidate.reason !== "oversized_unreferenced_tool_result") return;
	if (candidates.some((existing) => rangesOverlap(existing.start, existing.end + 1, candidate.start, candidate.end + 1))) {
		return;
	}
	candidates.push(candidate);
}

function createTombstoneText(reason: PruneReason, turnIndex: number): string {
	const tombstone = createTombstoneAnchor({
		removedSummary: `[result pruned: ${reason} from turn ${turnIndex}]`,
		anchorId: `context-prune:${reason}:turn-${turnIndex}`,
		retrievableFrom: "session custom prune entry",
		reason,
	});
	return tombstone.text;
}

function withTextContent(message: AgentMessage, text: string): AgentMessage {
	const record = asRecord(message) ?? {};
	return { ...record, content: [{ type: "text", text }] } as unknown as AgentMessage;
}

function isPrunedResult(group: ToolGroup): boolean {
	return group.text.includes("[result pruned:");
}

function isExplicitDeadEndMarker(message: AgentMessage | undefined): boolean {
	const record = asRecord(message);
	if (record?.role !== "user") return false;
	const text = messageText(message).toLowerCase();
	if (/\b(?:do not|don'?t)\s+(?:forget|ignore|disregard|scrap|drop)\s+(?:that|this|previous)\b/.test(text)) {
		return false;
	}
	const instructionBoundary = "(?:^|[.!?]\\s+)";
	const deadEndInstruction = new RegExp(
		`${instructionBoundary}(?:please\\s+)?(?:actually,\\s*)?(?:forget|ignore|disregard|scrap|drop)\\s+(?:that|this|previous)\\b`,
	);
	const neverMindInstruction = new RegExp(`${instructionBoundary}(?:never mind|nevermind)\\b`);
	return deadEndInstruction.test(text.trimStart()) || neverMindInstruction.test(text.trimStart());
}

function findPreviousUserIndex(messages: readonly AgentMessage[], startIndex: number): number {
	for (let index = startIndex; index >= 0; index--) {
		if (asRecord(messages[index])?.role === "user") return index;
	}
	return -1;
}

function buildToolGroups(messages: readonly AgentMessage[]): ToolGroup[] {
	const groups: ToolGroup[] = [];
	let index = 0;
	while (index < messages.length) {
		const toolCalls = getToolCalls(messages[index]);
		if (toolCalls.length === 0) {
			index++;
			continue;
		}

		const pendingIds = new Set(toolCalls.map((call) => call.id));
		const resultIndexes: number[] = [];
		let endIndex = index + 1;
		let isError = false;
		while (endIndex < messages.length && pendingIds.size > 0) {
			const resultId = getToolResultCallId(messages[endIndex]);
			if (!resultId || !pendingIds.has(resultId)) break;
			resultIndexes.push(endIndex);
			pendingIds.delete(resultId);
			if (isToolResultError(messages[endIndex])) isError = true;
			endIndex++;
		}

		if (pendingIds.size === 0 && resultIndexes.length > 0) {
			const groupMessages = messages.slice(index, endIndex);
			const resultMessages = resultIndexes.map((resultIndex) => messages[resultIndex]);
			groups.push({
				startIndex: index,
				endIndex,
				toolCalls,
				resultIndexes,
				tokens: estimateMessagesTokens(groupMessages),
				isError,
				text: resultMessages.map(messageText).join("\n"),
				subjects: uniqueStrings(toolCalls.map((call) => call.subject).filter((subject): subject is string => Boolean(subject))),
			});
		}
		index = Math.max(endIndex, index + 1);
	}
	return groups;
}

function isSuperseded(group: ToolGroup, laterGroups: readonly ToolGroup[]): boolean {
	if (group.subjects.length === 0) return false;
	for (const later of laterGroups) {
		if (!sharesSubject(group, later)) continue;
		if (group.isError && !later.isError) return true;
		if (group.toolCalls.some((call) => isReadLike(call.name)) && later.toolCalls.some((call) => isReadLike(call.name) || isWriteLike(call.name))) {
			return true;
		}
		if (group.toolCalls.some((call) => isDirectoryListing(call)) && later.toolCalls.some((call) => isReadLike(call.name) || isWriteLike(call.name))) {
			return true;
		}
	}
	return false;
}

function sharesSubject(left: ToolGroup, right: ToolGroup): boolean {
	return left.subjects.some((subject) => right.subjects.includes(subject));
}

function isReferencedLater(group: ToolGroup, messages: readonly AgentMessage[]): boolean {
	const laterText = messages.slice(group.endIndex).map(messageText).join("\n").toLowerCase();
	if (!laterText) return false;
	for (const anchor of extractAnchors(group.text)) {
		if (laterText.includes(anchor.toLowerCase())) return true;
	}
	return false;
}

function isDeadEnd(group: ToolGroup): boolean {
	const text = group.text.toLowerCase();
	return (
		text.includes("dead end") ||
		text.includes("dead-end") ||
		text.includes("abandoned attempt") ||
		text.includes("ignore this result") ||
		text.includes("not useful")
	);
}

function isProtectedSpan(
	messages: readonly AgentMessage[],
	startIndex: number,
	endIndex: number,
	protectedStart: number,
): boolean {
	if (endIndex > protectedStart) return true;
	for (let index = startIndex; index < endIndex; index++) {
		const role = asRecord(messages[index])?.role;
		if (role === "system" || isPinnedMessage(messages[index])) return true;
	}
	return false;
}

function findProtectedStartIndex(messages: readonly AgentMessage[], minTurnsKept: number): number {
	if (minTurnsKept <= 0) return messages.length;
	let userTurnsSeen = 0;
	for (let index = messages.length - 1; index >= 0; index--) {
		if (asRecord(messages[index])?.role === "user") {
			userTurnsSeen++;
			if (userTurnsSeen >= minTurnsKept) return index;
		}
	}
	return 0;
}

function turnIndexAt(messages: readonly AgentMessage[], messageIndex: number): number {
	let turnIndex = 0;
	for (let index = 0; index <= messageIndex && index < messages.length; index++) {
		if (asRecord(messages[index])?.role === "user") turnIndex++;
	}
	return Math.max(1, turnIndex);
}

function getToolCalls(message: AgentMessage | undefined): ToolCallInfo[] {
	const record = asRecord(message);
	if (record?.role !== "assistant") return [];
	const calls: ToolCallInfo[] = [];
	const content = record.content;
	if (Array.isArray(content)) {
		for (const part of content) {
			const partRecord = asRecord(part);
			if (partRecord?.type !== "toolCall") continue;
			const id = typeof partRecord.id === "string" ? partRecord.id : undefined;
			const name = typeof partRecord.name === "string" ? partRecord.name : undefined;
			if (!id || !name) continue;
			const argumentsValue = partRecord.arguments;
			const argumentsText = stableStringify(argumentsValue);
			calls.push({ id, name, argumentsText, subject: subjectFromToolCall(name, argumentsValue, argumentsText) });
		}
	}
	for (const key of ["toolCalls", "tool_calls"]) {
		const legacyCalls = record[key];
		if (!Array.isArray(legacyCalls)) continue;
		for (const call of legacyCalls) {
			const callRecord = asRecord(call);
			if (!callRecord) continue;
			const id = typeof callRecord?.id === "string" ? callRecord.id : undefined;
			const name = typeof callRecord?.name === "string" ? callRecord.name : undefined;
			if (!id || !name) continue;
			const argumentsValue = callRecord.arguments ?? callRecord.args;
			const argumentsText = stableStringify(argumentsValue);
			calls.push({ id, name, argumentsText, subject: subjectFromToolCall(name, argumentsValue, argumentsText) });
		}
	}
	return calls;
}

function getToolResultCallId(message: AgentMessage | undefined): string | undefined {
	const record = asRecord(message);
	if (record?.role !== "toolResult" && record?.role !== "tool") return undefined;
	const value = record.toolCallId ?? record.tool_call_id;
	return typeof value === "string" ? value : undefined;
}

function isToolResultError(message: AgentMessage | undefined): boolean {
	const record = asRecord(message);
	return record?.isError === true;
}

function isPinnedMessage(message: AgentMessage | undefined): boolean {
	const record = asRecord(message);
	const metadata = asRecord(record?.metadata);
	if (record?.pinned === true || record?.userPinned === true || metadata?.pinned === true || metadata?.userPinned === true) {
		return true;
	}
	const text = messageText(message).toLowerCase();
	return text.includes("[pin]") || text.includes("#pin") || text.includes("pinned:");
}

function isReadLike(toolName: string): boolean {
	return /read|open|cat|get|list|search|grep|rg|find|ls|dir/i.test(toolName);
}

function isWriteLike(toolName: string): boolean {
	return /write|edit|patch|apply|move|rename|delete|remove|create|update/i.test(toolName);
}

function isDirectoryListing(call: ToolCallInfo): boolean {
	if (/list|ls|dir/i.test(call.name)) return true;
	return /\b(get-childitem|ls|dir)\b/i.test(call.argumentsText);
}

function subjectFromToolCall(toolName: string, value: unknown, fallback: string): string | undefined {
	const direct = subjectFromValue(value);
	if (direct) return direct;
	const pathMatch = /[a-zA-Z]:[\\/][^\s"']+|\/[^\s"']+/.exec(fallback);
	if (pathMatch) return normalizeSubject(pathMatch[0]);
	const trimmed = fallback.trim();
	return trimmed ? normalizeSubject(`${toolName}:${trimmed}`) : undefined;
}

function subjectFromValue(value: unknown): string | undefined {
	if (typeof value === "string") return normalizeSubject(value);
	if (!isRecord(value)) return undefined;
	for (const key of ["path", "file", "filePath", "filename", "target", "cwd", "command"]) {
		const nested = value[key];
		if (typeof nested === "string" && nested.trim()) return normalizeSubject(nested);
	}
	return undefined;
}

function normalizeSubject(value: string): string {
	return value.replaceAll("\\", "/").trim().toLowerCase();
}

function extractAnchors(text: string): string[] {
	const anchors = new Set<string>();
	const matches = text.match(/[A-Za-z0-9][A-Za-z0-9_.:/-]{10,}/g) ?? [];
	for (const match of matches) {
		const anchor = trimAnchor(match);
		if (/^[xX]+$/.test(anchor)) continue;
		anchors.add(anchor);
		if (anchors.size >= 8) break;
	}
	const uppercaseMatches = text.match(/[A-Z][A-Z0-9_]{6,}/g) ?? [];
	for (const match of uppercaseMatches) {
		anchors.add(trimAnchor(match));
		if (anchors.size >= 8) break;
	}
	return [...anchors];
}

function trimAnchor(value: string): string {
	return value.replace(/[_./:-]+$/g, "");
}

function messageText(message: AgentMessage | undefined): string {
	const record = asRecord(message);
	if (!record) return "";
	const content = record.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const part of content) {
		const partRecord = asRecord(part);
		if (partRecord?.type === "text" && typeof partRecord.text === "string") parts.push(partRecord.text);
		else if (partRecord?.type === "thinking" && typeof partRecord.thinking === "string") parts.push(partRecord.thinking);
		else if (partRecord?.type === "toolCall") parts.push(stableStringify(partRecord));
	}
	return parts.join("\n");
}

function stableStringify(value: unknown): string {
	if (value === undefined) return "";
	if (typeof value !== "object" || value === null) return String(value);
	if (Array.isArray(value)) return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
	const record = value as Record<string, unknown>;
	return `{${Object.keys(record)
		.sort()
		.map((key) => `${key}:${stableStringify(record[key])}`)
		.join(",")}}`;
}

function uniqueStrings(values: readonly string[]): string[] {
	return [...new Set(values)];
}

function rangesOverlap(leftStart: number, leftEnd: number, rightStart: number, rightEnd: number): boolean {
	return leftStart < rightEnd && rightStart < leftEnd;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return isRecord(value) ? value : undefined;
}
