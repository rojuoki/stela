import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { IO_SCHEMA_ALTER_SQL, IO_SCHEMA_SQL } from "./schema";

let database: DatabaseSync | null = null;

export function ioDatabasePath(): string {
  return path.resolve(
    process.env.STELA_IO_DATABASE_PATH || "./data/stela-io.sqlite",
  );
}

export function getIoDatabase(): DatabaseSync {
  if (database) return database;
  const dbPath = ioDatabasePath();
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  database = new DatabaseSync(dbPath);
  database.exec("PRAGMA journal_mode = WAL");
  database.exec("PRAGMA foreign_keys = ON");
  database.exec("PRAGMA busy_timeout = 5000");
  database.exec(IO_SCHEMA_SQL);
  for (const statement of IO_SCHEMA_ALTER_SQL) {
    try {
      database.exec(statement);
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("duplicate column name")) {
        throw error;
      }
    }
  }
  return database;
}

export function initializeIoDatabase(): string {
  getIoDatabase();
  return ioDatabasePath();
}
