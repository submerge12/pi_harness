import { describe, expect, it } from "vitest";
import { createInMemoryCheckpointStore, safeCheckpointPath } from "../src/checkpoint/index.ts";

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

	it("rejects paths that escape the workspace root", () => {
		expect(() => safeCheckpointPath("../secrets.txt")).toThrow("write scope path must not escape root");
		expect(() => createInMemoryCheckpointStore({
			rootDir: "/repo",
			files: { "C:\\repo\\secret.txt": "nope" },
		})).toThrow("write scope path must be relative and colon-free");
	});
});
