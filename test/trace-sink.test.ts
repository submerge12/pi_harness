import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { clearKnownSecretsForTesting, registerKnownSecret } from "../src/redaction/core.ts";
import { createFileTraceSink, createInMemoryTraceSink } from "../src/trace/index.ts";

describe("trace sink", () => {
	afterEach(() => {
		clearKnownSecretsForTesting();
	});

	it("orders in-memory events and redacts secret fields", async () => {
		const trace = createInMemoryTraceSink({ runId: "trace-redaction", now: () => 42 });

		await trace.append({ type: "stage", data: { stage: "execute", apiToken: "secret-value" } });
		await trace.append({ type: "review-verdict", data: { header: "Authorization: Bearer abc123" } });

		expect(trace.events()).toEqual([
			{
				runId: "trace-redaction",
				seq: 0,
				type: "stage",
				at: 42,
				data: { stage: "execute", apiToken: "[REDACTED]" },
			},
			{
				runId: "trace-redaction",
				seq: 1,
				type: "review-verdict",
				at: 42,
				data: { header: "Authorization: [REDACTED]" },
			},
		]);
	});

	it("appends redacted JSONL records to a file", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-harness-trace-"));
		const filePath = join(root, "run.trace.jsonl");
		const trace = createFileTraceSink({ runId: "file-trace", filePath, now: () => 7 });

		await trace.append({ type: "worker-attempt", data: { password: "secret-password" } });

		const lines = (await readFile(filePath, "utf8")).trim().split("\n");
		expect(lines).toHaveLength(1);
		expect(JSON.parse(lines[0] ?? "{}")).toEqual({
			runId: "file-trace",
			seq: 0,
			type: "worker-attempt",
			at: 7,
			data: { password: "[REDACTED]" },
		});
	});

	it("redacts registered bare secret values", async () => {
		registerKnownSecret("sk-test-known-trace-secret");
		const trace = createInMemoryTraceSink({ runId: "trace-known-secret", now: () => 42 });

		await trace.append({
			type: "worker-attempt",
			data: { diff: "added sk-test-known-trace-secret to output" },
		});

		expect(trace.events()[0]?.data).toEqual({ diff: "added [REDACTED] to output" });
	});
});
