#!/usr/bin/env node --experimental-strip-types
// Opt-in live conformance run against a real model (paid API calls).
// Usage: node --env-file=.env --experimental-strip-types scripts/run-conformance.ts --live [profileId]
// CI never runs this; vitest coverage uses mocked clients only.
import process from "node:process";
import { createLiveConformanceClient, runConformanceSuite } from "../src/conformance/index.ts";
import { DEFAULT_MODEL_PROFILE, getModelProfile } from "../src/model-profiles/index.ts";
import { getProviderApiKeyEnvVarName } from "../src/resilience/errors.ts";

const args = process.argv.slice(2);
const live = args.includes("--live");
const profileId = args.find((arg) => !arg.startsWith("--"));

if (!live) {
	console.error("Refusing to run: pass --live to explicitly opt in to paid API calls.");
	process.exit(2);
}

const profile = profileId ? getModelProfile(profileId) : DEFAULT_MODEL_PROFILE;
const envVarName = getProviderApiKeyEnvVarName(profile.provider);
const apiKey = process.env[envVarName];
if (!apiKey) {
	console.error(`Missing ${envVarName} in the environment.`);
	process.exit(2);
}

const report = await runConformanceSuite({
	profile,
	client: createLiveConformanceClient({ apiKey }),
});

console.log(JSON.stringify(report, null, "\t"));
console.error(
	`profile=${report.profileId} passed=${report.summary.passed}/${report.summary.total} probes=${report.probesPassed ? "PASS" : "FAIL"} eligible=${report.eligible}`,
);
process.exit(report.eligible ? 0 : 1);
