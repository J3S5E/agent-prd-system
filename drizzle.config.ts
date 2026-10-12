import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './src/db/migrations',
  dialect: 'sqlite',
  dbCredentials: {
    url: process.env.PRD_DB_URL || 'file:./prd.db'
  },
  verbose: true,
  strict: true
});