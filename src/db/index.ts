import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';

import * as schema from './schema.js';

const dbPath = process.env.PRD_DB_PATH || './prd.db';
const sqlite = new Database(dbPath);

sqlite.pragma('journal_mode = WAL');
sqlite.pragma('foreign_keys = ON');

export const db = drizzle(sqlite, { schema });

export { schema };
export * from './schema.js';

export function closeDb() {
  sqlite.close();
}