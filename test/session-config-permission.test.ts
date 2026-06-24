import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { describe, expect, test } from "vitest";
import {
	createStoredPermissionCallback,
	parsePermissionPromptAnswer,
	promptForPermissionDecision,
} from "../src/cli/permission-prompt.ts";
import { loadConfigLayers } from "../src/config-file.ts";
import { createJsonlSession, listSessions, openJsonlSession } from "../src/session/factory.ts";
import { createPermissionStore } from "../src/tools/permission-store.ts";

async function createTempRoot(name: string): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), `pi-harness-phase-11-${process.pid}-${tempCounter}-${name}-`));
	tempCounter++;
	return root;
}

let tempCounter = 0;

class StringWritable extends Writable {
	content = "";

	_write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
		this.content += chunk.toString();
		callback();
	}
}

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

	test("test_load_config_layers_rejects_api_headers_in_user_config_with_path", async () => {
		const root = await createTempRoot("config-api-headers-user");
		const cwd = join(root, "project");
		const userHome = join(root, "home");
		await mkdir(cwd, { recursive: true });
		await mkdir(join(userHome, ".pi-harness"), { recursive: true });
		await writeFile(join(userHome, ".pi-harness", "config.json"), JSON.stringify({ apiHeaders: { "x-test": "yes" } }));

		await expect(loadConfigLayers({ cwd, homeDir: userHome })).rejects.toThrow(
			"user config contains forbidden key apiHeaders",
		);
	});

	test("test_load_config_layers_rejects_api_headers_in_project_config_with_path", async () => {
		const root = await createTempRoot("config-api-headers-project");
		const cwd = join(root, "project");
		await mkdir(cwd, { recursive: true });
		await writeFile(join(cwd, "pi-harness.json"), JSON.stringify({ apiHeaders: { "x-test": "yes" } }));

		await expect(loadConfigLayers({ cwd, homeDir: join(root, "home") })).rejects.toThrow(
			"project config contains forbidden key apiHeaders",
		);
	});

	test("test_load_config_layers_rejects_agent_api_headers_with_path", async () => {
		const root = await createTempRoot("config-agent-api-headers");
		const cwd = join(root, "project");
		await mkdir(cwd, { recursive: true });
		await writeFile(
			join(cwd, "pi-harness.json"),
			JSON.stringify({
				agent: "reviewer",
				agents: {
					reviewer: { apiHeaders: { "x-agent": "yes" } },
				},
			}),
		);

		await expect(loadConfigLayers({ cwd, homeDir: join(root, "home") })).rejects.toThrow(
			"project config contains forbidden key agents.reviewer.apiHeaders",
		);
	});

	test("test_load_config_layers_rejects_sensitive_stream_headers_with_path", async () => {
		const cases = [
			["Authorization", "project config contains forbidden key streamOptions.headers.Authorization"],
			["cookie", "project config contains forbidden key streamOptions.headers.cookie"],
			["x-api-key", "project config contains forbidden key streamOptions.headers.x-api-key"],
		] as const;

		for (const [headerName, message] of cases) {
			const root = await createTempRoot(`config-sensitive-header-${headerName}`);
			const cwd = join(root, "project");
			await mkdir(cwd, { recursive: true });
			await writeFile(
				join(cwd, "pi-harness.json"),
				JSON.stringify({ streamOptions: { headers: { [headerName]: "secret" } } }),
			);

			await expect(loadConfigLayers({ cwd, homeDir: join(root, "home") })).rejects.toThrow(message);
		}
	});

	test("test_load_config_layers_accepts_policy_rules", async () => {
		const root = await createTempRoot("config-policy-rules");
		const cwd = join(root, "project");
		await mkdir(cwd, { recursive: true });
		await writeFile(
			join(cwd, "pi-harness.json"),
			JSON.stringify({
				policy: {
					rules: [{ id: "deny-secrets", toolName: "write", subject: "secrets/**", level: "deny" }],
				},
			}),
		);

		const config = await loadConfigLayers({ cwd, homeDir: join(root, "home") });

		expect(config.policy.rules).toEqual([
			{ id: "deny-secrets", toolName: "write", subject: "secrets/**", level: "deny" },
		]);
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

	test("test_store_backed_permission_callback_persists_scoped_always_by_tool_and_subject", async () => {
		const root = await createTempRoot("permission-scoped-always");
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

		await expect(callback("write", { path: "secrets/key.txt" }, { subject: "secrets/key.txt" })).resolves.toBe(true);
		await expect(callback("write", { path: "secrets/key.txt" }, { subject: "secrets/key.txt" })).resolves.toBe(true);
		await expect(callback("write", { path: "src/index.ts" }, { subject: "src/index.ts" })).resolves.toBe(true);

		expect(prompts).toBe(2);
		expect(JSON.parse(await readFile(join(cwd, "pi-harness.json"), "utf8"))).toEqual({
			policy: {
				tools: {
					"write:secrets/key.txt": "allow",
					"write:src/index.ts": "allow",
				},
			},
		});
	});

	test("test_store_backed_permission_callback_keeps_session_allows_scoped_by_subject", async () => {
		const root = await createTempRoot("permission-scoped-session");
		const cwd = join(root, "project");
		await mkdir(cwd, { recursive: true });
		const store = createPermissionStore({ cwd });
		let prompts = 0;
		const callback = createStoredPermissionCallback({
			store,
			prompt: async () => {
				prompts++;
				return "allow";
			},
		});

		await expect(callback("write", { path: "secrets/key.txt" }, { subject: "secrets/key.txt" })).resolves.toBe(true);
		await expect(callback("write", { path: "secrets/key.txt" }, { subject: "secrets/key.txt" })).resolves.toBe(true);
		await expect(callback("write", { path: "src/index.ts" }, { subject: "src/index.ts" })).resolves.toBe(true);

		expect(prompts).toBe(2);
	});

	test("test_permission_prompt_includes_subject_when_present", async () => {
		const input = Readable.from(["n\n"]);
		const output = new StringWritable();

		await expect(
			promptForPermissionDecision(
				{ toolName: "write", args: { path: "secrets/key.txt" }, subject: "secrets/key.txt" },
				{ input, output },
			),
		).resolves.toBe("deny");

		expect(output.content).toContain("subject: secrets/key.txt");
	});

	test("test_permission_prompt_answer_parses_never_and_empty_denial", () => {
		expect(parsePermissionPromptAnswer("d")).toBe("never");
		expect(parsePermissionPromptAnswer("never")).toBe("never");
		expect(parsePermissionPromptAnswer("")).toBe("deny");
	});
});
