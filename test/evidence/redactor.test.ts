import { afterEach, describe, expect, test } from "vitest";
import { redactCommandOutput } from "../../src/evidence/redactor.ts";
import { redactString } from "../../src/observability/redact.ts";
import { clearKnownSecretsForTesting, registerKnownSecret } from "../../src/redaction/core.ts";

describe("evidence redactor", () => {
	afterEach(() => {
		clearKnownSecretsForTesting();
	});

	test("redacts full Authorization and Cookie header values in command strings", () => {
		const redacted = redactCommandOutput(
			`curl -H "Authorization: Bearer bearer-token" -H 'Authorization: Basic basic-token' -H "Cookie: a=b; c=d" https://example.test`,
		).text;

		expect(redacted).toContain(`curl -H "Authorization: [REDACTED]"`);
		expect(redacted).toContain(`-H 'Authorization: [REDACTED]'`);
		expect(redacted).toContain(`-H "Cookie: [REDACTED]"`);
		expect(redacted).toContain("https://example.test");
		expect(redacted).not.toContain("bearer-token");
		expect(redacted).not.toContain("basic-token");
		expect(redacted).not.toContain("a=b");
		expect(redacted).not.toContain("c=d");
	});

	test("redacts unquoted inline Authorization and Cookie header values in command strings", () => {
		const redacted = redactCommandOutput(
			"curl -H Authorization: Basic abc123 -H Cookie: a=b; c=d https://example.test",
		).text;

		expect(redacted).toContain("curl -H Authorization: [REDACTED]");
		expect(redacted).toContain("-H Cookie: [REDACTED]");
		expect(redacted).toContain("https://example.test");
		expect(redacted).not.toContain("Basic abc123");
		expect(redacted).not.toContain("abc123");
		expect(redacted).not.toContain("a=b");
		expect(redacted).not.toContain("c=d");
	});

	test("redacts full Authorization and Cookie header values in output strings", () => {
		const redacted = redactCommandOutput(
			"before\nAuthorization: Basic abc123\nCookie: a=b; c=d\nAuthorization: Bearer bearer456\nafter\n",
		).text;

		expect(redacted).toBe(
			"before\nAuthorization: [REDACTED]\nCookie: [REDACTED]\nAuthorization: [REDACTED]\nafter\n",
		);
		expect(redacted).not.toContain("abc123");
		expect(redacted).not.toContain("a=b");
		expect(redacted).not.toContain("c=d");
		expect(redacted).not.toContain("bearer456");
	});

	test("redacts sensitive URL query parameters in command subjects", () => {
		const redacted = redactCommandOutput(
			"fetch https://example.test/data?token=query-token&safe=visible&api_key=query-key",
		).text;

		expect(redacted).toBe("fetch https://example.test/data?token=[REDACTED]&safe=visible&api_key=[REDACTED]");
		expect(redacted).not.toContain("query-token");
		expect(redacted).not.toContain("query-key");
	});

	test("redacts registered bare secret values", () => {
		registerKnownSecret("sk-test-known-evidence-secret");

		const redacted = redactCommandOutput("stdout sk-test-known-evidence-secret stderr").text;

		expect(redacted).toBe("stdout [REDACTED] stderr");
		expect(redacted).not.toContain("sk-test-known-evidence-secret");
	});

	test("matches observability redaction for shared leak fixtures", () => {
		registerKnownSecret("sk-test-shared-known-secret");
		const fixtures = [
			"Authorization: Basic abc123",
			"Cookie: a=b; c=d",
			"fetch https://example.test/data?token=query-token&safe=visible&api_key=query-key",
			`{"apiToken":"json-token","safe":"visible"}`,
			"DEEPSEEK_API_KEY=sk-test-assignment",
			"message with Bearer bearer-token",
			"raw sk-test-shared-known-secret value",
		];

		for (const fixture of fixtures) {
			expect(redactCommandOutput(fixture).text).toBe(redactString(fixture));
		}
	});
});
