import { describe, expect, it } from "vitest";
import { resolveSubject } from "../../src/policy/subject.ts";

describe("resolveSubject", () => {
	it("uses subject keys in command, file_path, path, pattern order", () => {
		expect(
			resolveSubject({
				pattern: "src/**/*.ts",
				path: "src/index.ts",
				file_path: "src/policy/types.ts",
				command: "npm run check",
			}),
		).toBe("npm run check");

		expect(
			resolveSubject({
				pattern: "src/**/*.ts",
				path: "src/index.ts",
				file_path: "src/policy/types.ts",
			}),
		).toBe("src/policy/types.ts");

		expect(
			resolveSubject({
				pattern: "src/**/*.ts",
				path: "src/index.ts",
			}),
		).toBe("src/index.ts");
	});

	it("ignores non-string subject values and returns an empty subject when no string key exists", () => {
		expect(
			resolveSubject({
				command: ["npm", "run", "check"],
				file_path: 12,
				path: false,
				pattern: null,
			}),
		).toBe("");

		expect(resolveSubject({})).toBe("");
	});

	it("normalizes backslashes in extracted subjects", () => {
		expect(resolveSubject({ path: "src\\policy\\decide.ts" })).toBe("src/policy/decide.ts");
	});

	it("collapses dot segments for extracted path-like subjects", () => {
		expect(resolveSubject({ path: "src/policy/../index.ts" })).toBe("src/index.ts");
		expect(resolveSubject({ file_path: "src/../secrets/key" })).toBe("secrets/key");
		expect(resolveSubject({ path: "./src/./policy/types.ts" })).toBe("src/policy/types.ts");
	});

	it("does not collapse dot segments for command subjects", () => {
		expect(resolveSubject({ command: "cat src/../secrets/key" })).toBe("cat src/../secrets/key");
	});
});
