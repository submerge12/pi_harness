import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const agentNamePattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = dirname(dirname(scriptPath));
const templateDir = join(repoRoot, "src", "agents", "profiles", "_template");
const profilesRoot = join(repoRoot, "src", "agents", "profiles");

function usage() {
	console.error("Usage: npm run new-agent -- <name>");
	console.error("Agent names must use lowercase letters, numbers, and hyphens, and start with a letter.");
}

function formatTitle(name) {
	return name
		.split("-")
		.map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
		.join(" ");
}

function replacePlaceholders(directory, name) {
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const entryPath = join(directory, entry.name);
		if (entry.isDirectory()) {
			replacePlaceholders(entryPath, name);
			continue;
		}

		if (!entry.isFile()) {
			continue;
		}

		const content = readFileSync(entryPath, "utf8")
			.replaceAll("__AGENT_NAME__", name)
			.replaceAll("__AGENT_TITLE__", formatTitle(name));
		writeFileSync(entryPath, content);
	}
}

function formatIdentifier(name) {
	const [first = "", ...rest] = name.split("-");
	return `${first}${rest.map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`).join("")}Profile`;
}

function insertBeforeMarker(content, marker, insertion) {
	if (content.includes(insertion)) {
		return content;
	}
	if (!content.includes(marker)) {
		throw new Error(`Registration marker not found: ${marker}`);
	}
	return content.replace(marker, `${insertion}\n${marker}`);
}

function registerAgentProfile(name) {
	const indexPath = join(profilesRoot, "index.ts");
	const variableName = formatIdentifier(name);
	const importLine = `import ${variableName} from "./${name}/profile.ts";`;
	const listLine = `\t${variableName},`;
	const exportLine = `export { default as ${variableName} } from "./${name}/profile.ts";`;
	let content = readFileSync(indexPath, "utf8");
	content = insertBeforeMarker(content, "// <agent-profile-imports>", importLine);
	content = insertBeforeMarker(content, "\t// <agent-profile-list>", listLine);
	content = insertBeforeMarker(content, "// <agent-profile-exports>", exportLine);
	writeFileSync(indexPath, content);
}

function createAgent(name) {
	if (!existsSync(templateDir) || !statSync(templateDir).isDirectory()) {
		throw new Error(`Template directory not found: ${relative(repoRoot, templateDir)}`);
	}

	const destinationDir = join(profilesRoot, name);
	if (existsSync(destinationDir)) {
		throw new Error(`Agent profile already exists: ${relative(repoRoot, destinationDir)}`);
	}

	mkdirSync(profilesRoot, { recursive: true });
	cpSync(templateDir, destinationDir, {
		errorOnExist: true,
		force: false,
		recursive: true,
	});
	replacePlaceholders(destinationDir, name);
	registerAgentProfile(name);

	return destinationDir;
}

const requestedName = process.argv[2];

if (process.argv.length !== 3 || requestedName === "--help" || requestedName === "-h") {
	usage();
	process.exitCode = requestedName ? 0 : 1;
} else if (!agentNamePattern.test(requestedName)) {
	usage();
	process.exitCode = 1;
} else {
	try {
		const createdDir = createAgent(requestedName);
		const relativeDir = relative(repoRoot, createdDir);
		console.log(`Created ${relativeDir}`);
		console.log("");
		console.log("Next steps:");
		console.log(`1. Edit ${relativeDir}/profile.ts and ${relativeDir}/prompt.ts.`);
		console.log("2. Write the design notes from docs/agent-design-guide.md.");
		console.log("3. Add golden tasks before expanding the profile implementation.");
		console.log("4. Run tests for the generated profile and registry listing.");
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
