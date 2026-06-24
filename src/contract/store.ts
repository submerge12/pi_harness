import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export interface StoreEntry {
	id: string;
	[key: string]: unknown;
}

const appendQueues = new Map<string, Promise<void>>();

export async function readStoreEntries<Entry extends StoreEntry = StoreEntry>(filePath: string): Promise<Entry[]> {
	let text: string;
	try {
		text = await readFile(filePath, "utf8");
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") return [];
		throw error;
	}

	const entries: Array<{ lineNumber: number; value: unknown }> = [];
	const lines = text.split(/\r?\n/);
	for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
		const line = lines[lineIndex];
		if (line.length === 0) continue;
		try {
			entries.push({ lineNumber: lineIndex + 1, value: JSON.parse(line) as unknown });
		} catch {
			throw new Error(`Malformed JSONL at ${filePath}: line ${lineIndex + 1}`);
		}
	}
	for (const entry of entries) {
		if (!isStoreEntry(entry.value)) throw new Error(`Store entry at ${filePath}: line ${entry.lineNumber} must contain a string id`);
	}
	return entries.map((entry) => entry.value) as Entry[];
}

export async function appendStoreEntry<Entry extends StoreEntry>(filePath: string, entry: Entry): Promise<void> {
	if (!isStoreEntry(entry)) throw new Error("Store entry must contain a string id");

	const queueKey = resolve(filePath);
	const previousAppend = appendQueues.get(queueKey) ?? Promise.resolve();
	const currentAppend = previousAppend.catch(() => undefined).then(() => appendStoreEntryNow(filePath, entry));
	appendQueues.set(queueKey, currentAppend);

	try {
		await currentAppend;
	} finally {
		if (appendQueues.get(queueKey) === currentAppend) appendQueues.delete(queueKey);
	}
}

async function appendStoreEntryNow<Entry extends StoreEntry>(filePath: string, entry: Entry): Promise<void> {
	const entries = await readStoreEntries<Entry>(filePath);
	if (entries.some((existing) => existing.id === entry.id)) throw new Error(`Store entry already exists: ${entry.id}`);

	await mkdir(dirname(filePath), { recursive: true });
	await appendFile(filePath, `${JSON.stringify(entry)}\n`, "utf8");
}

function isStoreEntry(value: unknown): value is StoreEntry {
	return typeof value === "object" && value !== null && typeof (value as { id?: unknown }).id === "string";
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}
