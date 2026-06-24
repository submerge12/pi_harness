import { Value } from "typebox/value";
import { describe, expect, test } from "vitest";
import {
	InMemoryUserMemoryStore,
	recallUserMemories,
	type UserMemoryRecord,
	writeUserMemory,
} from "../../src/memory/index.ts";
import { userMemoryRecordSchema } from "../../src/memory/schemas/user-memory.ts";

function memory(overrides: Partial<UserMemoryRecord> = {}): UserMemoryRecord {
	return {
		id: "memory-1",
		scope: "global",
		subject: "user",
		predicate: "prefers_drink",
		object: "coffee",
		validFrom: 1_000,
		observedAt: 1_000,
		lastConfirmedAt: 1_000,
		source: "user said so",
		trust: "user_confirmed",
		sensitivity: "personal",
		...overrides,
	};
}

describe("user memory schema", () => {
	test("declares the bitemporal memory record shape without extra properties", () => {
		const schema = userMemoryRecordSchema as typeof userMemoryRecordSchema & { additionalProperties?: boolean };

		expect(schema.additionalProperties).toBe(false);
		expect(Object.keys(userMemoryRecordSchema.properties)).toEqual([
			"id",
			"scope",
			"category",
			"subject",
			"predicate",
			"object",
			"validFrom",
			"validTo",
			"observedAt",
			"lastConfirmedAt",
			"source",
			"trust",
			"sensitivity",
			"expiresAt",
		]);

		expect(userMemoryRecordSchema.required).toContain("scope");
		expect(userMemoryRecordSchema.required).not.toContain("category");
		expect(Value.Check(userMemoryRecordSchema, memory())).toBe(true);
		const { scope, ...missingScope } = memory();
		expect(Value.Check(userMemoryRecordSchema, missingScope)).toBe(false);
	});
});

describe("user memory pipeline", () => {
	test("deduplicates identical subject predicate object memories by updating lastConfirmedAt", () => {
		const store = new InMemoryUserMemoryStore();

		writeUserMemory(store, memory({ id: "first", observedAt: 1_000, lastConfirmedAt: 1_000 }));
		writeUserMemory(store, memory({ id: "second", observedAt: 2_000, lastConfirmedAt: 3_000 }));

		expect(store.records()).toHaveLength(1);
		expect(store.records()[0]).toMatchObject({
			id: "first",
			observedAt: 1_000,
			lastConfirmedAt: 3_000,
		});
	});

	test("selects conflicting recall winners by trust tier before recency", () => {
		const store = new InMemoryUserMemoryStore();

		writeUserMemory(
			store,
			memory({
				id: "recent-inferred",
				object: "tea",
				trust: "model_inferred",
				lastConfirmedAt: 10_000,
			}),
		);
		writeUserMemory(
			store,
			memory({
				id: "older-confirmed",
				object: "coffee",
				trust: "user_confirmed",
				lastConfirmedAt: 2_000,
			}),
		);

		const recalled = recallUserMemories(store, {
			subject: "user",
			predicate: "prefers_drink",
			now: 11_000,
		});

		expect(recalled).toHaveLength(1);
		expect(recalled[0].id).toBe("older-confirmed");
		expect(recalled[0].object).toBe("coffee");
	});

	test("uses lastConfirmedAt as the recency tiebreaker for equal-trust conflicts", () => {
		const store = new InMemoryUserMemoryStore();

		writeUserMemory(
			store,
			memory({
				id: "older-tool",
				object: "tea",
				trust: "tool_evidenced",
				lastConfirmedAt: 4_000,
			}),
		);
		writeUserMemory(
			store,
			memory({
				id: "newer-tool",
				object: "coffee",
				trust: "tool_evidenced",
				lastConfirmedAt: 7_000,
			}),
		);

		const recalled = recallUserMemories(store, {
			subject: "user",
			predicate: "prefers_drink",
			now: 8_000,
		});

		expect(recalled).toHaveLength(1);
		expect(recalled[0].id).toBe("newer-tool");
	});

	test("recalls only records that are currently valid and not expired", () => {
		const store = new InMemoryUserMemoryStore();

		writeUserMemory(store, memory({ id: "ended", predicate: "diet", validFrom: 1_000, validTo: 3_000 }));
		writeUserMemory(store, memory({ id: "future", predicate: "timezone", validFrom: 5_000 }));
		writeUserMemory(store, memory({ id: "expired", predicate: "editor", expiresAt: 2_500 }));
		writeUserMemory(store, memory({ id: "active", predicate: "shell", validFrom: 1_000, expiresAt: 5_000 }));

		expect(recallUserMemories(store, { subject: "user", now: 3_000 }).map((record) => record.id)).toEqual(["active"]);
		expect(recallUserMemories(store, { subject: "user", predicate: "diet", now: 3_000 })).toEqual([]);
	});

	test("recalls global and active-domain memories, excluding other domains", () => {
		const store = new InMemoryUserMemoryStore();

		writeUserMemory(
			store,
			memory({
				id: "global-timezone",
				scope: "global",
				category: "preference",
				predicate: "timezone",
				object: "Asia/Shanghai",
				lastConfirmedAt: 1_000,
			}),
		);
		writeUserMemory(
			store,
			memory({
				id: "travel-timezone",
				scope: "travel",
				category: "trip",
				predicate: "timezone",
				object: "Europe/Paris",
				lastConfirmedAt: 2_000,
			}),
		);
		writeUserMemory(
			store,
			memory({
				id: "coding-timezone",
				scope: "coding",
				predicate: "timezone",
				object: "UTC",
				lastConfirmedAt: 3_000,
			}),
		);

		const recalled = recallUserMemories(store, {
			subject: "user",
			predicate: "timezone",
			scope: "travel",
			now: 4_000,
		});

		expect(recalled.map((record) => record.id)).toEqual(["global-timezone", "travel-timezone"]);
	});

	test("redacts visible object and source strings before storing or recalling memories", () => {
		const store = new InMemoryUserMemoryStore();

		writeUserMemory(
			store,
			memory({
				object: "Authorization: Bearer object-secret",
				source: "fetch https://example.test/profile?token=source-secret",
			}),
		);

		expect(store.records()[0].object).toBe("Authorization: [REDACTED]");
		expect(store.records()[0].source).toBe("fetch https://example.test/profile?token=[REDACTED]");
		expect(store.records()[0].object).not.toContain("object-secret");
		expect(store.records()[0].source).not.toContain("source-secret");

		const recalled = recallUserMemories(store, { subject: "user", predicate: "prefers_drink", now: 1_000 });
		expect(recalled[0].object).toBe("Authorization: [REDACTED]");
		expect(recalled[0].source).toBe("fetch https://example.test/profile?token=[REDACTED]");
	});
});
