import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { EvidenceManifest, EvidenceManifestEntry } from "./types.ts";

export async function appendManifestEntry(manifestPath: string, entry: EvidenceManifestEntry): Promise<void> {
	await mkdir(dirname(manifestPath), { recursive: true });
	const manifest = await readManifest(manifestPath);
	manifest.push(entry);
	await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

async function readManifest(manifestPath: string): Promise<EvidenceManifest> {
	try {
		const content = await readFile(manifestPath, "utf8");
		const parsed = JSON.parse(content) as unknown;
		if (!Array.isArray(parsed)) return [];
		return parsed as EvidenceManifestEntry[];
	} catch (error) {
		if (isNotFound(error)) return [];
		throw error;
	}
}

function isNotFound(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
