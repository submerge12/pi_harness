import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfigLayerOverrides } from "../src/config-file.ts";
import { resolveHarnessConfig } from "../src/config.ts";

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("framework capability config", () => {
	it("resolves database URLs from config before DATABASE_URL", () => {
		vi.stubEnv("DATABASE_URL", "postgresql://env/db");

		expect(resolveHarnessConfig({}).database).toEqual({
			url: "postgresql://env/db",
			maxConnections: undefined,
		});
		expect(resolveHarnessConfig({ database: { url: "postgresql://config/db", maxConnections: 4 } }).database).toEqual({
			url: "postgresql://config/db",
			maxConnections: 4,
		});
	});

	it("loads database and scheduler config from project files and agent overrides", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-harness-framework-config-"));
		const homeDir = await mkdtemp(join(tmpdir(), "pi-harness-framework-home-"));
		const projectConfigPath = join(cwd, "pi-harness.json");
		await writeFile(
			projectConfigPath,
			JSON.stringify({
				agent: "travel",
				database: { url: "postgresql://project/db", maxConnections: 6 },
				scheduler: { checkIntervalMs: 1000 },
				agents: {
					travel: {
						database: { maxConnections: 2 },
						scheduler: {
							checkIntervalMs: 500,
							tasks: [
								{
									id: "morning-commute",
									agentProfile: "travel",
									taskType: "proactive_check",
									schedule: { cron: "30 7 * * 1-5", timezone: "Asia/Shanghai" },
									enabled: true,
								},
							],
						},
					},
				},
			}),
			"utf8",
		);

		const config = await loadConfigLayerOverrides({ cwd, homeDir, projectConfigPath });

		expect(config.database).toEqual({ url: "postgresql://project/db", maxConnections: 2 });
		expect(config.scheduler).toEqual({
			checkIntervalMs: 500,
			tasks: [
				{
					id: "morning-commute",
					agentProfile: "travel",
					taskType: "proactive_check",
					schedule: { cron: "30 7 * * 1-5", timezone: "Asia/Shanghai" },
					enabled: true,
				},
			],
		});
	});
});
