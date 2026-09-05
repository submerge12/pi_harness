import { execFile } from "node:child_process";
import { basename, isAbsolute, normalize } from "node:path";
import { promisify } from "node:util";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";

const execFileAsync = promisify(execFile);

/** Resolve and verify the executable before constructing an environment; no fallback shell. */
export async function createPowerShell7ExecutionEnv(options: {
	cwd: string;
	shellPath?: string;
	shellEnv?: NodeJS.ProcessEnv;
}): Promise<NodeExecutionEnv> {
	if (process.platform !== "win32") throw new Error("PowerShell 7 Windows execution requires Windows");
	const candidate = options.shellPath ?? "pwsh.exe";
	if (basename(candidate).toLowerCase() !== "pwsh.exe") {
		throw new Error("PowerShell 7 requires pwsh.exe; Windows PowerShell is not allowed");
	}
	let resolved: { source: string; executable: string; major: number };
	try {
		const result = await execFileAsync(candidate, ["-NoProfile", "-NonInteractive", "-Command", [
			"$ErrorActionPreference = 'Stop'",
			"[pscustomobject]@{ source = (Get-Command -Name ([Environment]::ProcessPath) -CommandType Application).Source; executable = [Environment]::ProcessPath; major = $PSVersionTable.PSVersion.Major } | ConvertTo-Json -Compress",
		].join("; ")], {
			cwd: options.cwd, env: { ...process.env, ...options.shellEnv },
			windowsHide: true, timeout: 10_000, encoding: "utf8", maxBuffer: 8192,
		});
		resolved = JSON.parse(result.stdout.trim());
		if (typeof resolved.major !== "number" || resolved.major < 7
			|| typeof resolved.source !== "string" || !isAbsolute(resolved.source)
			|| basename(resolved.source).toLowerCase() !== "pwsh.exe"
			|| typeof resolved.executable !== "string"
			|| normalize(resolved.source).toLowerCase() !== normalize(resolved.executable).toLowerCase()) {
			throw new Error("PowerShell resolution or version mismatch");
		}
	} catch {
		throw new Error("PowerShell 7 could not be resolved and verified. Install pwsh.exe or supply its path; no fallback was started.");
	}
	// Pi 0.76 accepts custom shell paths and invokes them with -c, supported by pwsh.
	// Reuse its output streaming, timeout, AbortSignal and Windows process-tree handling.
	return new NodeExecutionEnv({ ...options, shellPath: resolved.source });
}
