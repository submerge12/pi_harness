import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createDbPool } from "../../src/db/index.ts";

const runWithDatabase = process.env.DATABASE_URL ? it : it.skip;

describe("database connection", () => {
	runWithDatabase("creates a shared drizzle/postgres pool and closes it", async () => {
		const dbPool = createDbPool({ connectionString: process.env.DATABASE_URL!, maxConnections: 1 });

		try {
			const result = await dbPool.db.execute(sql`select 1 as ok`);
			expect(result.rows[0]).toMatchObject({ ok: 1 });
		} finally {
			await dbPool.close();
		}
	});
});
