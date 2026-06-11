import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { createStoredPermissionCallback, parsePermissionPromptAnswer } from "../src/cli/permission-prompt.ts";
import { loadConfigLayers } from "../src/config-file.ts";
import { createJsonlSession, listSessions, openJsonlSession } from "../src/session/factory.ts";
import { createPermissionStore } from "../src/tools/permission-store.ts";

async function createTempRoot(name: string): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), `pi-harness-phase-11-${process.pid}-${tempCounter}-${name}-`));
	tempCounter++;
	return root;
}

let tempCounter = 0;

describe("session factory helpers", () => {
	test("test_list_sessions_filters_current_cwd_and_orders_newest_first", async () => {
		const root = await createTempRoot("session-list");
		const cwd = join(root, "project");
		const otherCwd = join(root, "other");
		const sessionsRoot = join(root, "sessions");
		await mkdir(cwd, { recursive: true });
		await mkdir(otherCwd, { recursive: true });

		const first = await createJsonlSession({ cwd, sessionsRoot });
		const second = await createJsonlSession({ cwd, sessionsRoot });
		await createJsonlSession({ cwd: otherCwd, sessionsRoot });

		const firstMetadata = await first.session.getMetadata();
		const secondMetadata = await second.session.getMetadata();
		const sessions = await listSessions({ cwd, sessionsRoot });

		expect(sessions.map((session) => session.id).sort()).toEqual([firstMetadata.id, secondMetadata.id].sort());
		expect(sessions.every((session) => session.cwd === cwd)).toBe(true);
	});

	test("test_open_jsonl_session_returns_requested_session_shape", async () => {
		const root = await createTempRoot("session-open");
		const cwd = join(root, "project");
		const sessionsRoot = join(root, "sessions");
		await mkdir(cwd, { recursive: true });

		const created = await createJsonlSession({ cwd, sessionsRoot });
		const createdMetadata = await created.session.getMetadata();
		const opened = await openJsonlSession({ cwd, sessionsRoot, sessionId: createdMetadata.id });
		const openedMetadata = await opened.session.getMetadata();

		expect(opened.env.cwd).toBe(cwd);
		expect(openedMetadata.id).toBe(createdMetadata.id);
		expect(openedMetadata.cwd).toBe(cwd);
	});
});

describe("config file layering", () => {
	test("test_load_config_layers_merges_defaults_user_project_and_cli", async () => {
		const root = await createTempRoot("config-layering");
		const cwd = join(root, "project");
		const userHome = join(root, "home");
		await mkdir(cwd, { recursive: true });
		await mkdir(join(userHome, ".pi-harness"), { recursive: true });
		await writeFile(
			join(userHome, ".pi-harness", "config.json"),
			JSON.stringify({ provider: "deepseek", modelId: "from-user", activeToolNames: ["read"] }),
		);
		await writeFile(
			join(cwd, "pi-harness.json"),
			JSON.stringify({ modelId: "from-project", sessionsRoot: ".project-sessions" }),
		);

		const config = await loadConfigLayers({ cwd, homeDir: userHome, cli: { modelId: "from-cli" } });

		expect(config.cwd).toBe(cwd);
		expect(config.provider).toBe("deepseek");
		expect(config.modelId).toBe("from-cli");
		expect(config.sessionsRoot).toBe(".project-sessions");
		expect(config.activeToolNames).toEqual(["read"]);
	});

	test("test_load_config_layers_rejects_api_key_in_user_config_with_path", async () => {
		const root = await createTempRoot("config-api-key");
		const cwd = join(root, "project");
		const userHome = join(root, "home");
		await mkdir(cwd, { recursive: true });
		await mkdir(join(userHome, ".pi-harness"), { recursive: true });
		await writeFile(join(userHome, ".pi-harness", "config.json"), JSON.stringify({ apiKey: "secret" }));

		await expect(loadConfigLayers({ cwd, homeDir: userHome })).rejects.toThrow(
			"user config contains forbidden key apiKey",
		);
	});
});

describe("permission store", () => {
	test("test_permission_store_updates_project_policy_tool_decision", async () => {
		const root = await createTempRoot("permission-store");
		const cwd = join(root, "project");
		await mkdir(cwd, { recursive: true });

		const store = createPermissionStore({ cwd });
		await store.setToolPermission("bash", "allow");

		const content = await readFile(join(cwd, "pi-harness.json"), "utf8");
		expect(JSON.parse(content)).toEqual({ policy: { tools: { bash: "allow" } } });
	});

	test("test_permission_store_tracks_session_allow_without_writing_config", async () => {
		const root = await createTempRoot("permission-session");
		const cwd = join(root, "project");
		await mkdir(cwd, { recursive: true });

		const store = createPermissionStore({ cwd });
		store.allowForSession("read");

		expect(store.isSessionAllowed("read")).toBe(true);
		await expect(readFile(join(cwd, "pi-harness.json"), "utf8")).rejects.toThrow();
	});

	test("test_store_backed_permission_callback_persists_always_and_reuses_decision", async () => {
		const root = await createTempRoot("permission-always");
		const cwd = join(root, "project");
		await mkdir(cwd, { recursive: true });
		const store = createPermissionStore({ cwd });
		let prompts = 0;
		const callback = createStoredPermissionCallback({
			store,
			prompt: async () => {
				prompts++;
				return "always";
			},
		});

		await expect(callback("bash", {})).resolves.toBe(true);
		await expect(callback("bash", {})).resolves.toBe(true);

		expect(prompts).toBe(1);
		expect(JSON.parse(await readFile(join(cwd, "pi-harness.json"), "utf8"))).toEqual({
			policy: { tools: { bash: "allow" } },
		});
	});

	test("test_permission_prompt_answer_parses_never_and_empty_denial", () => {
		expect(parsePermissionPromptAnswer("d")).toBe("never");
		expect(parsePermissionPromptAnswer("never")).toBe("never");
		expect(parsePermissionPromptAnswer("")).toBe("deny");
	});
});
