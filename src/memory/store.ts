import type { UserMemoryRecord } from "./schemas/user-memory.ts";

function cloneRecord(record: UserMemoryRecord): UserMemoryRecord {
	return { ...record };
}

function isSameFact(left: UserMemoryRecord, right: UserMemoryRecord): boolean {
	return (
		left.scope === right.scope &&
		left.subject === right.subject &&
		left.predicate === right.predicate &&
		left.object === right.object
	);
}

export class InMemoryUserMemoryStore {
	private readonly entries: UserMemoryRecord[] = [];

	records(): UserMemoryRecord[] {
		return this.entries.map(cloneRecord);
	}

	upsert(record: UserMemoryRecord): UserMemoryRecord {
		const duplicate = this.entries.find((entry) => isSameFact(entry, record));
		if (duplicate) {
			duplicate.lastConfirmedAt = Math.max(duplicate.lastConfirmedAt, record.lastConfirmedAt);
			return cloneRecord(duplicate);
		}

		const stored = cloneRecord(record);
		this.entries.push(stored);
		return cloneRecord(stored);
	}
}
