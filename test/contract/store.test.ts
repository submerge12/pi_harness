import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { appendStoreEntry, readStoreEntries } from "../../src/contract/store.ts";

describe("contract store", () => {
	it("appends entries as one JSON line per record and reads them back", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-contract-store-"));
		const filePath = join(dir, "contracts.json");

		const firstEntry = { id: "first", result: "ok" };
		const secondEntry = { id: "second", result: "ok" };

		await appendStoreEntry(filePath, firstEntry);
		await appendStoreEntry(filePath, secondEntry);

		await expect(readFile(filePath, "utf8")).resolves.toBe(
			`${JSON.stringify(firstEntry)}\n${JSON.stringify(secondEntry)}\n`,
		);

		await expect(readStoreEntries(filePath)).resolves.toEqual([
			{ id: "first", result: "ok" },
			{ id: "second", result: "ok" },
		]);
	});

	it("refuses to silently overwrite an existing entry id", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-contract-store-"));
		const filePath = join(dir, "contracts.json");

		await appendStoreEntry(filePath, { id: "same", result: "first" });

		await expect(appendStoreEntry(filePath, { id: "same", result: "second" })).rejects.toThrow(
			"Store entry already exists: same",
		);
		await expect(readStoreEntries(filePath)).resolves.toEqual([{ id: "same", result: "first" }]);
	});

	it("rejects malformed append entries before writing", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-contract-store-"));
		const filePath = join(dir, "contracts.json");
		const existingEntry = { id: "first", result: "ok" };
		const malformedEntry = { result: "missing-id" } as unknown as { id: string };

		await appendStoreEntry(filePath, existingEntry);

		await expect(appendStoreEntry(filePath, malformedEntry)).rejects.toThrow("Store entry must contain a string id");
		await expect(readFile(filePath, "utf8")).resolves.toBe(`${JSON.stringify(existingEntry)}\n`);
		await expect(readStoreEntries(filePath)).resolves.toEqual([existingEntry]);
	});

	it("rejects non-object append entries before writing", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-contract-store-"));
		const filePath = join(dir, "contracts.json");
		const existingEntry = { id: "first", result: "ok" };
		const malformedEntry = "not-an-entry" as unknown as { id: string };

		await appendStoreEntry(filePath, existingEntry);

		await expect(appendStoreEntry(filePath, malformedEntry)).rejects.toThrow("Store entry must contain a string id");
		await expect(readFile(filePath, "utf8")).resolves.toBe(`${JSON.stringify(existingEntry)}\n`);
		await expect(readStoreEntries(filePath)).resolves.toEqual([existingEntry]);
	});

	it("serializes concurrent duplicate appends to the same file", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-contract-store-"));
		const filePath = join(dir, "contracts.json");

		const results = await Promise.allSettled(
			Array.from({ length: 8 }, (_, index) => appendStoreEntry(filePath, { id: "same", attempt: index })),
		);

		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		expect(results.filter((result) => result.status === "rejected")).toHaveLength(7);
		await expect(readStoreEntries(filePath)).resolves.toEqual([expect.objectContaining({ id: "same" })]);
	});

	it("reports the line number for malformed JSONL", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-contract-store-"));
		const filePath = join(dir, "contracts.json");
		await writeFile(filePath, `${JSON.stringify({ id: "first" })}\nnot-json\n`, "utf8");

		await expect(readStoreEntries(filePath)).rejects.toThrow(`Malformed JSONL at ${filePath}: line 2`);
	});

	it("reports the line number for JSONL entries without a string id", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-contract-store-"));
		const filePath = join(dir, "contracts.json");
		await writeFile(filePath, `${JSON.stringify({ id: "first" })}\n${JSON.stringify({ result: "missing-id" })}\n`, "utf8");

		await expect(readStoreEntries(filePath)).rejects.toThrow(
			`Store entry at ${filePath}: line 2 must contain a string id`,
		);
	});
});
