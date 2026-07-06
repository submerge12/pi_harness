import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appendManifestEntry, readManifest, type EvidenceManifestEntry } from "../../src/evidence/index.ts";

function entry(id: string): EvidenceManifestEntry {
	return {
		id,
		command: `cmd ${id}`,
		subject: "repo:demo",
		allowed: { level: "allow" },
		exitCode: 0,
		stdoutRef: `.evidence-local/run/${id}.stdout`,
		stderrRef: `.evidence-local/run/${id}.stderr`,
		bytes: { stdout: 0, stderr: 0, total: 0 },
		binary: false,
		truncated: false,
		sha256: "sha",
		stderrSha256: "stderr-sha",
		redactions: 0,
		capturedAt: "2026-06-24T00:00:00.000Z",
	};
}

describe("evidence manifest", () => {
	it("appends manifest entries as JSONL", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-harness-manifest-"));
		const manifestPath = join(root, "manifest.jsonl");

		await appendManifestEntry(manifestPath, entry("first"));
		await appendManifestEntry(manifestPath, entry("second"));

		const raw = await readFile(manifestPath, "utf8");
		const lines = raw.trim().split("\n");
		expect(lines).toHaveLength(2);
		expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({ id: "first" });
		expect(JSON.parse(lines[1] ?? "{}")).toMatchObject({ id: "second" });
		await expect(readManifest(manifestPath)).resolves.toEqual([entry("first"), entry("second")]);
	});

	it("reads legacy manifest JSON arrays through the JSONL path", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-harness-legacy-manifest-"));
		const legacyPath = join(root, "manifest.json");
		await writeFile(legacyPath, `${JSON.stringify([entry("legacy")], null, 2)}\n`, "utf8");

		await expect(readManifest(join(root, "manifest.jsonl"))).resolves.toEqual([entry("legacy")]);
	});

	it("keeps concurrent appends without lost manifest entries", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-harness-concurrent-manifest-"));
		const manifestPath = join(root, "manifest.jsonl");
		const ids = Array.from({ length: 40 }, (_, index) => `entry-${index}`);

		await Promise.all(ids.map((id) => appendManifestEntry(manifestPath, entry(id))));

		const manifest = await readManifest(manifestPath);
		expect(manifest.map((item) => item.id).sort()).toEqual(ids.sort());
	});
});
