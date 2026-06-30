import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { planPackageSchema } from "../src/contract/schemas/plan-package.ts";
import {
	domainHandoffPackageSchema,
	memoryCandidateSchema,
	planAmendmentSchema,
} from "../src/contract/schemas/runtime-contracts.ts";
import { taskContractSchema } from "../src/contract/schemas/task-contract.ts";
import { userMemoryRecordSchema } from "../src/memory/schemas/user-memory.ts";
import { reviewVerdictSchema } from "../src/review/verdict.ts";
import { normalizedResultSchema } from "../src/runtime/index.ts";
import { skillCardSchema } from "../src/skills/schemas/skill-card.ts";
import { traceEventSchema } from "../src/trace/index.ts";

const outputDir = process.argv[2] ?? process.env.PI_SCHEMA_OUTPUT_DIR ?? join(process.cwd(), "schemas");

await mkdir(outputDir, { recursive: true });
await writeSchema("task-contract.schema.json", taskContractSchema);
await writeSchema("plan-package.schema.json", planPackageSchema);
await writeSchema("normalized-result.schema.json", normalizedResultSchema);
await writeSchema("skill-card.schema.json", skillCardSchema);
await writeSchema("user-memory.schema.json", userMemoryRecordSchema);
await writeSchema("trace-event.schema.json", traceEventSchema);
await writeSchema("memory-candidate.schema.json", memoryCandidateSchema);
await writeSchema("plan-amendment.schema.json", planAmendmentSchema);
await writeSchema("domain-handoff-package.schema.json", domainHandoffPackageSchema);
await writeSchema("review-verdict.schema.json", reviewVerdictSchema);

async function writeSchema(fileName, schema) {
	await writeFile(join(outputDir, fileName), `${JSON.stringify(schema, null, "\t")}\n`, "utf8");
}
