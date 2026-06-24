import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema.ts";

export interface CreateDbPoolOptions {
	connectionString: string;
	maxConnections?: number;
}

export type AppDatabase = NodePgDatabase<typeof schema>;

export interface DbPool {
	db: AppDatabase;
	pool: Pool;
	close(): Promise<void>;
}

export function createDbPool(options: CreateDbPoolOptions): DbPool {
	if (!options.connectionString) throw new Error("connectionString is required");
	const pool = new Pool({
		connectionString: options.connectionString,
		max: options.maxConnections,
	});
	const db = drizzle(pool, { schema });
	return {
		db,
		pool,
		close: async () => {
			await pool.end();
		},
	};
}
