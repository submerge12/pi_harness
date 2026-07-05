import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

const srcRoot = join(import.meta.dirname, "..", "..", "src");

// The iron rule from docs/model-profile-design.md: specializations reference
// profiles, never model quirks. Model names may appear only behind the seam.
const allowedPrefixes = ["model-profiles" + sep];

const modelNamePattern = /deepseek|\bglm\b|\bkimi\b|qwen/i;

function listSourceFiles(directory: string): string[] {
	const files: string[] = [];
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const entryPath = join(directory, entry.name);
		if (entry.isDirectory()) {
			files.push(...listSourceFiles(entryPath));
			continue;
		}
		if (entry.isFile() && entry.name.endsWith(".ts")) files.push(entryPath);
	}
	return files;
}

describe("model profile seam sweep", () => {
	it("keeps model names out of every src/ module except model-profiles/", () => {
		const offenders: string[] = [];
		for (const filePath of listSourceFiles(srcRoot)) {
			const relativePath = relative(srcRoot, filePath);
			if (allowedPrefixes.some((prefix) => relativePath.startsWith(prefix))) continue;
			const content = readFileSync(filePath, "utf8");
			const match = content.match(modelNamePattern);
			if (match) offenders.push(`${relativePath}: ${match[0]}`);
		}
		expect(offenders).toEqual([]);
	});
});
