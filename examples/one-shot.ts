import { spawn } from "node:child_process";
import { once } from "node:events";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const prompt = process.argv.slice(2).join(" ") || "Say exactly: ok";
const cliEntry = join(repoRoot, "src", "cli", "index.ts");
const child = spawn(
	process.execPath,
	["--experimental-strip-types", cliEntry, "-p", prompt],
	{
		cwd: repoRoot,
		env: process.env,
		stdio: "inherit",
	},
);

const [code] = (await once(child, "exit")) as [number | null, NodeJS.Signals | null];
process.exitCode = code ?? 1;
