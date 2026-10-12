import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';

import * as schema from './schema.js';

const dbUrl = process.env.PRD_DB_URL || 'file:./prd.db';
const client = createClient({ url: dbUrl });

export const db = drizzle(client, { schema });

export { schema };
export * from './schema.js';

export function closeDb() {
  client.close();
}