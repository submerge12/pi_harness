import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("runtime contract schemas", () => {
	it("emits contract-only schemas for AOH references", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-contract-only-schemas-"));
		execFileSync(process.execPath, [join(process.cwd(), "scripts", "emit-schemas.mjs"), dir], {
			stdio: "pipe",
		});

		expect(JSON.parse(readFileSync(join(dir, "memory-candidate.schema.json"), "utf8"))).toMatchObject({
			type: "object",
			required: ["subject", "predicate", "object", "trust"],
		});
		expect(JSON.parse(readFileSync(join(dir, "plan-amendment.schema.json"), "utf8"))).toMatchObject({
			type: "object",
			required: ["id", "reason", "changes"],
		});
		expect(JSON.parse(readFileSync(join(dir, "domain-handoff-package.schema.json"), "utf8"))).toMatchObject({
			type: "object",
			required: ["sourceDomain", "targetDomain", "artifactRefs"],
		});
	}, 15_000);
});
