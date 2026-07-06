import { appendFile, mkdir, readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { EvidenceManifest, EvidenceManifestEntry } from "./types.ts";

export async function appendManifestEntry(manifestPath: string, entry: EvidenceManifestEntry): Promise<void> {
	await mkdir(dirname(manifestPath), { recursive: true });
	await appendFile(manifestPath, `${JSON.stringify(entry)}\n`, "utf8");
}

export async function readManifest(manifestPath: string): Promise<EvidenceManifest> {
	try {
		const content = await readFile(manifestPath, "utf8");
		return parseManifestContent(content, manifestPath);
	} catch (error) {
		if (isNotFound(error)) return await readLegacyManifestFallback(manifestPath);
		throw error;
	}
}

function parseManifestContent(content: string, manifestPath: string): EvidenceManifest {
	const trimmed = content.trim();
	if (!trimmed) return [];
	if (trimmed.startsWith("[")) {
		const parsed = JSON.parse(trimmed) as unknown;
		return Array.isArray(parsed) ? parsed as EvidenceManifestEntry[] : [];
	}
	const entries: EvidenceManifestEntry[] = [];
	const lines = content.split(/\r?\n/);
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index]?.trim();
		if (!line) continue;
		try {
			entries.push(JSON.parse(line) as EvidenceManifestEntry);
		} catch (error) {
			throw new Error(`Invalid evidence manifest JSONL at ${manifestPath}:${index + 1}: ${toMessage(error)}`);
		}
	}
	return entries;
}

async function readLegacyManifestFallback(manifestPath: string): Promise<EvidenceManifest> {
	if (basename(manifestPath) !== "manifest.jsonl") return [];
	const legacyPath = join(dirname(manifestPath), "manifest.json");
	try {
		return parseManifestContent(await readFile(legacyPath, "utf8"), legacyPath);
	} catch (error) {
		if (isNotFound(error)) return [];
		throw error;
	}
}

function isNotFound(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function toMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
