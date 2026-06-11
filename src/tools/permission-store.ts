import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { PROJECT_CONFIG_FILE_NAME } from "../config-file.ts";
import type { PermissionLevel } from "./types.ts";

export interface PermissionStoreOptions {
	cwd: string;
	configPath?: string;
}

export interface PermissionStore {
	getToolPermission(toolName: string): Promise<PermissionLevel | undefined>;
	setToolPermission(toolName: string, level: PermissionLevel): Promise<void>;
	allowForSession(toolName: string): void;
	isSessionAllowed(toolName: string): boolean;
	clearSessionAllows(): void;
}

type JsonRecord = Record<string, unknown>;

function isJsonRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}

function getConfigPath(options: PermissionStoreOptions): string {
	return options.configPath ?? join(options.cwd, PROJECT_CONFIG_FILE_NAME);
}

async function readProjectConfig(configPath: string): Promise<JsonRecord> {
	try {
		const content = await readFile(configPath, "utf8");
		const parsed = JSON.parse(content) as unknown;
		if (!isJsonRecord(parsed)) throw new Error(`project config must be a JSON object: ${configPath}`);
		return parsed;
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") return {};
		if (error instanceof SyntaxError) throw new Error(`project config contains invalid JSON: ${error.message}`);
		throw error;
	}
}

function getPolicyTools(config: JsonRecord): Record<string, PermissionLevel> | undefined {
	const policy = config.policy;
	if (!isJsonRecord(policy)) return undefined;
	const tools = policy.tools;
	if (!isJsonRecord(tools)) return undefined;
	return tools as Record<string, PermissionLevel>;
}

function setPolicyTool(config: JsonRecord, toolName: string, level: PermissionLevel): JsonRecord {
	const policy = isJsonRecord(config.policy) ? { ...config.policy } : {};
	const tools = isJsonRecord(policy.tools) ? { ...policy.tools } : {};
	tools[toolName] = level;
	return { ...config, policy: { ...policy, tools } };
}

async function writeProjectConfig(configPath: string, config: JsonRecord): Promise<void> {
	await mkdir(dirname(configPath), { recursive: true });
	await writeFile(configPath, `${JSON.stringify(config, null, "\t")}\n`);
}

class FilePermissionStore implements PermissionStore {
	private readonly configPath: string;
	private readonly sessionAllows = new Set<string>();

	constructor(options: PermissionStoreOptions) {
		this.configPath = getConfigPath(options);
	}

	async getToolPermission(toolName: string): Promise<PermissionLevel | undefined> {
		const config = await readProjectConfig(this.configPath);
		return getPolicyTools(config)?.[toolName];
	}

	async setToolPermission(toolName: string, level: PermissionLevel): Promise<void> {
		const config = await readProjectConfig(this.configPath);
		await writeProjectConfig(this.configPath, setPolicyTool(config, toolName, level));
	}

	allowForSession(toolName: string): void {
		this.sessionAllows.add(toolName);
	}

	isSessionAllowed(toolName: string): boolean {
		return this.sessionAllows.has(toolName);
	}

	clearSessionAllows(): void {
		this.sessionAllows.clear();
	}
}

export function createPermissionStore(options: PermissionStoreOptions): PermissionStore {
	return new FilePermissionStore(options);
}
