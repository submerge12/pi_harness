import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = process.cwd();

describe("emit-schemas", () => {
	it("emits stable pretty JSON schemas to an explicit output directory", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-contract-schemas-"));
		const outputDir = join(dir, "generated-schemas");

		execFileSync(process.execPath, [join(repoRoot, "scripts", "emit-schemas.mjs"), outputDir], {
			cwd: dir,
			stdio: "pipe",
		});

		const taskSchemaText = readFileSync(join(outputDir, "task-contract.schema.json"), "utf8");
		const planSchemaText = readFileSync(join(outputDir, "plan-package.schema.json"), "utf8");
		const skillSchemaText = readFileSync(join(outputDir, "skill-card.schema.json"), "utf8");
		const memorySchemaText = readFileSync(join(outputDir, "user-memory.schema.json"), "utf8");
		const traceSchemaText = readFileSync(join(outputDir, "trace-event.schema.json"), "utf8");

		expect(taskSchemaText.endsWith("\n")).toBe(true);
		expect(planSchemaText.endsWith("\n")).toBe(true);
		expect(skillSchemaText.endsWith("\n")).toBe(true);
		expect(memorySchemaText.endsWith("\n")).toBe(true);
		expect(traceSchemaText.endsWith("\n")).toBe(true);
		expect(JSON.parse(taskSchemaText)).toMatchObject({
			type: "object",
			required: ["id", "goal", "rawRequest", "hardConstraints", "assignedSkill", "writeScope", "gateTier"],
		});
		expect(JSON.parse(planSchemaText)).toMatchObject({
			type: "object",
			required: ["tasks", "dependencies"],
		});
		expect(JSON.parse(skillSchemaText)).toMatchObject({
			type: "object",
			required: [
				"name",
				"responsibility",
				"whenToUse",
				"effects",
				"adjacentFalseTriggers",
				"positiveExamples",
				"negativeExamples",
				"inputs",
				"outputs",
				"tools",
				"constraints",
				"handoffContract",
			],
			properties: {
				effects: {
					type: "array",
					items: { type: "string" },
				},
			},
		});
		expect(JSON.parse(memorySchemaText)).toMatchObject({
			type: "object",
			required: [
				"id",
				"scope",
				"subject",
				"predicate",
				"object",
				"validFrom",
				"observedAt",
				"lastConfirmedAt",
				"source",
				"trust",
				"sensitivity",
			],
			properties: {
				category: { type: "string" },
			},
		});
		expect(JSON.parse(traceSchemaText)).toMatchObject({
			type: "object",
			required: ["runId", "seq", "type", "at"],
			properties: {
				type: {
					anyOf: expect.arrayContaining([
						{ const: "worker-attempt", type: "string" },
						{ const: "review-verdict", type: "string" },
						{ const: "rewind", type: "string" },
					]),
				},
			},
		});
	});
});
