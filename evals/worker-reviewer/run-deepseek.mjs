import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { codingProfile, createAgent } from "../../src/index.ts";
import { runEvalTask } from "../runner.ts";

const apiKey = process.env.DEEPSEEK_API_KEY;
const tasksDir = join(dirname(fileURLToPath(import.meta.url)), "tasks");

if (!apiKey) {
	console.log("SKIP worker-reviewer eval: DEEPSEEK_API_KEY is not set.");
	process.exit(0);
}

const taskFiles = (await readdir(tasksDir))
	.filter((fileName) => fileName.endsWith(".json"))
	.sort()
	.map((fileName) => join(tasksDir, fileName));

let failures = 0;
for (const taskPath of taskFiles) {
	const result = await runEvalTask(taskPath, async ({ workspacePath, prompt, taskPath }) => {
		const toolCalls = [];
		const blockedToolCalls = [];
		const pendingToolCalls = new Map();
		const harness = await createAgent(codingProfile, {
			cwd: workspacePath,
			apiKey,
			getActiveLease: () => ({ writeScope: ["src"] }),
			permissionProfile: "workspace-write",
			policy: {
				defaults: {
					"read-only": "allow",
					write: "allow",
					destructive: "allow",
					network: "deny",
				},
			},
			reviewLoop: {
				enabled: true,
				runPolicy: {
					budget: { maxTurns: 12, maxUsd: 0.5 },
					repairLimits: { maxAttempts: 3 },
				},
			},
			sandbox: { roots: [workspacePath] },
		});
		const unsubscribe = harness.subscribe((event) => {
			if (event.type === "tool_execution_start") {
				pendingToolCalls.set(event.toolCallId, {
					name: event.toolName,
					input: normalizedToolInput(event.args),
				});
				return;
			}
			if (event.type !== "tool_execution_end") return;
			const toolCall = pendingToolCalls.get(event.toolCallId);
			if (!toolCall) return;
			pendingToolCalls.delete(event.toolCallId);
			if (event.isError) {
				blockedToolCalls.push(toolCall);
				return;
			}
			toolCalls.push(toolCall);
		});
		try {
			const taskName = safeTaskId(contextName(taskPath));
			const result = await harness.runRequest({
				taskContract: taskContractFor(taskName, prompt),
			});
			const costSummary = harness.getCostSummary();
			const message = result.entryStage === "execute"
				? result.message
				: { content: [{ type: "text", text: result.clarification }] };
			return {
				output: evalOutput(result, assistantText(message), blockedToolCalls),
				toolCalls,
				turns: costSummary.turnCount,
				costUsd: costSummary.usage.cost.total,
				cacheHitRate: costSummary.cacheHitRate,
			};
		} finally {
			unsubscribe();
			await harness.dispose();
		}
	});
	console.log(result.markdown);
	console.log("");
	if (result.status !== "passed") failures += 1;
}

if (failures > 0) process.exit(1);

function taskContractFor(taskName, prompt) {
	if (taskName.includes("seeded-fail-escalates")) {
		return {
			id: taskName,
			goal: prompt,
			rawRequest: prompt,
			hardConstraints: [
				{ kind: "acceptance", value: "reviewer rejects a false completion claim", source: "eval" },
				{ kind: "acceptance", value: "human review escalation is reported", source: "eval" },
			],
			assignedSkill: "coding",
			writeScope: ["src"],
			allowedTools: ["read", "bash"],
			gateTier: "G2",
		};
	}
	return {
		id: taskName,
		goal: prompt,
		rawRequest: prompt,
		hardConstraints: [
			{ kind: "acceptance", value: "src/result.js contains ok", source: "eval" },
			{ kind: "acceptance", value: "verification command is reported", source: "eval" },
		],
		assignedSkill: "coding",
		writeScope: ["src"],
		allowedTools: ["read", "write", "edit", "bash"],
		gateTier: "G2",
	};
}

function evalOutput(result, messageText, blockedToolCalls = []) {
	const lines = [`entryStage=${result.entryStage}`];
	if (result.entryStage === "execute") {
		const finalVerdict = lastReviewVerdict(result.reviewVerdicts);
		lines.push(`loopState=${result.loopState ?? "none"}`);
		lines.push(`finalReviewVerdict=${finalVerdict?.verdict ?? "none"}`);
		lines.push(`reviewVerdictCount=${result.reviewVerdicts?.length ?? 0}`);
		lines.push(`completionGateFailureCount=${result.completionGateFailures?.length ?? 0}`);
		lines.push(`evidenceRefs=${result.evidenceRefs?.join(",") ?? ""}`);
		if (result.completionGateFailures?.length) {
			lines.push(`completionGateFailures=${result.completionGateFailures.map((failure) => failure.reason).join(" | ")}`);
		}
		if (finalVerdict) {
			lines.push(`finalReviewPhase=${finalVerdict.phase}`);
			lines.push(`finalReviewFindings=${finalVerdict.findings.map((finding) => finding.claim).join(" | ")}`);
		}
	}
	if (blockedToolCalls.length) {
		lines.push(`blockedToolAttempts=${blockedToolCalls.map(toolCallLabel).join(",")}`);
	}
	lines.push("");
	lines.push("message:");
	lines.push(messageText);
	return lines.join("\n");
}

function normalizedToolInput(args) {
	return args && typeof args === "object" && !Array.isArray(args) ? { ...args } : {};
}

function toolCallLabel(toolCall) {
	const path = typeof toolCall.input.path === "string" ? `:${toolCall.input.path}` : "";
	return `${toolCall.name}${path}`;
}

function lastReviewVerdict(verdicts) {
	if (!Array.isArray(verdicts) || verdicts.length === 0) return undefined;
	return verdicts.at(-1);
}

function assistantText(message) {
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			if (!part || typeof part !== "object") return "";
			if (!("type" in part) || part.type !== "text") return "";
			return "text" in part && typeof part.text === "string" ? part.text : "";
		})
		.join("");
}

function contextName(taskPath) {
	return taskPath.replace(/\\/g, "/").split("/").slice(-2).join("/");
}

function safeTaskId(value) {
	return value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "worker-reviewer-eval";
}
