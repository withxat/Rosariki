import { xat } from '@withxat/eslint-config'

export default xat({
	ignores: [
		'drizzle/**',
		'drizzle.config.ts',
		'scripts/**',
	],
})
