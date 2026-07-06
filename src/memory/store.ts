import type { UserMemoryRecord } from "./schemas/user-memory.ts";

const TRUST_RANK = {
	model_inferred: 0,
	tool_evidenced: 1,
	user_confirmed: 2,
} satisfies Record<UserMemoryRecord["trust"], number>;

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
			if (shouldAdoptMetadata(duplicate, record)) {
				duplicate.trust = strongestTrust(duplicate.trust, record.trust);
				duplicate.source = record.source;
				duplicate.sensitivity = record.sensitivity;
				duplicate.validFrom = record.validFrom;
				duplicate.observedAt = Math.min(duplicate.observedAt, record.observedAt);
				copyOptionalNumber(duplicate, record, "validTo");
				copyOptionalNumber(duplicate, record, "expiresAt");
				copyOptionalString(duplicate, record, "category");
			}
			return cloneRecord(duplicate);
		}

		const stored = cloneRecord(record);
		this.entries.push(stored);
		return cloneRecord(stored);
	}

	deleteExpired(now: number): number {
		let removed = 0;
		for (let index = this.entries.length - 1; index >= 0; index -= 1) {
			const record = this.entries[index];
			if (record?.expiresAt === undefined || record.expiresAt > now) continue;
			this.entries.splice(index, 1);
			removed += 1;
		}
		return removed;
	}
}

function strongestTrust(
	left: UserMemoryRecord["trust"],
	right: UserMemoryRecord["trust"],
): UserMemoryRecord["trust"] {
	return TRUST_RANK[left] >= TRUST_RANK[right] ? left : right;
}

function shouldAdoptMetadata(current: UserMemoryRecord, incoming: UserMemoryRecord): boolean {
	const trustDelta = TRUST_RANK[incoming.trust] - TRUST_RANK[current.trust];
	if (trustDelta !== 0) return trustDelta > 0;
	return incoming.lastConfirmedAt >= current.lastConfirmedAt;
}

function copyOptionalNumber(
	target: UserMemoryRecord,
	source: UserMemoryRecord,
	key: "validTo" | "expiresAt",
): void {
	if (source[key] === undefined) {
		delete target[key];
		return;
	}
	target[key] = source[key];
}

function copyOptionalString(
	target: UserMemoryRecord,
	source: UserMemoryRecord,
	key: "category",
): void {
	if (source[key] === undefined) {
		delete target[key];
		return;
	}
	target[key] = source[key];
}
