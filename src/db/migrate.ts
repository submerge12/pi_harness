import type { AppDatabase } from "./connection.ts";

export interface DbMigration {
	name: string;
	up(db: AppDatabase): Promise<void> | void;
}

export type DbMigrationFunction = (db: AppDatabase) => Promise<void> | void;
export type ProgrammaticMigration = DbMigration | DbMigrationFunction;

function getMigrationName(migration: ProgrammaticMigration): string {
	return typeof migration === "function" ? migration.name : migration.name;
}

async function runMigration(db: AppDatabase, migration: ProgrammaticMigration): Promise<void> {
	if (typeof migration === "function") {
		await migration(db);
		return;
	}
	await migration.up(db);
}

export async function runMigrations(db: AppDatabase, migrations: readonly ProgrammaticMigration[]): Promise<void> {
	const seen = new Set<string>();
	for (const migration of migrations) {
		const name = getMigrationName(migration);
		if (!name) throw new Error("Migration name is required");
		if (seen.has(name)) throw new Error(`Duplicate migration ${name}`);
		seen.add(name);
		await runMigration(db, migration);
	}
}
