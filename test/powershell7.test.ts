import { describe, expect, it } from "vitest";
import { createPowerShell7ExecutionEnv } from "../src/execution/powershell7.ts";
import { createJsonlSession } from "../src/session/factory.ts";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe.skipIf(process.platform !== "win32")("strict PowerShell 7 in the actual Pi execution environment", () => {
	it("resolves Get-Command pwsh.exe and executes PowerShell 7 with streamed output", async () => {
		const env = await createPowerShell7ExecutionEnv({ cwd: process.cwd() });
		const chunks: string[] = [];
		const result = await env.exec("$PSVersionTable.PSVersion.Major; Write-Output 'pwsh-ready'", { onStdout: (chunk) => chunks.push(chunk) });
		expect(result.ok).toBe(true);
		if (!result.ok) throw result.error;
		expect(Number(result.value.stdout.trim().split(/\r?\n/)[0])).toBeGreaterThanOrEqual(7);
		expect(result.value.stdout).toContain("pwsh-ready");
		expect(chunks.join("")).toBe(result.value.stdout);
		await env.cleanup();
	});
	it("fails closed if the executable is missing, without launching a fallback", async () => {
		await expect(createPowerShell7ExecutionEnv({ cwd: process.cwd(), shellPath: "C:/pi-harness-nonexistent-shell/pwsh.exe" })).rejects.toThrow("no fallback");
	});
	it("rejects Windows PowerShell before executing it", async () => {
		await expect(createPowerShell7ExecutionEnv({ cwd: process.cwd(), shellPath: "C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe" })).rejects.toThrow("not allowed");
	});
	it("preserves native failure exit codes", async () => {
		const env = await createPowerShell7ExecutionEnv({ cwd: process.cwd() });
		const result = await env.exec("exit 7");
		expect(result.ok && result.value.exitCode).toBe(7);
	});
	it("propagates cancellation and timeout", async () => {
		const env = await createPowerShell7ExecutionEnv({ cwd: process.cwd() });
		const cancelled = await env.exec("Write-Output 'must not execute'", { abortSignal: AbortSignal.abort() });
		expect(!cancelled.ok && cancelled.error.code).toBe("aborted");
		const timed = await env.exec("Start-Sleep -Seconds 20", { timeout: 0.1 });
		expect(!timed.ok && timed.error.code).toBe("timeout");
	});
	it("connects through the session factory", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-pwsh7-session-"));
		const { env } = await createJsonlSession({ cwd, sessionsRoot: ".sessions", shellMode: "powershell7" });
		const result = await env.exec("Write-Output $PSVersionTable.PSEdition");
		expect(result.ok && result.value.stdout.trim()).toBe("Core");
		await env.cleanup();
	});
});
