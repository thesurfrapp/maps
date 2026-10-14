import { describe, expect, it, vi } from 'vitest';

import { UpstreamGate, lookupFile } from '../../../functions/lib/upstream-gate';

const ok = (body = '{}') => new Response(body, { status: 200, headers: { ETag: '"lc-1"' } });

describe('UpstreamGate', () => {
	it('shares one upstream request between concurrent callers', async () => {
		const gate = new UpstreamGate(30_000);
		let release!: (r: Response) => void;
		const doFetch = vi.fn(() => new Promise<Response>((r) => (release = r)));

		const burst = Array.from({ length: 20 }, () => gate.fetch('u', doFetch));
		release(ok('{"v":1}'));
		const results = await Promise.all(burst);

		expect(doFetch).toHaveBeenCalledTimes(1);
		expect(results.every((r) => r.ok && r.body === '{"v":1}' && r.etag === '"lc-1"')).toBe(true);
	});

	it('starts a new request once the previous one finished', async () => {
		const gate = new UpstreamGate(30_000);
		const doFetch = vi.fn(async () => ok());
		await gate.fetch('u', doFetch);
		await gate.fetch('u', doFetch);
		expect(doFetch).toHaveBeenCalledTimes(2);
	});

	it('cools a URL down after a failure and clears it after a success', async () => {
		let now = 1_000;
		const gate = new UpstreamGate(30_000, () => now);

		const failed = await gate.fetch('u', async () => new Response('', { status: 500 }));
		expect(failed.ok).toBe(false);
		expect(gate.inBackoff('u')).toBe(true);
		expect(gate.inBackoff('other')).toBe(false);

		now += 30_000;
		expect(gate.inBackoff('u')).toBe(false);

		await gate.fetch('u', async () => {
			throw new Error('network');
		});
		expect(gate.inBackoff('u')).toBe(true);

		now += 30_000;
		await gate.fetch('u', async () => ok());
		expect(gate.inBackoff('u')).toBe(false);
	});
});

describe('lookupFile', () => {
	const files = { 'readings.json': { upstream: 'readings' } };

	it('finds the allowlisted files', () => {
		expect(lookupFile(files, 'readings.json')).toEqual({ upstream: 'readings' });
	});

	it('rejects prototype names', () => {
		for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
			expect(lookupFile(files, name)).toBeUndefined();
		}
	});
});
