import { ExecutionError, FileError, err, ok } from "@earendil-works/pi-agent-core";
import type { ExecutionEnv, FileInfo, Result } from "@earendil-works/pi-agent-core";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { createEvidenceGateway, createEvidenceReceiptCollector } from "../src/evidence/index.ts";
import { createExecutionEnvCheckpointStore } from "../src/checkpoint/index.ts";
import { createBashTool } from "../src/tools/builtin/bash.ts";
import { createEditTool } from "../src/tools/builtin/edit.ts";
import { createFetchTool } from "../src/tools/builtin/fetch.ts";
import { createDefaultToolset } from "../src/tools/builtin/index.ts";
import { createLsTool } from "../src/tools/builtin/ls.ts";
import { createReadTool } from "../src/tools/builtin/read.ts";
import { createWriteTool } from "../src/tools/builtin/write.ts";
import { resolveWithinRoot } from "../src/tools/sandbox.ts";

class MemoryEnv implements ExecutionEnv {
	cwd: string;
	private files: Map<string, string>;
	private canonicalPaths = new Map<string, string>();
	private directories = new Set<string>();
	private execResult = { stdout: "", stderr: "", exitCode: 0 };

	constructor(cwd: string, files: Record<string, string> = {}) {
		this.cwd = path.posix.normalize(cwd);
		this.files = new Map(Object.entries(files).map(([filePath, content]) => [path.posix.normalize(filePath), content]));
		this.directories.add(this.cwd);
		for (const filePath of this.files.keys()) this.addParentDirectories(filePath);
	}

	setExecResult(result: { stdout: string; stderr: string; exitCode: number }): void {
		this.execResult = result;
	}

	setCanonicalPath(filePath: string, canonicalPath: string): void {
		this.canonicalPaths.set(this.toAbsolutePath(filePath), path.posix.normalize(canonicalPath));
	}

	async absolutePath(filePath: string): Promise<Result<string, FileError>> {
		return ok(this.toAbsolutePath(filePath));
	}

	async joinPath(parts: string[]): Promise<Result<string, FileError>> {
		return ok(path.posix.normalize(parts.join("/")));
	}

	async readTextFile(filePath: string): Promise<Result<string, FileError>> {
		const normalized = this.toAbsolutePath(filePath);
		const content = this.files.get(normalized);
		if (content === undefined) return err(new FileError("not_found", `Not found: ${normalized}`, normalized));
		return ok(content);
	}

	async readTextLines(filePath: string, options: { maxLines?: number } = {}): Promise<Result<string[], FileError>> {
		const result = await this.readTextFile(filePath);
		if (!result.ok) return result;
		const lines = result.value.split(/\r?\n/);
		return ok(options.maxLines === undefined ? lines : lines.slice(0, options.maxLines));
	}

	async readBinaryFile(filePath: string): Promise<Result<Uint8Array, FileError>> {
		const result = await this.readTextFile(filePath);
		if (!result.ok) return result;
		return ok(new TextEncoder().encode(result.value));
	}

	async writeFile(filePath: string, content: string | Uint8Array): Promise<Result<void, FileError>> {
		const normalized = this.toAbsolutePath(filePath);
		this.files.set(normalized, typeof content === "string" ? content : new TextDecoder().decode(content));
		this.addParentDirectories(normalized);
		return ok(undefined);
	}

	async appendFile(filePath: string, content: string | Uint8Array): Promise<Result<void, FileError>> {
		const normalized = this.toAbsolutePath(filePath);
		const current = this.files.get(normalized) ?? "";
		const next = typeof content === "string" ? content : new TextDecoder().decode(content);
		this.files.set(normalized, current + next);
		this.addParentDirectories(normalized);
		return ok(undefined);
	}

	async fileInfo(filePath: string): Promise<Result<FileInfo, FileError>> {
		const normalized = this.toAbsolutePath(filePath);
		if (this.files.has(normalized)) return ok(this.info(normalized, "file"));
		if (this.directories.has(normalized)) return ok(this.info(normalized, "directory"));
		return err(new FileError("not_found", `Not found: ${normalized}`, normalized));
	}

	async listDir(filePath: string): Promise<Result<FileInfo[], FileError>> {
		const directory = this.toAbsolutePath(filePath);
		if (!this.directories.has(directory)) return err(new FileError("not_directory", `Not a directory: ${directory}`, directory));
		const prefix = directory.endsWith("/") ? directory : `${directory}/`;
		const childPaths = new Set<string>();
		for (const candidate of [...this.directories, ...this.files.keys()]) {
			if (!candidate.startsWith(prefix) || candidate === directory) continue;
			const relative = candidate.slice(prefix.length);
			const [child] = relative.split("/");
			if (child) childPaths.add(path.posix.join(directory, child));
		}
		return ok([...childPaths].sort().map((childPath) => this.info(childPath, this.files.has(childPath) ? "file" : "directory")));
	}

	async canonicalPath(filePath: string): Promise<Result<string, FileError>> {
		const normalized = this.toAbsolutePath(filePath);
		return ok(this.canonicalPaths.get(normalized) ?? normalized);
	}

	async exists(filePath: string): Promise<Result<boolean, FileError>> {
		const normalized = this.toAbsolutePath(filePath);
		return ok(this.files.has(normalized) || this.directories.has(normalized));
	}

	async createDir(filePath: string): Promise<Result<void, FileError>> {
		this.directories.add(this.toAbsolutePath(filePath));
		return ok(undefined);
	}

	async remove(): Promise<Result<void, FileError>> {
		return err(new FileError("not_supported", "MemoryEnv does not remove files"));
	}

	async createTempDir(): Promise<Result<string, FileError>> {
		return err(new FileError("not_supported", "MemoryEnv does not create temp directories"));
	}

	async createTempFile(): Promise<Result<string, FileError>> {
		return err(new FileError("not_supported", "MemoryEnv does not create temp files"));
	}

	async exec(): Promise<Result<{ stdout: string; stderr: string; exitCode: number }, ExecutionError>> {
		return ok(this.execResult);
	}

	async cleanup(): Promise<void> {}

	private toAbsolutePath(filePath: string): string {
		return path.posix.normalize(path.posix.isAbsolute(filePath) ? filePath : path.posix.join(this.cwd, filePath));
	}

	private addParentDirectories(filePath: string): void {
		let current = path.posix.dirname(filePath);
		while (current && current !== ".") {
			this.directories.add(current);
			const next = path.posix.dirname(current);
			if (next === current) return;
			current = next;
		}
	}

	private info(filePath: string, kind: FileInfo["kind"]): FileInfo {
		return {
			name: path.posix.basename(filePath),
			path: filePath,
			kind,
			size: this.files.get(filePath)?.length ?? 0,
			mtimeMs: 0,
		};
	}
}

async function readEnvText(env: MemoryEnv, filePath: string): Promise<string> {
	const result = await env.readTextFile(filePath);
	if (!result.ok) throw result.error;
	return result.value;
}

describe("resolveWithinRoot", () => {
	it("allows relative paths that stay inside the POSIX root", () => {
		expect(resolveWithinRoot("/repo", "src/../package.json")).toBe("/repo/package.json");
	});

	it("rejects POSIX absolute paths outside the root", () => {
		expect(() => resolveWithinRoot("/repo", "/etc/passwd")).toThrow(/escapes sandbox root/);
	});

	it("handles Windows drive paths and rejects traversal outside the root", () => {
		expect(resolveWithinRoot("C:\\repo", "src\\file.ts")).toBe("C:\\repo\\src\\file.ts");
		expect(() => resolveWithinRoot("C:\\repo", "..\\Windows\\system32\\drivers\\etc\\hosts")).toThrow(
			/escapes sandbox root/,
		);
	});

	it("handles Windows UNC roots without allowing sibling shares", () => {
		expect(resolveWithinRoot("\\\\server\\share\\repo", "src\\file.ts")).toBe("\\\\server\\share\\repo\\src\\file.ts");
		expect(() => resolveWithinRoot("\\\\server\\share\\repo", "\\\\server\\share\\other\\file.ts")).toThrow(
			/escapes sandbox root/,
		);
	});

	it("allows filesystem root children", () => {
		expect(resolveWithinRoot("/", "tmp/file")).toBe("/tmp/file");
		expect(resolveWithinRoot("C:\\", "tmp\\file")).toBe("C:\\tmp\\file");
	});
});

describe("built-in toolset", () => {
	it("registers built-ins with their required access levels", () => {
		const env = new MemoryEnv("/repo");
		const registry = createDefaultToolset({ env, roots: ["/repo"], fetch: async () => new Response("ok") });

		expect(registry.getRegistration("read")?.accessLevel).toBe("read-only");
		expect(registry.getRegistration("write")?.accessLevel).toBe("write");
		expect(registry.getRegistration("edit")?.accessLevel).toBe("write");
		expect(registry.getRegistration("ls")?.accessLevel).toBe("read-only");
		expect(registry.getRegistration("grep")?.accessLevel).toBe("read-only");
		expect(registry.getRegistration("glob")?.accessLevel).toBe("read-only");
		expect(registry.getRegistration("bash")?.accessLevel).toBe("destructive");
		expect(registry.getRegistration("fetch")?.accessLevel).toBe("network");
	});

	it("reads files through the execution environment", async () => {
		const env = new MemoryEnv("/repo", { "/repo/package.json": "{\"name\":\"pi-harness\"}" });
		const tool = createReadTool({ env, roots: ["/repo"] });

		await expect(tool.execute("call-1", { path: "package.json" })).resolves.toMatchObject({
			content: [{ type: "text", text: "{\"name\":\"pi-harness\"}" }],
			details: { toolCallId: "call-1", path: "/repo/package.json", truncated: false },
		});
	});

	it("blocks read when canonical path escapes the sandbox", async () => {
		const env = new MemoryEnv("/repo", { "/repo/link.txt": "secret" });
		env.setCanonicalPath("/repo/link.txt", "/outside/secret.txt");
		const tool = createReadTool({ env, roots: ["/repo"] });

		await expect(tool.execute("call-1", { path: "link.txt" })).rejects.toThrow(/escapes sandbox root/);
	});

	it("lists direct directory entries through the execution environment", async () => {
		const env = new MemoryEnv("/repo", {
			"/repo/package.json": "{}",
			"/repo/src/index.ts": "export {};",
		});
		const tool = createLsTool({ env, roots: ["/repo"] });

		const result = await tool.execute("call-1", { path: "." });

		expect(result.content[0]).toMatchObject({
			type: "text",
			text: "directory src\nfile package.json",
		});
		expect(result.details).toMatchObject({ toolCallId: "call-1", path: "/repo", truncated: false });
	});

	it("truncates large read output with a clear notice", async () => {
		const env = new MemoryEnv("/repo", { "/repo/long.txt": "abcdefghijklmnopqrstuvwxyz" });
		const tool = createReadTool({ env, roots: ["/repo"], maxOutputChars: 10 });

		const result = await tool.execute("call-1", { path: "long.txt" });

		expect(result.content[0]).toMatchObject({
			type: "text",
			text: "abcdefghij\n\n[Output truncated to 10 of 26 characters.]",
		});
		expect(result.details).toMatchObject({ truncated: true });
	});

	it("runs bash through the execution environment and truncates output", async () => {
		const env = new MemoryEnv("/repo");
		env.setExecResult({ stdout: "abcdefghij", stderr: "klmnopqrst", exitCode: 0 });
		const tool = createBashTool({ env, roots: ["/repo"], maxOutputChars: 12 });

		const result = await tool.execute("call-1", { command: "echo hi" });

		expect(result.content[0]).toMatchObject({
			type: "text",
			text: "exitCode: 0\n\n[Output truncated to 12 of 49 characters.]",
		});
		expect(result.details).toMatchObject({ toolCallId: "call-1", exitCode: 0, truncated: true });
	});

	it("blocks denied command rules before bash execution", async () => {
		const env = new MemoryEnv("/repo");
		const tool = createBashTool({
			env,
			roots: ["/repo"],
			commandRules: [{ id: "deny-bulk-delete", action: "deny", pattern: /rm\s+-rf/i }],
		});

		await expect(tool.execute("call-1", { command: "rm -rf dist" })).rejects.toThrow(
			"Command denied by rule deny-bulk-delete",
		);
	});

	it("snapshots and records receipts for successful write calls", async () => {
		const rootDir = await mkdtemp(path.join(tmpdir(), "pi-harness-write-receipt-"));
		const env = new MemoryEnv("/repo", { "/repo/src/result.txt": "before" });
		const checkpoint = createExecutionEnvCheckpointStore({ env, roots: ["/repo"] });
		const receipts = createEvidenceReceiptCollector();
		receipts.markAttemptStart(1);
		const gateway = createEvidenceGateway({
			env,
			rootDir,
			runId: "run-write-tool",
			now: () => new Date("2026-06-24T10:00:00.000Z"),
			onEntry: (entry) => receipts.record(entry),
		});
		const tool = createWriteTool({
			env,
			roots: ["/repo"],
			checkpoint,
			evidenceGateway: gateway,
			getPermissionDecision: () => ({
				subject: "src/result.txt",
				allowed: { level: "allow", ruleId: "allow-write" },
				writeScope: ["src"],
			}),
		});

		checkpoint.beginAttempt?.(1);
		await tool.execute("write-call", { path: "src/result.txt", content: "after" });
		checkpoint.finishAttempt?.();
		await checkpoint.restore(1);

		expect(await readEnvText(env, "/repo/src/result.txt")).toBe("before");
		expect(receipts.receiptsForAttempt(1)).toHaveLength(1);
		expect(receipts.entries()).toHaveLength(1);
		expect(receipts.receiptsForAttempt(1)[0]).toMatchObject({
			id: "write-call",
			command: "write src/result.txt",
			subject: "src/result.txt",
			allowed: { level: "allow", ruleId: "allow-write" },
			writeScope: ["src"],
			actualWritePaths: ["src/result.txt"],
			exitCode: 0,
		});
	});

	it("snapshots and records receipts for successful edit calls", async () => {
		const rootDir = await mkdtemp(path.join(tmpdir(), "pi-harness-edit-receipt-"));
		const env = new MemoryEnv("/repo", { "/repo/src/result.txt": "before value" });
		const checkpoint = createExecutionEnvCheckpointStore({ env, roots: ["/repo"] });
		const receipts = createEvidenceReceiptCollector();
		receipts.markAttemptStart(2);
		const gateway = createEvidenceGateway({
			env,
			rootDir,
			runId: "run-edit-tool",
			now: () => new Date("2026-06-24T10:30:00.000Z"),
			onEntry: (entry) => receipts.record(entry),
		});
		const tool = createEditTool({
			env,
			roots: ["/repo"],
			checkpoint,
			evidenceGateway: gateway,
			getPermissionDecision: () => ({
				subject: "src/result.txt",
				allowed: { level: "allow", ruleId: "allow-edit" },
				writeScope: ["src"],
			}),
		});

		checkpoint.beginAttempt?.(2);
		await tool.execute("edit-call", { path: "src/result.txt", search: "before", replace: "after" });
		checkpoint.finishAttempt?.();
		await checkpoint.restore(2);

		expect(await readEnvText(env, "/repo/src/result.txt")).toBe("before value");
		expect(receipts.receiptsForAttempt(2)).toHaveLength(1);
		expect(receipts.receiptsForAttempt(2)[0]).toMatchObject({
			id: "edit-call",
			command: "edit src/result.txt",
			subject: "src/result.txt",
			allowed: { level: "allow", ruleId: "allow-edit" },
			writeScope: ["src"],
			actualWritePaths: ["src/result.txt"],
			exitCode: 0,
		});
	});

	it("routes bash through the evidence gateway with the recorded permission decision", async () => {
		const rootDir = await mkdtemp(path.join(tmpdir(), "pi-harness-bash-evidence-"));
		const env = new MemoryEnv("/repo");
		env.setExecResult({ stdout: "token=planted-secret\nvisible", stderr: "", exitCode: 0 });
		const gateway = createEvidenceGateway({
			env,
			rootDir,
			runId: "run-bash-tool",
			now: () => new Date("2026-06-24T09:00:00.000Z"),
		});
		const tool = createBashTool({
			env,
			roots: ["/repo"],
			evidenceGateway: gateway,
			getPermissionDecision: () => ({
				subject: "echo token=planted-secret",
				allowed: { level: "allow", ruleId: "allow-bash" },
				writeScope: ["src"],
			}),
		});

		const result = await tool.execute("call-1", { command: "echo token=planted-secret" });
		const manifest = JSON.parse(
			await readFile(path.join(rootDir, "evidence", "run-bash-tool", "manifest.json"), "utf8"),
		) as Array<Record<string, unknown>>;
		const manifestText = JSON.stringify(manifest);

		expect(result.content[0]).toMatchObject({
			type: "text",
			text: "exitCode: 0\nstdout:\ntoken=[REDACTED]\nvisible",
		});
		expect(manifest[0]).toMatchObject({
			id: "call-1",
			command: "echo token=[REDACTED]",
			subject: "echo token=[REDACTED]",
			allowed: { level: "allow", ruleId: "allow-bash" },
			writeScope: ["src"],
			actualWritePaths: [],
		});
		expect(manifest[0]?.sha256).toMatch(/^[a-f0-9]{64}$/);
		expect(manifestText).not.toContain("planted-secret");
	});

	it("blocks bash when canonical cwd escapes the sandbox", async () => {
		const env = new MemoryEnv("/repo");
		await env.createDir("/repo/link-dir");
		env.setCanonicalPath("/repo/link-dir", "/outside");
		const tool = createBashTool({ env, roots: ["/repo"] });

		await expect(tool.execute("call-1", { command: "pwd", cwd: "link-dir" })).rejects.toThrow(
			/escapes sandbox root/,
		);
	});

	it("fetches with GET and enforces the response size cap without real network", async () => {
		const requests: Array<{ url: string; method: string | undefined }> = [];
		const tool = createFetchTool({
			maxBytes: 5,
			fetch: async (url, init) => {
				requests.push({ url: String(url), method: init?.method });
				return new Response("abcdef", { status: 200, headers: { "content-type": "text/plain" } });
			},
		});

		const result = await tool.execute("call-1", { url: "https://example.invalid/data" });

		expect(requests).toEqual([{ url: "https://example.invalid/data", method: "GET" }]);
		expect(result.content[0]).toMatchObject({
			type: "text",
			text: "status: 200\ncontent-type: text/plain\n\nabcde\n\n[Output truncated to 5 bytes.]",
		});
		expect(result.details).toMatchObject({ toolCallId: "call-1", url: "https://example.invalid/data", truncated: true });
	});

	it("records fetch responses through the evidence gateway with the recorded permission decision", async () => {
		const rootDir = await mkdtemp(path.join(tmpdir(), "pi-harness-fetch-evidence-"));
		const gateway = createEvidenceGateway({
			env: {
				async exec() {
					throw new Error("fetch evidence should persist the already-fetched response");
				},
			},
			rootDir,
			runId: "run-fetch-tool",
			now: () => new Date("2026-06-24T09:30:00.000Z"),
		});
		const tool = createFetchTool({
			evidenceGateway: gateway,
			getPermissionDecision: () => ({
				subject: "https://example.invalid/data?token=planted-secret",
				allowed: { level: "allow", ruleId: "allow-fetch" },
				writeScope: ["docs"],
			}),
			fetch: async () => new Response("api_key=planted-secret\nvisible", { status: 200 }),
		});

		const result = await tool.execute("fetch-call", { url: "https://example.invalid/data?token=planted-secret" });
		const manifest = JSON.parse(
			await readFile(path.join(rootDir, "evidence", "run-fetch-tool", "manifest.json"), "utf8"),
		) as Array<Record<string, unknown>>;
		const manifestText = JSON.stringify(manifest);

		expect(result.content[0]).toMatchObject({ text: expect.stringContaining("api_key=[REDACTED]") });
		expect(manifest[0]).toMatchObject({
			id: "fetch-call",
			command: "fetch https://example.invalid/data?token=[REDACTED]",
			subject: "https://example.invalid/data?token=[REDACTED]",
			allowed: { level: "allow", ruleId: "allow-fetch" },
			writeScope: ["docs"],
			actualWritePaths: [],
		});
		expect(manifest[0]?.sha256).toMatch(/^[a-f0-9]{64}$/);
		expect(manifestText).not.toContain("planted-secret");
	});
});
