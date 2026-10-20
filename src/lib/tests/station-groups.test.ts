import { describe, expect, it } from 'vitest';

import { cellId, groupBounds, groupTapZoom } from '../station-groups';

describe('cellId', () => {
	// Ids from the production live-cluster (SRF-3044 repro, Schleswig-Holstein).
	it('matches the live-wind service for the same point', () => {
		expect(cellId(54.71997, 9.52707, 8)).toBe('c-z8-134-81');
		expect(cellId(53.82635, 10.43137, 8)).toBe('c-z8-135-82');
	});

	it('clamps the poles and the antimeridian into the grid', () => {
		expect(cellId(89.9, 180, 3)).toBe('c-z3-7-0');
		expect(cellId(-89.9, -180, 3)).toBe('c-z3-0-7');
	});
});

describe('groupBounds', () => {
	const positions = [
		{ lat: 53.87, lon: 10.69 }, // Lübeck — cell c-z8-135-82
		{ lat: 53.63, lon: 10.0 }, // Hamburg — same cell
		{ lat: 54.32, lon: 10.13 } // Kiel — another cell
	];

	it('spans only the stations inside the node cell', () => {
		expect(groupBounds('c-z8-135-82', 8, positions)).toEqual([
			[10.0, 53.63],
			[10.69, 53.87]
		]);
	});

	it('is null when no known station is in the cell', () => {
		expect(groupBounds('c-z8-1-1', 8, positions)).toBeNull();
	});
});

describe('groupTapZoom', () => {
	it('lands just past the expansion zoom when the group is too wide to fit there', () => {
		expect(groupTapZoom(6.4, 8, 11)).toBeCloseTo(8.01);
	});

	it('takes the fitted zoom when it is deeper than the expansion zoom', () => {
		expect(groupTapZoom(9.3, 8, 11)).toBe(9.3);
	});

	it('never lands closer than the cap', () => {
		expect(groupTapZoom(15, 8, 11)).toBe(11);
	});

	it('falls back to the expansion zoom without a fit', () => {
		expect(groupTapZoom(undefined, 6, 11)).toBeCloseTo(6.01);
		expect(groupTapZoom(NaN, 4, 11)).toBeCloseTo(4.01);
	});
});
