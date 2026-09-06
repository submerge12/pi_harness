import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	Array as TypeArray,
	Boolean as TypeBoolean,
	Literal,
	Number as TypeNumber,
	Object as TypeObject,
	Optional,
	Partial as TypePartial,
	Record as TypeRecord,
	String as TypeString,
	Union,
	Unknown,
} from "typebox";
import { Check, Errors } from "typebox/value";
import { resolveHarnessConfig, type HarnessConfig, type ResolvedHarnessConfig } from "./config.ts";

export const PROJECT_CONFIG_FILE_NAME = "pi-harness.json";
export const USER_CONFIG_DIR_NAME = ".pi-harness";
export const USER_CONFIG_FILE_NAME = "config.json";

export type LayeredHarnessConfig = ResolvedHarnessConfig;

export interface LoadConfigLayersOptions {
	cwd?: string;
	homeDir?: string;
	projectConfigPath?: string;
	userConfigPath?: string;
	cli?: HarnessConfig;
}

type JsonRecord = Record<string, unknown>;

const permissionLevelSchema = Union([Literal("deny"), Literal("ask"), Literal("allow")]);
const thinkingLevelSchema = Union([
	Literal("off"),
	Literal("minimal"),
	Literal("low"),
	Literal("medium"),
	Literal("high"),
	Literal("xhigh"),
]);
const permissionProfileSchema = Union([
	Literal("read-only"),
	Literal("workspace-write"),
	Literal("network"),
]);
const toolSourceSchema = Union([Literal("mcp"), Literal("in-process")]);

const streamOptionsSchema = TypePartial(
	TypeObject(
		{
			timeoutMs: TypeNumber(),
			maxRetries: TypeNumber(),
			maxRetryDelayMs: TypeNumber(),
			headers: TypeRecord(TypeString(), TypeString()),
			metadata: TypeRecord(TypeString(), Unknown()),
			cacheRetention: Unknown(),
		},
		{ additionalProperties: false },
	),
);

const sandboxSchema = TypePartial(
	TypeObject(
		{
			roots: TypeArray(TypeString()),
			maxOutputChars: TypeNumber(),
			bashTimeoutSeconds: TypeNumber(),
			fetchMaxBytes: TypeNumber(),
		},
		{ additionalProperties: false },
	),
);

const policyRuleSchema = TypeObject(
	{
		id: Optional(TypeString()),
		toolName: TypeString(),
		subject: TypeString(),
		level: permissionLevelSchema,
	},
	{ additionalProperties: false },
);

const policySchema = TypePartial(
	TypeObject(
		{
			defaults: TypeRecord(TypeString(), permissionLevelSchema),
			tools: TypeRecord(TypeString(), permissionLevelSchema),
			rules: TypeArray(policyRuleSchema),
		},
		{ additionalProperties: false },
	),
);

const retrySchema = TypePartial(
	TypeObject(
		{
			attempts: TypeNumber(),
			baseDelayMs: TypeNumber(),
			maxDelayMs: TypeNumber(),
		},
		{ additionalProperties: false },
	),
);

const budgetSchema = TypePartial(
	TypeObject(
		{
			maxUsdPerSession: TypeNumber(),
			warnAtUsd: TypeNumber(),
		},
		{ additionalProperties: false },
	),
);

const eventLogSchema = TypePartial(
	TypeObject(
		{
			enabled: TypeBoolean(),
			filePath: TypeString(),
		},
		{ additionalProperties: false },
	),
);

const databaseSchema = TypePartial(
	TypeObject(
		{
			url: TypeString(),
			maxConnections: TypeNumber(),
		},
		{ additionalProperties: false },
	),
);

const schedulerTaskSchema = TypePartial(
	TypeObject(
		{
			id: TypeString(),
			agentProfile: TypeString(),
			taskType: TypeString(),
			schedule: TypeRecord(TypeString(), Unknown()),
			enabled: TypeBoolean(),
		},
		{ additionalProperties: false },
	),
);

const schedulerSchema = TypePartial(
	TypeObject(
		{
			checkIntervalMs: TypeNumber(),
			tasks: TypeArray(schedulerTaskSchema),
		},
		{ additionalProperties: false },
	),
);

const reviewLoopSchema = TypePartial(
	TypeObject(
		{
			enabled: TypeBoolean(),
			maxAttempts: TypeNumber(),
			maxTurns: TypeNumber(),
			reviewerProfile: TypeString(),
			reviewerMaxTurns: TypeNumber(),
			runPolicy: TypeRecord(TypeString(), Unknown()),
		},
		{ additionalProperties: false },
	),
);

const pruningSchema = TypePartial(
	TypeObject(
		{
			enabled: TypeBoolean(),
			minTurnsKept: TypeNumber(),
			maxResultTokens: TypeNumber(),
			expectedFutureTurns: TypeNumber(),
			prewarmAfterPrune: TypeBoolean(),
		},
		{ additionalProperties: false },
	),
);

const agentOverrideSchema = TypePartial(
	TypeObject(
		{
			cwd: TypeString(),
			sessionsRoot: TypeString(),
			provider: TypeString(),
			modelId: TypeString(),
			thinkingLevel: thinkingLevelSchema,
			streamOptions: streamOptionsSchema,
			systemPrompt: TypeString(),
			activeToolNames: TypeArray(TypeString()),
			useDefaultTools: TypeBoolean(),
			toolSource: toolSourceSchema,
			sandbox: sandboxSchema,
			policy: policySchema,
			permissionProfile: permissionProfileSchema,
			runPolicy: TypeRecord(TypeString(), Unknown()),
			contextWindow: TypeNumber(),
			tokenBudgetRatios: TypeRecord(TypeString(), TypeNumber()),
			compaction: TypeRecord(TypeString(), Unknown()),
			pruning: pruningSchema,
			cache: TypeRecord(TypeString(), Unknown()),
			retry: retrySchema,
			budget: budgetSchema,
			eventLog: eventLogSchema,
			database: databaseSchema,
			scheduler: schedulerSchema,
			reviewLoop: reviewLoopSchema,
		},
		{ additionalProperties: false },
	),
);

const configFileSchema = TypePartial(
	TypeObject(
		{
			cwd: TypeString(),
			sessionsRoot: TypeString(),
			agent: TypeString(),
			agents: TypeRecord(TypeString(), agentOverrideSchema),
			provider: TypeString(),
			modelId: TypeString(),
			thinkingLevel: thinkingLevelSchema,
			streamOptions: streamOptionsSchema,
			systemPrompt: TypeString(),
			activeToolNames: TypeArray(TypeString()),
			useDefaultTools: TypeBoolean(),
			toolSource: toolSourceSchema,
			sandbox: sandboxSchema,
			policy: policySchema,
			permissionProfile: permissionProfileSchema,
			runPolicy: TypeRecord(TypeString(), Unknown()),
			contextWindow: TypeNumber(),
			tokenBudgetRatios: TypeRecord(TypeString(), TypeNumber()),
			compaction: TypeRecord(TypeString(), Unknown()),
			pruning: pruningSchema,
			cache: TypeRecord(TypeString(), Unknown()),
			retry: retrySchema,
			budget: budgetSchema,
			eventLog: eventLogSchema,
			database: databaseSchema,
			scheduler: schedulerSchema,
			reviewLoop: reviewLoopSchema,
		},
		{ additionalProperties: false },
	),
);

const topLevelConfigKeys = new Set([
	"cwd",
	"sessionsRoot",
	"agent",
	"agents",
	"provider",
	"modelId",
	"thinkingLevel",
	"streamOptions",
	"systemPrompt",
	"activeToolNames",
	"useDefaultTools",
	"toolSource",
	"sandbox",
	"policy",
	"permissionProfile",
	"runPolicy",
	"contextWindow",
	"tokenBudgetRatios",
	"compaction",
	"pruning",
	"cache",
	"retry",
	"budget",
	"eventLog",
	"database",
	"scheduler",
	"reviewLoop",
]);

const agentOverrideConfigKeys = new Set([...topLevelConfigKeys].filter((key) => key !== "agent" && key !== "agents"));

const nestedConfigKeys = new Map<string, ReadonlySet<string>>([
	["streamOptions", new Set(["timeoutMs", "maxRetries", "maxRetryDelayMs", "headers", "metadata", "cacheRetention"])],
	["sandbox", new Set(["roots", "maxOutputChars", "bashTimeoutSeconds", "fetchMaxBytes"])],
	["policy", new Set(["defaults", "tools", "rules"])],
	["retry", new Set(["attempts", "baseDelayMs", "maxDelayMs"])],
	["budget", new Set(["maxUsdPerSession", "warnAtUsd"])],
	["eventLog", new Set(["enabled", "filePath"])],
	["database", new Set(["url", "maxConnections"])],
	["scheduler", new Set(["checkIntervalMs", "tasks"])],
	["reviewLoop", new Set(["enabled", "maxAttempts", "maxTurns", "reviewerProfile", "reviewerMaxTurns", "runPolicy"])],
	["pruning", new Set(["enabled", "minTurnsKept", "maxResultTokens", "expectedFutureTurns", "prewarmAfterPrune"])],
]);

function isJsonRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}

function toKeyPath(path: readonly string[]): string {
	return path.length > 0 ? path.join(".") : "<root>";
}

function isSensitiveHeaderName(name: string): boolean {
	const normalized = name.toLowerCase();
	return (
		normalized.includes("authorization") ||
		normalized.includes("cookie") ||
		/(^|[-_])api[-_]?key($|[-_])/.test(normalized) ||
		/(^|[-_])token($|[-_])/.test(normalized) ||
		/(^|[-_])secret($|[-_])/.test(normalized) ||
		/(^|[-_])credential($|[-_])/.test(normalized)
	);
}

function findSensitiveStreamHeaderPath(value: JsonRecord, path: readonly string[]): string | undefined {
	const streamOptions = value.streamOptions;
	if (!isJsonRecord(streamOptions) || !isJsonRecord(streamOptions.headers)) return undefined;
	for (const headerName of Object.keys(streamOptions.headers)) {
		if (isSensitiveHeaderName(headerName)) return toKeyPath([...path, "streamOptions", "headers", headerName]);
	}
	return undefined;
}

function findForbiddenSecretPath(value: unknown, path: string[] = []): string | undefined {
	if (Array.isArray(value)) {
		for (let index = 0; index < value.length; index++) {
			const nestedPath = findForbiddenSecretPath(value[index], [...path, String(index)]);
			if (nestedPath) return nestedPath;
		}
		return undefined;
	}
	if (!isJsonRecord(value)) return undefined;
	const streamHeaderPath = findSensitiveStreamHeaderPath(value, path);
	if (streamHeaderPath) return streamHeaderPath;
	for (const [key, nestedValue] of Object.entries(value)) {
		const nextPath = [...path, key];
		if (key === "apiKey" || key === "apiHeaders") return toKeyPath(nextPath);
		const nestedPath = findForbiddenSecretPath(nestedValue, nextPath);
		if (nestedPath) return nestedPath;
	}
	return undefined;
}

function getAllowedKeys(path: readonly string[]): ReadonlySet<string> | undefined {
	if (path.length === 0) return topLevelConfigKeys;
	if (path[0] === "agents") {
		if (path.length === 1) return undefined;
		if (path.length === 2) return agentOverrideConfigKeys;
		return nestedConfigKeys.get(path.slice(2).join("."));
	}
	return nestedConfigKeys.get(toKeyPath(path));
}

function findUnknownKeyPath(value: unknown, path: string[] = []): string | undefined {
	if (!isJsonRecord(value)) return undefined;
	const allowedKeys = getAllowedKeys(path);
	for (const [key, nestedValue] of Object.entries(value)) {
		const nextPath = [...path, key];
		if (allowedKeys && !allowedKeys.has(key)) return toKeyPath(nextPath);
		const nestedPath = findUnknownKeyPath(nestedValue, nextPath);
		if (nestedPath) return nestedPath;
	}
	return undefined;
}

function formatValidationPath(path: string): string {
	if (!path) return "<root>";
	return path
		.split("/")
		.filter(Boolean)
		.join(".");
}

function getValidationPath(error: unknown): string {
	if (!isJsonRecord(error)) return "<root>";
	const instancePath = error.instancePath;
	if (typeof instancePath === "string") return formatValidationPath(instancePath);
	const schemaPath = error.schemaPath;
	if (typeof schemaPath === "string") return schemaPath;
	return "<root>";
}

function getValidationMessage(error: unknown): string {
	if (!isJsonRecord(error)) return "invalid value";
	return typeof error.message === "string" ? error.message : "invalid value";
}

function validateConfig(source: string, value: unknown): asserts value is JsonRecord {
	if (!isJsonRecord(value)) throw new Error(`${source} config must be a JSON object`);
	const forbiddenSecretPath = findForbiddenSecretPath(value);
	if (forbiddenSecretPath) throw new Error(`${source} config contains forbidden key ${forbiddenSecretPath}`);
	const unknownKeyPath = findUnknownKeyPath(value);
	if (unknownKeyPath) throw new Error(`${source} config contains unknown key ${unknownKeyPath}`);
	if (Check(configFileSchema, value)) return;
	const [firstError] = [...Errors(configFileSchema, value)];
	const path = getValidationPath(firstError);
	const message = getValidationMessage(firstError);
	throw new Error(`${source} config invalid at ${path}: ${message}`);
}

async function readConfigFile(filePath: string, source: string): Promise<JsonRecord | undefined> {
	try {
		const content = await readFile(filePath, "utf8");
		const parsed = JSON.parse(content) as unknown;
		validateConfig(source, parsed);
		return parsed;
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") return undefined;
		if (error instanceof SyntaxError) throw new Error(`${source} config contains invalid JSON: ${error.message}`);
		throw error;
	}
}

function mergeJsonRecord(base: JsonRecord, override: JsonRecord): JsonRecord {
	const merged: JsonRecord = { ...base };
	for (const [key, overrideValue] of Object.entries(override)) {
		if (overrideValue === undefined) continue;
		const baseValue = merged[key];
		if (isJsonRecord(baseValue) && isJsonRecord(overrideValue)) {
			merged[key] = mergeJsonRecord(baseValue, overrideValue);
		} else {
			merged[key] = overrideValue;
		}
	}
	return merged;
}

function stripUndefinedValues(record: JsonRecord): JsonRecord {
	const stripped: JsonRecord = {};
	for (const [key, value] of Object.entries(record)) {
		if (value === undefined) continue;
		stripped[key] = isJsonRecord(value) ? stripUndefinedValues(value) : value;
	}
	return stripped;
}

function mergeConfigLayers(layers: Array<JsonRecord | undefined>): JsonRecord {
	let merged: JsonRecord = {};
	for (const layer of layers) {
		if (!layer) continue;
		merged = mergeJsonRecord(merged, layer);
	}
	return merged;
}

export async function loadConfigLayerOverrides(options: LoadConfigLayersOptions = {}): Promise<HarnessConfig> {
	const cwd = options.cwd ?? process.cwd();
	const home = options.homeDir ?? homedir();
	const userConfigPath = options.userConfigPath ?? join(home, USER_CONFIG_DIR_NAME, USER_CONFIG_FILE_NAME);
	const projectConfigPath = options.projectConfigPath ?? join(cwd, PROJECT_CONFIG_FILE_NAME);
	const userConfig = await readConfigFile(userConfigPath, "user");
	const projectConfig = await readConfigFile(projectConfigPath, "project");
	const cliConfig = options.cli ? stripUndefinedValues(options.cli as JsonRecord) : undefined;
	const selectedAgentConfig = mergeConfigLayers([{ cwd }, userConfig, projectConfig, cliConfig]);
	const selectedAgent = selectedAgentConfig.agent;
	const agentOverride =
		typeof selectedAgent === "string" && isJsonRecord(selectedAgentConfig.agents)
			? selectedAgentConfig.agents[selectedAgent]
			: undefined;
	const merged = mergeConfigLayers([
		{ cwd },
		userConfig,
		projectConfig,
		isJsonRecord(agentOverride) ? agentOverride : undefined,
		cliConfig,
	]);
	return merged as HarnessConfig;
}

export async function loadConfigLayers(options: LoadConfigLayersOptions = {}): Promise<LayeredHarnessConfig> {
	const merged = await loadConfigLayerOverrides(options);
	return resolveHarnessConfig(merged as HarnessConfig);
}
