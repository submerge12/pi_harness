import { createHash } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { createEvidenceGateway, type EvidenceAllowedDecision } from "../../src/evidence/index.ts";

type ExecResult = {
	stdout: string;
	stderr: string;
	exitCode: number;
};

function allowed(ruleId = "rule-1"): EvidenceAllowedDecision {
	return { level: "allow", ruleId };
}

async function readJson<T>(path: string): Promise<T> {
	return JSON.parse(await readFile(path, "utf8")) as T;
}

async function createRoot(): Promise<string> {
	return mkdtemp(join(tmpdir(), "pi-harness-evidence-"));
}

function fakeEnv(result: ExecResult) {
	return {
		async exec(command: string, options?: { abortSignal?: AbortSignal }) {
			expect(command).toBe("print-secret");
			expect(options?.abortSignal).toBeUndefined();
			return {
				ok: true as const,
				value: result,
			};
		},
	};
}

describe("evidence gateway", () => {
	test("redacts command secrets before storing the manifest", async () => {
		const rootDir = await createRoot();
		const command =
			"curl -H 'Authorization: Bearer command-bearer' --data 'api_key=command-api password=command-password'";
		const gateway = createEvidenceGateway({
			env: {
				async exec(receivedCommand: string) {
					expect(receivedCommand).toBe(command);
					return {
						ok: true as const,
						value: { stdout: "ok", stderr: "", exitCode: 0 },
					};
				},
			},
			rootDir,
			runId: "run-command-redaction",
			now: () => new Date("2026-06-24T00:00:00.000Z"),
		});

		const entry = await gateway.captureCommand({
			id: "cmd-redacted",
			command,
			subject: "repo:demo",
			allowed: allowed("command-redaction-rule"),
		});
		const manifest = await readJson<[typeof entry]>(
			join(rootDir, "evidence", "run-command-redaction", "manifest.json"),
		);
		const manifestText = JSON.stringify(manifest);

		expect(manifest[0].command).toContain("Authorization: [REDACTED]");
		expect(manifest[0].command).toContain("api_key=[REDACTED]");
		expect(manifest[0].command).toContain("password=[REDACTED]");
		expect(manifestText).not.toContain("command-bearer");
		expect(manifestText).not.toContain("command-api");
		expect(manifestText).not.toContain("command-password");
	});

	test("redacts stdout and stderr before persistence and hashes redacted stdout bytes", async () => {
		const rootDir = await createRoot();
		const gateway = createEvidenceGateway({
			env: fakeEnv({
				stdout: "token=stdout-secret\nAuthorization: Bearer stdout-bearer\nvisible\n",
				stderr: "password=stderr-secret\nfailed with Bearer stderr-bearer\n",
				exitCode: 7,
			}),
			rootDir,
			runId: "run-1",
			now: () => new Date("2026-06-24T01:02:03.000Z"),
		});

		const entry = await gateway.captureCommand({
			id: "cmd-1",
			command: "print-secret",
			subject: "repo:demo",
			allowed: allowed(),
		});

		const stdout = await readFile(join(rootDir, entry.stdoutRef), "utf8");
		const stderr = await readFile(join(rootDir, entry.stderrRef), "utf8");
		const manifest = await readJson<[typeof entry]>(join(rootDir, "evidence", "run-1", "manifest.json"));

		expect(stdout).toContain("token=[REDACTED]");
		expect(stdout).toContain("Authorization: [REDACTED]");
		expect(stdout).not.toContain("stdout-secret");
		expect(stdout).not.toContain("stdout-bearer");
		expect(stderr).toContain("password=[REDACTED]");
		expect(stderr).toContain("Bearer [REDACTED]");
		expect(stderr).not.toContain("stderr-secret");
		expect(stderr).not.toContain("stderr-bearer");
		expect(entry.sha256).toBe(createHash("sha256").update(Buffer.from(stdout)).digest("hex"));
		expect(entry.stderrSha256).toBe(createHash("sha256").update(Buffer.from(stderr)).digest("hex"));
		expect(entry.stderrSha256).not.toBe(createHash("sha256").update(Buffer.from(`${stderr}tampered`)).digest("hex"));
		expect(Array.isArray(manifest)).toBe(true);
		expect(manifest).toEqual([entry]);
		expect(entry).toMatchObject({
			id: "cmd-1",
			command: "print-secret",
			subject: "repo:demo",
			allowed: { level: "allow", ruleId: "rule-1" },
			exitCode: 7,
			binary: false,
			truncated: false,
			redactions: 4,
			capturedAt: "2026-06-24T01:02:03.000Z",
		});
	});

	test("redacts declared and actual write path metadata before storing the manifest", async () => {
		const rootDir = await createRoot();
		const gateway = createEvidenceGateway({
			env: fakeEnv({ stdout: "ok", stderr: "", exitCode: 0 }),
			rootDir,
			runId: "run-path-redaction",
			now: () => new Date("2026-06-24T02:00:00.000Z"),
		});

		const entry = await gateway.captureCommand({
			id: "cmd-paths",
			command: "print-secret",
			subject: "repo:demo",
			allowed: allowed("path-redaction-rule"),
			writeScope: ["src/token=scope-secret"],
			actualWritePaths: ["out/api_key=actual-secret.txt"],
		});
		const manifest = await readJson<[typeof entry]>(join(rootDir, "evidence", "run-path-redaction", "manifest.json"));
		const manifestText = JSON.stringify(manifest);

		expect(manifest[0].writeScope).toEqual(["src/token=[REDACTED]"]);
		expect(manifest[0].actualWritePaths).toEqual(["out/api_key=[REDACTED]"]);
		expect(manifestText).not.toContain("scope-secret");
		expect(manifestText).not.toContain("actual-secret");
	});

	test("persists optional DAG attribution fields when supplied", async () => {
		const rootDir = await createRoot();
		const gateway = createEvidenceGateway({
			env: fakeEnv({ stdout: "ok", stderr: "", exitCode: 0 }),
			rootDir,
			runId: "run-dag-attribution",
			now: () => new Date("2026-06-24T02:30:00.000Z"),
		});

		const attributed = await gateway.captureCommand({
			id: "cmd-attributed",
			command: "print-secret",
			subject: "repo:demo",
			allowed: allowed("dag-rule"),
			nodeId: "node-1",
			nodeNonce: "nonce-1",
			assignmentDigest: "sha256:assignment-1",
		});
		const unattributed = await gateway.captureCommand({
			id: "cmd-unattributed",
			command: "print-secret",
			subject: "repo:demo",
			allowed: allowed("dag-rule"),
		});
		const manifest = await readJson<[typeof attributed, typeof unattributed]>(
			join(rootDir, "evidence", "run-dag-attribution", "manifest.json"),
		);

		expect(manifest[0]).toMatchObject({
			nodeId: "node-1",
			nodeNonce: "nonce-1",
			assignmentDigest: "sha256:assignment-1",
		});
		expect(manifest[1]).not.toHaveProperty("nodeId");
		expect(manifest[1]).not.toHaveProperty("nodeNonce");
		expect(manifest[1]).not.toHaveProperty("assignmentDigest");
	});

	test("redacts JSON-style secret keys including token authorization and cookie", async () => {
		const rootDir = await createRoot();
		const gateway = createEvidenceGateway({
			env: fakeEnv({
				stdout:
					'{"token":"json-token","authorization":"json-authorization","cookie":"json-cookie","safe":"visible"}',
				stderr: "",
				exitCode: 0,
			}),
			rootDir,
			runId: "run-json-redaction",
			now: () => new Date("2026-06-24T03:00:00.000Z"),
		});

		const entry = await gateway.captureCommand({
			id: "cmd-json",
			command: "print-secret",
			subject: "repo:demo",
			allowed: allowed("json-rule"),
		});

		const stdout = await readFile(join(rootDir, entry.stdoutRef), "utf8");
		expect(stdout).toContain('"token":"[REDACTED]"');
		expect(stdout).toContain('"authorization":"[REDACTED]"');
		expect(stdout).toContain('"cookie":"[REDACTED]"');
		expect(stdout).toContain('"safe":"visible"');
		expect(stdout).not.toContain("json-token");
		expect(stdout).not.toContain("json-authorization");
		expect(stdout).not.toContain("json-cookie");
	});

	test("marks binary output without writing unredacted secrets", async () => {
		const rootDir = await createRoot();
		const gateway = createEvidenceGateway({
			env: fakeEnv({
				stdout: "prefix\u0000api_key=binary-secret\u0001",
				stderr: "",
				exitCode: 0,
			}),
			rootDir,
			runId: "run-binary",
			now: () => new Date("2026-06-24T04:00:00.000Z"),
		});

		const entry = await gateway.captureCommand({
			id: "cmd-bin",
			command: "print-secret",
			subject: "repo:demo",
			allowed: allowed("binary-rule"),
		});

		const stdout = await readFile(join(rootDir, entry.stdoutRef));
		expect(entry.binary).toBe(true);
		expect(stdout.toString("utf8")).not.toContain("binary-secret");
		expect(stdout.toString("utf8")).toContain("api_key=[REDACTED]");
	});

	test("bounds output size and records truncation after redaction", async () => {
		const rootDir = await createRoot();
		const gateway = createEvidenceGateway({
			env: fakeEnv({
				stdout: `${"visible-".repeat(20)} api_token=secret-value`,
				stderr: "",
				exitCode: 0,
			}),
			rootDir,
			runId: "run-truncate",
			now: () => new Date("2026-06-24T05:00:00.000Z"),
			maxOutputBytes: 24,
		});

		const entry = await gateway.captureCommand({
			id: "cmd-truncate",
			command: "print-secret",
			subject: "repo:demo",
			allowed: allowed("truncate-rule"),
		});

		const stdout = await readFile(join(rootDir, entry.stdoutRef));
		expect(entry.truncated).toBe(true);
		expect(entry.bytes.stdout).toBeLessThanOrEqual(24);
		expect(stdout.byteLength).toBeLessThanOrEqual(24);
		expect(stdout.toString("utf8")).not.toContain("secret-");
	});

	test("appends manifest entries in capture order with injected timestamps", async () => {
		const rootDir = await createRoot();
		const timestamps = [
			new Date("2026-06-24T06:00:00.000Z"),
			new Date("2026-06-24T06:00:01.000Z"),
		];
		const gateway = createEvidenceGateway({
			env: fakeEnv({ stdout: "ok", stderr: "", exitCode: 0 }),
			rootDir,
			runId: "run-order",
			now: () => timestamps.shift() ?? new Date("2026-06-24T06:00:02.000Z"),
		});

		const first = await gateway.captureCommand({
			id: "cmd-a",
			command: "print-secret",
			subject: "first",
			allowed: allowed("order-rule-a"),
		});
		const second = await gateway.captureCommand({
			id: "cmd-b",
			command: "print-secret",
			subject: "second",
			allowed: allowed("order-rule-b"),
		});

		const manifest = await readJson<Array<typeof first>>(join(rootDir, "evidence", "run-order", "manifest.json"));
		expect(Array.isArray(manifest)).toBe(true);
		expect(manifest.map((entry) => entry.id)).toEqual(["cmd-a", "cmd-b"]);
		expect(manifest.map((entry) => entry.capturedAt)).toEqual([
			"2026-06-24T06:00:00.000Z",
			"2026-06-24T06:00:01.000Z",
		]);
		expect(manifest).toEqual([first, second]);
	});

	test("rejects unsafe runId and id path segments", async () => {
		const rootDir = await createRoot();
		const unsafeSegments = [".", "..", "", "nested/cmd", "nested\\cmd", "cmd:1"];

		for (const unsafeRunId of unsafeSegments) {
			const gatewayWithUnsafeRunId = createEvidenceGateway({
				env: fakeEnv({ stdout: "ok", stderr: "", exitCode: 0 }),
				rootDir,
				runId: unsafeRunId,
				now: () => new Date("2026-06-24T07:00:00.000Z"),
			});

			await expect(
				gatewayWithUnsafeRunId.captureCommand({
					id: "cmd-safe",
					command: "print-secret",
					subject: "repo:demo",
					allowed: allowed("path-rule"),
				}),
			).rejects.toThrow("Invalid evidence runId");
		}

		for (const unsafeId of unsafeSegments) {
			const gatewayWithUnsafeId = createEvidenceGateway({
				env: fakeEnv({ stdout: "ok", stderr: "", exitCode: 0 }),
				rootDir,
				runId: "safe-run",
				now: () => new Date("2026-06-24T07:00:00.000Z"),
			});

			await expect(
				gatewayWithUnsafeId.captureCommand({
					id: unsafeId,
					command: "print-secret",
					subject: "repo:demo",
					allowed: allowed("path-rule"),
				}),
			).rejects.toThrow("Invalid evidence id");
		}
	});

	test("requires positive maxOutputBytes and forwards abort signal to exec", async () => {
		const rootDir = await createRoot();
		const signal = new AbortController().signal;
		const gateway = createEvidenceGateway({
			env: {
				async exec(command: string, options?: { abortSignal?: AbortSignal }) {
					expect(command).toBe("print-secret");
					expect(options?.abortSignal).toBe(signal);
					return {
						ok: true as const,
						value: { stdout: "ok", stderr: "", exitCode: 0 },
					};
				},
			},
			rootDir,
			runId: "run-signal",
			now: () => new Date("2026-06-24T08:00:00.000Z"),
			maxOutputBytes: 1,
		});

		await gateway.captureCommand({
			id: "cmd-signal",
			command: "print-secret",
			subject: "repo:demo",
			allowed: allowed("signal-rule"),
		}, signal);

		for (const maxOutputBytes of [0, Number.NaN, Number.POSITIVE_INFINITY]) {
			const invalidGateway = createEvidenceGateway({
				env: fakeEnv({ stdout: "ok", stderr: "", exitCode: 0 }),
				rootDir,
				runId: `run-invalid-max-${String(maxOutputBytes)}`,
				now: () => new Date("2026-06-24T08:00:00.000Z"),
				maxOutputBytes,
			});

			await expect(
				invalidGateway.captureCommand({
					id: "cmd-invalid-max",
					command: "print-secret",
					subject: "repo:demo",
					allowed: allowed("max-rule"),
				}),
			).rejects.toThrow("Invalid evidence maxOutputBytes");
		}
	});
});
