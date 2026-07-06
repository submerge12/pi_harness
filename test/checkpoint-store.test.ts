import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { describe, expect, it } from "vitest";
import {
	createExecutionEnvCheckpointStore,
	createInMemoryCheckpointStore,
	safeCheckpointPath,
} from "../src/checkpoint/index.ts";

describe("checkpoint store", () => {
	it("restores pre-edit content for an attempt", async () => {
		const store = createInMemoryCheckpointStore({
			rootDir: "/repo",
			files: { "src/result.txt": "before" },
		});

		await store.snapshot(1, "src/result.txt");
		store.writeFile("src/result.txt", "after");
		await store.restore(1);

		expect(store.readFile("src/result.txt")).toBe("before");
	});

	it("deletes files that did not exist before the attempt snapshot", async () => {
		const store = createInMemoryCheckpointStore({ rootDir: "/repo" });

		await store.snapshot(1, "src/new.txt");
		store.writeFile("src/new.txt", "created");
		await store.restore(1);

		expect(store.readFile("src/new.txt")).toBeUndefined();
	});

	it("restores a write-scope baseline for files changed without per-path snapshots", async () => {
		const store = createInMemoryCheckpointStore({
			rootDir: "/repo",
			files: {
				"src/result.txt": "before",
				"src/nested/keep.txt": "keep",
			},
		});

		await store.baselineAttempt?.(1, ["src/**"]);
		store.writeFile("src/result.txt", "after");
		store.writeFile("src/nested/new.txt", "created");
		await store.restore(1);

		expect(store.readFile("src/result.txt")).toBe("before");
		expect(store.readFile("src/nested/keep.txt")).toBe("keep");
		expect(store.readFile("src/nested/new.txt")).toBeUndefined();
	});

	it("rejects paths that escape the workspace root", () => {
		expect(() => safeCheckpointPath("../secrets.txt")).toThrow("write scope path must not escape root");
		expect(() => createInMemoryCheckpointStore({
			rootDir: "/repo",
			files: { "C:\\repo\\secret.txt": "nope" },
		})).toThrow("write scope path must be relative and colon-free");
	});
});

describe("execution-env checkpoint store", () => {
	async function scaffold() {
		const cwd = await mkdtemp(join(tmpdir(), "pi-env-checkpoint-"));
		await mkdir(join(cwd, "src"), { recursive: true });
		const env = new NodeExecutionEnv({ cwd });
		return { cwd, env };
	}

	it("restores baseline content and removes created files on the real filesystem", async () => {
		const { cwd, env } = await scaffold();
		await writeFile(join(cwd, "src", "result.txt"), "before\n", "utf8");
		const store = createExecutionEnvCheckpointStore({ env });

		store.beginAttempt?.(1);
		await store.baselineAttempt?.(1, ["src"]);
		await writeFile(join(cwd, "src", "result.txt"), "dirty from bash\n", "utf8");
		await writeFile(join(cwd, "src", "created.txt"), "created\n", "utf8");
		store.finishAttempt?.();
		await store.restore(1);

		expect(await readFile(join(cwd, "src", "result.txt"), "utf8")).toBe("before\n");
		expect(existsSync(join(cwd, "src", "created.txt"))).toBe(false);
	});

	it("round-trips binary content through baseline and restore without corruption", async () => {
		const { cwd, env } = await scaffold();
		// Invalid UTF-8: text decoding would replace bytes and corrupt on restore.
		const binary = Uint8Array.from([0xff, 0xfe, 0x00, 0x01, 0x80, 0xc3, 0x28, 0x9f]);
		await writeFile(join(cwd, "src", "asset.bin"), binary);
		const store = createExecutionEnvCheckpointStore({ env });

		store.beginAttempt?.(1);
		await store.baselineAttempt?.(1, ["src"]);
		await writeFile(join(cwd, "src", "asset.bin"), Uint8Array.from([0x01, 0x02]));
		store.finishAttempt?.();
		await store.restore(1);

		const restored = new Uint8Array(await readFile(join(cwd, "src", "asset.bin")));
		expect([...restored]).toEqual([...binary]);
	});

	it("fails the baseline loudly when a file exceeds the per-file snapshot cap", async () => {
		const { cwd, env } = await scaffold();
		await writeFile(join(cwd, "src", "huge.txt"), "x".repeat(64), "utf8");
		const store = createExecutionEnvCheckpointStore({ env, maxFileBytes: 16 });

		store.beginAttempt?.(1);
		await expect(store.baselineAttempt?.(1, ["src"])).rejects.toThrow("per-file cap");
	});

	it("fails the baseline loudly when the attempt total exceeds the snapshot cap", async () => {
		const { cwd, env } = await scaffold();
		await writeFile(join(cwd, "src", "a.txt"), "x".repeat(40), "utf8");
		await writeFile(join(cwd, "src", "b.txt"), "y".repeat(40), "utf8");
		const store = createExecutionEnvCheckpointStore({ env, maxFileBytes: 64, maxTotalBytes: 64 });

		store.beginAttempt?.(1);
		await expect(store.baselineAttempt?.(1, ["src"])).rejects.toThrow("snapshot total");
	});
});
