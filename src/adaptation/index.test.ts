import { describe, expect, it } from 'vitest'

import { contentToPlainText } from './index'

describe('contentToPlainText', () => {
	it('flattens nested content nodes', () => {
		expect(contentToPlainText([{ text: 'hello', type: 'text' }])).toBe('hello')
		expect(contentToPlainText([
			{ children: [{ text: 'hi', type: 'text' }], type: 'bold' },
			{ text: ' there', type: 'text' },
		])).toBe('hi there')
		expect(contentToPlainText([])).toBe('')
	})
})
