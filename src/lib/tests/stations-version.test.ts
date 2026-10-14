import { describe, expect, it } from 'vitest';

import { needsBaseReload, readingsMatchBase } from '../stations-version';

describe('station file versions', () => {
	it('asks for a new positions file only when both versions are known and differ', () => {
		expect(needsBaseReload(1, 2)).toBe(true);
		expect(needsBaseReload(1, 1)).toBe(false);
		expect(needsBaseReload(null, 2)).toBe(false); // legacy positions file without v
		expect(needsBaseReload(1, undefined)).toBe(false); // legacy readings without v
	});

	it('paints readings only on matching positions (legacy files are trusted)', () => {
		expect(readingsMatchBase(7, 7)).toBe(true);
		expect(readingsMatchBase(7, 8)).toBe(false); // reload failed or cooldown served the old file
		expect(readingsMatchBase(null, 8)).toBe(true);
		expect(readingsMatchBase(7, undefined)).toBe(true);
	});
});
