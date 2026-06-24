import { describe, expect, it } from "vitest";
import { decide, matchesSubjectGlob } from "../../src/policy/decide.ts";
import type { ScopedPolicy } from "../../src/policy/types.ts";

const basePolicy: ScopedPolicy = {
	defaults: {
		"read-only": "allow",
		write: "ask",
		destructive: "ask",
		network: "deny",
	},
};

describe("matchesSubjectGlob", () => {
	it("matches exact subjects", () => {
		expect(matchesSubjectGlob("src/policy/decide.ts", "src/policy/decide.ts")).toBe(true);
		expect(matchesSubjectGlob("src/policy/types.ts", "src/policy/decide.ts")).toBe(false);
	});

	it("matches single-segment stars", () => {
		expect(matchesSubjectGlob("src/policy/*.ts", "src/policy/decide.ts")).toBe(true);
		expect(matchesSubjectGlob("src/*.ts", "src/policy/decide.ts")).toBe(false);
	});

	it("matches doublestar across path segments", () => {
		expect(matchesSubjectGlob("src/**/*.ts", "src/policy/decide.ts")).toBe(true);
		expect(matchesSubjectGlob("src/**", "src/policy/decide.ts")).toBe(true);
		expect(matchesSubjectGlob("test/**/*.ts", "src/policy/decide.ts")).toBe(false);
	});

	it("matches question marks within a single segment", () => {
		expect(matchesSubjectGlob("src/policy/file-?.ts", "src/policy/file-a.ts")).toBe(true);
		expect(matchesSubjectGlob("src/policy/file-?.ts", "src/policy/file-ab.ts")).toBe(false);
		expect(matchesSubjectGlob("src/policy/?.ts", "src/policy/nested/a.ts")).toBe(false);
	});

	it("normalizes backslashes before matching", () => {
		expect(matchesSubjectGlob("src\\**\\*.ts", "src\\policy\\decide.ts")).toBe(true);
	});

	it("does not let parent segments escape a glob prefix", () => {
		expect(matchesSubjectGlob("src/**", "src/../secrets/key")).toBe(false);
	});

	it("treats glob metacharacters as segment matchers, not character classes or braces", () => {
		expect(matchesSubjectGlob("src/file[ab].ts", "src/filea.ts")).toBe(false);
		expect(matchesSubjectGlob("src/*.{ts,js}", "src/index.ts")).toBe(false);
	});
});

describe("decide", () => {
	it("lets scoped deny beat a flat tool allow", () => {
		const policy: ScopedPolicy = {
			...basePolicy,
			tools: { write: "allow" },
			rules: [{ id: "deny-secret-writes", toolName: "write", subject: "secrets/**", level: "deny" }],
		};

		expect(decide(policy, "write", "secrets/api-key.txt", { accessLevel: "write" })).toEqual({
			level: "deny",
			ruleId: "deny-secret-writes",
		});
	});

	it("lets scoped ask beat fallback allow", () => {
		const policy: ScopedPolicy = {
			...basePolicy,
			rules: [{ id: "ask-sensitive-read", toolName: "read", subject: "sensitive/**", level: "ask" }],
		};

		expect(decide(policy, "read", "sensitive/report.md", { accessLevel: "read-only" })).toEqual({
			level: "ask",
			ruleId: "ask-sensitive-read",
		});
	});

	it("keeps flat tool policy above defaults", () => {
		const policy: ScopedPolicy = {
			...basePolicy,
			tools: { fetch: "allow" },
		};

		expect(decide(policy, "fetch", "https://example.test", { accessLevel: "network" })).toEqual({ level: "allow" });
	});

	it("falls back to the access-level default", () => {
		expect(decide(basePolicy, "edit", "src/index.ts", { accessLevel: "write" })).toEqual({ level: "ask" });
	});

	it("requires an access level instead of falling back to write", () => {
		expect(() => decide(basePolicy, "fetch", "https://example.test", {})).toThrow(
			"Policy decisions require an explicit accessLevel",
		);
	});

	it("does not treat missing network or destructive access levels as write", () => {
		const policy: ScopedPolicy = {
			defaults: {
				"read-only": "allow",
				write: "allow",
				destructive: "deny",
				network: "deny",
			},
		};

		expect(() => decide(policy, "fetch", "https://example.test", {})).toThrow(
			"Policy decisions require an explicit accessLevel",
		);
		expect(decide(policy, "fetch", "https://example.test", { accessLevel: "network" })).toEqual({ level: "deny" });
		expect(decide(policy, "remove", "src/index.ts", { accessLevel: "destructive" })).toEqual({ level: "deny" });
	});

	it("chooses the strictest matching subject rule", () => {
		const policy: ScopedPolicy = {
			...basePolicy,
			rules: [
				{ id: "allow-src", toolName: "write", subject: "src/**", level: "allow" },
				{ id: "ask-policy", toolName: "write", subject: "src/policy/**", level: "ask" },
				{ id: "deny-decide", toolName: "write", subject: "src/policy/decide.ts", level: "deny" },
			],
		};

		expect(decide(policy, "write", "src/policy/decide.ts", { accessLevel: "write" })).toEqual({
			level: "deny",
			ruleId: "deny-decide",
		});
	});

	it("keeps caller-represented permission override deny strongest", () => {
		const policy: ScopedPolicy = {
			...basePolicy,
			tools: { write: "allow" },
			rules: [{ id: "allow-generated", toolName: "write", subject: "generated/**", level: "allow" }],
		};

		expect(
			decide(policy, "write", "generated/report.md", {
				accessLevel: "write",
				permissionOverride: "deny",
			}),
		).toEqual({
			level: "deny",
			ruleId: "allow-generated",
		});
	});

	it("does not let permission override allow weaken policy ask or deny", () => {
		const policy: ScopedPolicy = {
			...basePolicy,
			rules: [
				{ id: "ask-sensitive", toolName: "write", subject: "sensitive/**", level: "ask" },
				{ id: "deny-secrets", toolName: "write", subject: "secrets/**", level: "deny" },
			],
		};

		expect(
			decide(policy, "write", "sensitive/report.md", {
				accessLevel: "write",
				permissionOverride: "allow",
			}),
		).toEqual({
			level: "ask",
			ruleId: "ask-sensitive",
		});
		expect(
			decide(policy, "write", "secrets/key.txt", {
				accessLevel: "write",
				permissionOverride: "allow",
			}),
		).toEqual({
			level: "deny",
			ruleId: "deny-secrets",
		});
	});

	it("denies path writes outside the active write scope even when policy allows the tool", () => {
		const policy: ScopedPolicy = {
			...basePolicy,
			tools: { write: "allow" },
		};

		expect(
			decide(policy, "write", "secrets/key.txt", {
				accessLevel: "write",
				subjectIsPath: true,
				writeScope: ["src"],
			}),
		).toEqual({
			level: "deny",
			ruleId: "write-scope",
		});
	});

	it("denies destructive non-path subjects when an active write scope is required", () => {
		const policy: ScopedPolicy = {
			...basePolicy,
			tools: { bash: "allow" },
		};

		expect(
			decide(policy, "bash", "echo x > secrets/out.txt", {
				accessLevel: "destructive",
				subjectIsPath: false,
				writeScope: ["src"],
			}),
		).toEqual({
			level: "deny",
			ruleId: "write-scope",
		});
	});

	it("allows normalized path writes inside the active write scope", () => {
		const policy: ScopedPolicy = {
			...basePolicy,
			tools: { write: "allow" },
		};

		expect(
			decide(policy, "write", ".\\src\\feature\\..\\feature\\file.ts", {
				accessLevel: "write",
				subjectIsPath: true,
				writeScope: ["./src/feature"],
			}),
		).toEqual({ level: "allow" });
	});
});
