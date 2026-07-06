import { redactCommandOutput } from "../evidence/redactor.ts";
import type { UserMemoryRecord, UserMemoryTrust } from "./schemas/user-memory.ts";
import type { InMemoryUserMemoryStore } from "./store.ts";

export interface UserMemoryRecallQuery {
	scope?: string;
	subject?: string;
	predicate?: string;
	now?: number;
}

const TRUST_RANK: Record<UserMemoryTrust, number> = {
	model_inferred: 0,
	tool_evidenced: 1,
	user_confirmed: 2,
};

function redactedRecord(record: UserMemoryRecord): UserMemoryRecord {
	return {
		...record,
		object: redactCommandOutput(record.object).text,
		source: redactCommandOutput(record.source).text,
	};
}

function isCurrent(record: UserMemoryRecord, now: number): boolean {
	if (record.validFrom > now) return false;
	if (record.validTo !== undefined && record.validTo <= now) return false;
	if (record.expiresAt !== undefined && record.expiresAt <= now) return false;
	return true;
}

function conflictKey(record: UserMemoryRecord): string {
	return `${record.scope}\u0000${record.subject}\u0000${record.predicate}`;
}

function compareMemoryPriority(left: UserMemoryRecord, right: UserMemoryRecord): number {
	const trustDelta = TRUST_RANK[left.trust] - TRUST_RANK[right.trust];
	if (trustDelta !== 0) return trustDelta;
	return left.lastConfirmedAt - right.lastConfirmedAt;
}

export function writeUserMemory(store: InMemoryUserMemoryStore, record: UserMemoryRecord): UserMemoryRecord {
	return store.upsert(redactedRecord(record));
}

export function recallUserMemories(
	store: InMemoryUserMemoryStore,
	query: UserMemoryRecallQuery = {},
): UserMemoryRecord[] {
	const now = query.now ?? Date.now();
	store.deleteExpired(now);
	const winners = new Map<string, UserMemoryRecord>();

	for (const record of store.records()) {
		if (query.scope !== undefined && record.scope !== "global" && record.scope !== query.scope) continue;
		if (query.subject !== undefined && record.subject !== query.subject) continue;
		if (query.predicate !== undefined && record.predicate !== query.predicate) continue;
		if (!isCurrent(record, now)) continue;

		const key = conflictKey(record);
		const incumbent = winners.get(key);
		if (incumbent === undefined || compareMemoryPriority(record, incumbent) > 0) {
			winners.set(key, record);
		}
	}

	return Array.from(winners.values()).sort((left, right) => {
		const subjectOrder = left.subject.localeCompare(right.subject);
		if (subjectOrder !== 0) return subjectOrder;
		const predicateOrder = left.predicate.localeCompare(right.predicate);
		if (predicateOrder !== 0) return predicateOrder;
		return left.id.localeCompare(right.id);
	});
}
