import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import { normalizedResultSchema } from "../../src/runtime/index.ts";

describe("normalizedResultSchema", () => {
	it("validates the cross-executor result envelope", () => {
		expect(Value.Check(normalizedResultSchema, {
			status: "completed",
			diffRef: "diffs/1.patch",
			testResults: [{ name: "unit", passed: true }],
			evidenceRefs: ["evidence/run/manifest.json#cmd-1"],
			usage: { inputTokens: 10, outputTokens: 4, costUsd: 0.01 },
			message: "ok",
		})).toBe(true);

		expect(Value.Check(normalizedResultSchema, {
			status: "completed",
			testResults: [],
			evidenceRefs: [],
			usage: { inputTokens: 10, outputTokens: 4, costUsd: 0.01 },
			message: "ok",
			model: "deepseek-v4-pro@2026-06",
		})).toBe(true);

		expect(Value.Check(normalizedResultSchema, {
			status: "failed",
			testResults: [],
			evidenceRefs: [],
			usage: { inputTokens: 10, outputTokens: 4, costUsd: 0.01 },
			message: "Model output classified as refusal by profile failure signatures.",
			error: {
				type: "model_failure",
				kind: "refusal",
				pattern: "cannot",
				retryClassification: "fatal",
			},
		})).toBe(true);

		expect(Value.Check(normalizedResultSchema, {
			status: "done",
			testResults: [],
			evidenceRefs: [],
			usage: { inputTokens: 10, outputTokens: 4, costUsd: 0.01 },
			message: "ok",
		})).toBe(false);
	});

	it("is emitted by the schema generator", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-runtime-schemas-"));
		execFileSync(process.execPath, [join(process.cwd(), "scripts", "emit-schemas.mjs"), dir], {
			stdio: "pipe",
		});

		const schema = JSON.parse(readFileSync(join(dir, "normalized-result.schema.json"), "utf8")) as {
			required: string[];
		};
		expect(schema.required).toEqual(["status", "testResults", "evidenceRefs", "usage", "message"]);
	}, 15_000);
});
