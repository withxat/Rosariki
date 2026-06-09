import { defineConfig } from 'drizzle-kit'

export default defineConfig({
	dbCredentials: {
		url: process.env.DB_PATH || './data/cahciua.db',
	},
	dialect: 'sqlite',
	out: './drizzle',
	schema: './src/db/schema.ts',
})
