import { describe, expect, it } from "vitest";
import {
	assertNonOverlappingWriteScopes,
	isPathWithinWriteScope,
	normalizeWriteScope,
	normalizeWriteScopePath,
	validateWriteScope,
} from "../../src/execution/write-scope.ts";

describe("write-scope guard", () => {
	it("rejects empty write scopes by default", () => {
		expect(() => validateWriteScope([])).toThrow("write scope must include at least one path");
	});

	it("allows empty write scopes when explicitly requested", () => {
		expect(validateWriteScope([], { allowEmpty: true })).toEqual([]);
	});

	it("normalizes slashes, dots, duplicates, and stable ordering", () => {
		expect(normalizeWriteScope(["src\\execution\\types.ts", "./src/execution", "src/execution/types.ts"])).toEqual([
			"src/execution",
			"src/execution/types.ts",
		]);
	});

	it("exposes the same single-path normalizer for write-time decisions", () => {
		expect(normalizeWriteScopePath(".\\src\\execution\\..\\tools\\write.ts")).toBe("src/tools/write.ts");
		expect(() => normalizeWriteScopePath("../secrets/key.txt")).toThrow("write scope path must not escape root");
	});

	it("checks write-time containment with path segment boundaries", () => {
		expect(isPathWithinWriteScope("src\\tools\\write.ts", ["./src/tools"])).toBe(true);
		expect(isPathWithinWriteScope("src/tools-extra/write.ts", ["src/tools"])).toBe(false);
		expect(isPathWithinWriteScope("./src/tools/../policy/decide.ts", ["src/policy"])).toBe(true);
	});

	it("checks virtual database URI containment with path segment boundaries", () => {
		const dietLogs = "compass-health-agent://database/compass_health/diet_logs";

		expect(normalizeWriteScope([dietLogs])).toEqual([dietLogs]);
		expect(isPathWithinWriteScope(`${dietLogs}/row`, [dietLogs])).toBe(true);
		expect(isPathWithinWriteScope("compass-health-agent://database/compass_health/water_logs", [dietLogs])).toBe(false);
	});

	it("rejects Windows absolute and colon-bearing paths after slash normalization", () => {
		for (const scopePath of ["C:\\repo\\src", "C:/repo/src", "src:execution", "compass-health-agent:database"]) {
			expect(() => validateWriteScope([scopePath])).toThrow("write scope path must be relative and colon-free");
		}
	});

	it("rejects parent-child overlaps deterministically", () => {
		expect(() =>
			assertNonOverlappingWriteScopes([
				{ owner: "worker-b", writeScope: ["src/execution/worktree-provider.ts"] },
				{ owner: "worker-a", writeScope: ["src/execution"] },
			]),
		).toThrow("write scope overlap between worker-a (src/execution) and worker-b (src/execution/worktree-provider.ts)");
	});

	it("allows sibling and prefix-only non-overlaps", () => {
		expect(
			assertNonOverlappingWriteScopes([
				{ owner: "worker-a", writeScope: ["src/execution"] },
				{ owner: "worker-b", writeScope: ["test/execution"] },
				{ owner: "worker-c", writeScope: ["src/execution-extra"] },
			]),
		).toEqual([
			{ owner: "worker-a", writeScope: ["src/execution"] },
			{ owner: "worker-c", writeScope: ["src/execution-extra"] },
			{ owner: "worker-b", writeScope: ["test/execution"] },
		]);
	});
});
