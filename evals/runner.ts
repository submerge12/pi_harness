import { copyFile, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type {
	EvalAssertions,
	EvalExecutionResult,
	EvalExecutor,
	EvalFileAssertion,
	EvalFixture,
	EvalInlineFixture,
	EvalPathFixture,
	EvalRunResult,
	EvalStatus,
	EvalTask,
} from "./types.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(source: Record<string, unknown>, key: string, label: string): string {
	const value = source[key];
	if (typeof value !== "string") throw new Error(`${label}.${key} must be a string`);
	return value;
}

function optionalString(source: Record<string, unknown>, key: string, label: string): string | undefined {
	const value = source[key];
	if (value === undefined) return undefined;
	if (typeof value !== "string") throw new Error(`${label}.${key} must be a string`);
	return value;
}

function optionalNumber(source: Record<string, unknown>, key: string, label: string): number | undefined {
	const value = source[key];
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label}.${key} must be a number`);
	return value;
}

function optionalBoolean(source: Record<string, unknown>, key: string, label: string): boolean | undefined {
	const value = source[key];
	if (value === undefined) return undefined;
	if (typeof value !== "boolean") throw new Error(`${label}.${key} must be a boolean`);
	return value;
}

function optionalStringArray(source: Record<string, unknown>, key: string, label: string): string[] | undefined {
	const value = source[key];
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
		throw new Error(`${label}.${key} must be a string array`);
	}
	return [...value];
}

function parseFixture(value: unknown, label: string): EvalFixture {
	if (typeof value === "string") return { path: value };
	if (!isRecord(value)) throw new Error(`${label}.fixture must be an object or string`);
	if (typeof value.path === "string") return { path: value.path };
	if (!isRecord(value.files)) throw new Error(`${label}.fixture must define path or files`);
	const files: Record<string, string> = {};
	for (const [filePath, contents] of Object.entries(value.files)) {
		if (typeof contents !== "string") throw new Error(`${label}.fixture.files.${filePath} must be a string`);
		files[filePath] = contents;
	}
	return { files };
}

function parseFileAssertion(value: unknown, label: string): EvalFileAssertion {
	if (!isRecord(value)) throw new Error(`${label} must be an object`);
	const assertion: EvalFileAssertion = { path: requireString(value, "path", label) };
	const exists = optionalBoolean(value, "exists", label);
	const equals = optionalString(value, "equals", label);
	const contains = optionalString(value, "contains", label);
	const matches = optionalString(value, "matches", label);
	if (exists !== undefined) assertion.exists = exists;
	if (equals !== undefined) assertion.equals = equals;
	if (contains !== undefined) assertion.contains = contains;
	if (matches !== undefined) assertion.matches = matches;
	return assertion;
}

function parseFiles(value: unknown, label: string): EvalFileAssertion[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) throw new Error(`${label}.files must be an array`);
	return value.map((entry, index) => parseFileAssertion(entry, `${label}.files[${index}]`));
}

function parseOutputMatch(value: unknown, label: string): string | string[] | undefined {
	if (value === undefined) return undefined;
	if (typeof value === "string") return value;
	if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
		throw new Error(`${label}.outputMatch must be a string or string array`);
	}
	return [...value];
}

function parseAssertions(value: unknown, label: string): EvalAssertions {
	if (!isRecord(value)) throw new Error(`${label}.assertions must be an object`);
	const assertions: EvalAssertions = {};
	const files = parseFiles(value.files, `${label}.assertions`);
	const outputMatch = parseOutputMatch(value.outputMatch, `${label}.assertions`);
	const forbiddenTools = optionalStringArray(value, "forbiddenTools", `${label}.assertions`);
	const allowedWriteRoots = optionalStringArray(value, "allowedWriteRoots", `${label}.assertions`);
	const maxTurns = optionalNumber(value, "maxTurns", `${label}.assertions`);
	const maxUsd = optionalNumber(value, "maxUsd", `${label}.assertions`);
	if (files !== undefined) assertions.files = files;
	if (outputMatch !== undefined) assertions.outputMatch = outputMatch;
	if (forbiddenTools !== undefined) assertions.forbiddenTools = forbiddenTools;
	if (allowedWriteRoots !== undefined) assertions.allowedWriteRoots = allowedWriteRoots;
	if (maxTurns !== undefined) assertions.maxTurns = maxTurns;
	if (maxUsd !== undefined) assertions.maxUsd = maxUsd;
	return assertions;
}

export function parseEvalTask(value: unknown, label = "task"): EvalTask {
	if (!isRecord(value)) throw new Error(`${label} must be an object`);
	const task: EvalTask = {
		prompt: requireString(value, "prompt", label),
		fixture: parseFixture(value.fixture, label),
		assertions: parseAssertions(value.assertions, label),
	};
	const name = optionalString(value, "name", label);
	if (name !== undefined) task.name = name;
	return task;
}

export async function loadEvalTask(taskPath: string): Promise<EvalTask> {
	const parsed: unknown = JSON.parse(await readFile(taskPath, "utf8"));
	return parseEvalTask(parsed, taskPath);
}

function resolveInside(root: string, relativePath: string): string {
	const resolvedRoot = path.resolve(root);
	const resolved = path.resolve(resolvedRoot, relativePath);
	const relative = path.relative(resolvedRoot, resolved);
	if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) return resolved;
	throw new Error(`path escapes workspace: ${relativePath}`);
}

async function copyDirectory(source: string, destination: string): Promise<void> {
	await mkdir(destination, { recursive: true });
	const entries = await readdir(source, { withFileTypes: true });
	for (const entry of entries) {
		const from = path.join(source, entry.name);
		const to = path.join(destination, entry.name);
		if (entry.isDirectory()) await copyDirectory(from, to);
		if (entry.isFile()) await copyFile(from, to);
	}
}

function fixturePath(fixture: EvalFixture): string | undefined {
	if (typeof fixture === "string") return fixture;
	return "path" in fixture ? fixture.path : undefined;
}

function fixtureFiles(fixture: EvalFixture): Record<string, string> | undefined {
	if (typeof fixture === "string") return undefined;
	return "files" in fixture ? fixture.files : undefined;
}

async function writeInlineFixture(fixture: EvalInlineFixture, sourcePath: string): Promise<void> {
	await mkdir(sourcePath, { recursive: true });
	for (const [filePath, contents] of Object.entries(fixture.files)) {
		const targetPath = resolveInside(sourcePath, filePath);
		await mkdir(path.dirname(targetPath), { recursive: true });
		await writeFile(targetPath, contents, "utf8");
	}
}

async function prepareFixtureSource(task: EvalTask, taskPath: string, runRoot: string): Promise<string> {
	const inlineFiles = fixtureFiles(task.fixture);
	if (inlineFiles !== undefined) {
		const sourcePath = path.join(runRoot, "fixture");
		await writeInlineFixture({ files: inlineFiles }, sourcePath);
		return sourcePath;
	}
	const sourcePath = fixturePath(task.fixture);
	if (sourcePath === undefined) throw new Error("fixture must define path or files");
	if (path.isAbsolute(sourcePath)) throw new Error(`fixture path must be relative: ${sourcePath}`);
	return resolveInside(path.dirname(taskPath), sourcePath);
}

async function prepareWorkspace(task: EvalTask, taskPath: string): Promise<string> {
	const runRoot = await mkdtemp(path.join(tmpdir(), "pi-eval-"));
	const fixtureSource = await prepareFixtureSource(task, taskPath, runRoot);
	const workspacePath = path.join(runRoot, "workspace");
	await copyDirectory(fixtureSource, workspacePath);
	return workspacePath;
}

function normalizeToolCalls(execution: EvalExecutionResult): { name: string }[] {
	return execution.toolCalls?.map((toolCall) => ({ name: toolCall.name })) ?? [];
}

function outputPatterns(assertions: EvalAssertions): string[] {
	if (assertions.outputMatch === undefined) return [];
	return Array.isArray(assertions.outputMatch) ? assertions.outputMatch : [assertions.outputMatch];
}

function checkOutput(output: string, assertions: EvalAssertions): string[] {
	const failures: string[] = [];
	for (const pattern of outputPatterns(assertions)) {
		if (!new RegExp(pattern, "m").test(output)) failures.push(`output did not match pattern: ${pattern}`);
	}
	return failures;
}

function checkForbiddenTools(execution: EvalExecutionResult, assertions: EvalAssertions): string[] {
	const forbiddenTools = assertions.forbiddenTools ?? [];
	const usedTools = new Set(normalizeToolCalls(execution).map((toolCall) => toolCall.name));
	return forbiddenTools.filter((toolName) => usedTools.has(toolName)).map((toolName) => `forbidden tool used: ${toolName}`);
}

function formatUsd(value: number): string {
	return `$${value.toFixed(4)}`;
}

function checkLimits(execution: EvalExecutionResult, assertions: EvalAssertions): string[] {
	const failures: string[] = [];
	const turns = execution.turns;
	const costUsd = execution.costUsd;
	if (assertions.maxTurns !== undefined && turns === undefined) failures.push("turns metric missing for maxTurns assertion");
	if (assertions.maxUsd !== undefined && costUsd === undefined) failures.push("costUsd metric missing for maxUsd assertion");
	if (assertions.maxTurns !== undefined && turns !== undefined && turns > assertions.maxTurns) {
		failures.push(`turns ${turns} exceeded maxTurns ${assertions.maxTurns}`);
	}
	if (assertions.maxUsd !== undefined && costUsd !== undefined && costUsd > assertions.maxUsd) {
		failures.push(`cost ${formatUsd(costUsd)} exceeded maxUsd ${formatUsd(assertions.maxUsd)}`);
	}
	return failures;
}

function toolCallPath(toolCall: { input?: Record<string, unknown> }): string | undefined {
	const value = toolCall.input?.path;
	return typeof value === "string" ? value : undefined;
}

function normalizeRelativeEvalPath(value: string): string | undefined {
	if (/^[A-Za-z]:/.test(value)) return undefined;
	const normalized = path.posix.normalize(value.replace(/\\/g, "/"));
	if (normalized === "." || normalized === ".." || normalized.startsWith("../") || path.posix.isAbsolute(normalized)) {
		return undefined;
	}
	return normalized;
}

function isAllowedWritePath(filePath: string, allowedRoots: readonly string[]): boolean {
	const normalizedPath = normalizeRelativeEvalPath(filePath);
	if (!normalizedPath) return false;
	for (const root of allowedRoots) {
		const normalizedRoot = normalizeRelativeEvalPath(root);
		if (!normalizedRoot) continue;
		if (normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}/`)) return true;
	}
	return false;
}

function checkAllowedWriteRoots(execution: EvalExecutionResult, assertions: EvalAssertions): string[] {
	const allowedRoots = assertions.allowedWriteRoots ?? [];
	if (allowedRoots.length === 0) return [];
	const failures: string[] = [];
	for (const toolCall of execution.toolCalls ?? []) {
		if (toolCall.name !== "write" && toolCall.name !== "edit") continue;
		const filePath = toolCallPath(toolCall);
		if (!filePath) {
			failures.push(`${toolCall.name} tool missing path input`);
			continue;
		}
		if (!isAllowedWritePath(filePath, allowedRoots)) {
			failures.push(`${toolCall.name} path outside allowed roots: ${filePath}`);
		}
	}
	return failures;
}

async function readFileForAssertion(workspacePath: string, assertion: EvalFileAssertion): Promise<string | undefined> {
	try {
		return await readFile(resolveInside(workspacePath, assertion.path), "utf8");
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
		throw error;
	}
}

function checkFileContents(assertion: EvalFileAssertion, contents: string): string[] {
	const failures: string[] = [];
	if (assertion.equals !== undefined && contents !== assertion.equals) failures.push(`file mismatch: ${assertion.path}`);
	if (assertion.contains !== undefined && !contents.includes(assertion.contains)) {
		failures.push(`file missing expected content: ${assertion.path}`);
	}
	if (assertion.matches !== undefined && !new RegExp(assertion.matches, "m").test(contents)) {
		failures.push(`file did not match pattern: ${assertion.path}`);
	}
	return failures;
}

async function checkFileAssertion(workspacePath: string, assertion: EvalFileAssertion): Promise<string[]> {
	const contents = await readFileForAssertion(workspacePath, assertion);
	if (assertion.exists === false) return contents === undefined ? [] : [`file should not exist: ${assertion.path}`];
	if (contents === undefined) return [`file missing: ${assertion.path}`];
	return checkFileContents(assertion, contents);
}

async function checkFiles(workspacePath: string, assertions: EvalAssertions): Promise<string[]> {
	const failures: string[] = [];
	for (const assertion of assertions.files ?? []) {
		failures.push(...(await checkFileAssertion(workspacePath, assertion)));
	}
	return failures;
}

async function collectFailures(task: EvalTask, execution: EvalExecutionResult, workspacePath: string): Promise<string[]> {
	return [
		...checkOutput(execution.output, task.assertions),
		...checkForbiddenTools(execution, task.assertions),
		...checkLimits(execution, task.assertions),
		...checkAllowedWriteRoots(execution, task.assertions),
		...(await checkFiles(workspacePath, task.assertions)),
	];
}

function formatPercent(value: number): string {
	return `${(value * 100).toFixed(2)}%`;
}

function renderMarkdown(task: EvalTask, result: Omit<EvalRunResult, "markdown" | "task">): string {
	const lines = [
		`# Eval: ${task.name ?? path.basename(result.taskPath)}`,
		`Status: ${result.status === "passed" ? "pass" : "fail"}`,
		`Cost: ${formatUsd(result.costUsd)}`,
		`Turns: ${result.turns}`,
	];
	if (result.cacheHitRate !== undefined) lines.push(`Cache hit rate: ${formatPercent(result.cacheHitRate)}`);
	if (result.failures.length === 0) return [...lines, "Failures: none"].join("\n");
	return [...lines, "Failures:", ...result.failures.map((failure) => `- ${failure}`)].join("\n");
}

function buildResult(task: EvalTask, taskPath: string, workspacePath: string, execution: EvalExecutionResult, failures: string[]): EvalRunResult {
	const status: EvalStatus = failures.length === 0 ? "passed" : "failed";
	const result: EvalRunResult = {
		task,
		taskPath,
		workspacePath,
		status,
		failures,
		output: execution.output,
		toolCalls: normalizeToolCalls(execution),
		turns: execution.turns ?? 0,
		costUsd: execution.costUsd ?? 0,
		markdown: "",
	};
	if (execution.cacheHitRate !== undefined) result.cacheHitRate = execution.cacheHitRate;
	result.markdown = renderMarkdown(task, result);
	return result;
}

export async function runEvalTask(taskPath: string, executor: EvalExecutor): Promise<EvalRunResult> {
	const task = await loadEvalTask(taskPath);
	const workspacePath = await prepareWorkspace(task, taskPath);
	const execution = await executor({ task, taskPath, workspacePath, prompt: task.prompt });
	const failures = await collectFailures(task, execution, workspacePath);
	return buildResult(task, taskPath, workspacePath, execution, failures);
}
