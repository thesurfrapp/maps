import { get } from 'svelte/store';

import { type DomainMetaDataJson, VARIABLE_PREFIX } from '@openmeteo/weather-map-layer';

import { loading } from '$lib/stores/preferences';
import { latest as l, metaJson as mJ, modelRun as mR } from '$lib/stores/time';
import { selectedDomain, variable as v } from '$lib/stores/variables';

import { getBaseUri } from './helpers';

export const getInitialMetaData = async () => {
	const domain = get(selectedDomain);
	const uri = getBaseUri(domain.value);

	// Only read latest.json from our proxy. It's served R2-only, and the
	// warmer writes it LAST in the atomic swap — so its reference_time is
	// guaranteed to point at a run whose full 72 h of .om files are in R2.
	// Upstream's latest.json already contains valid_times and variables, so
	// this is the only metadata fetch we need.
	const latestRes = await fetch(`${uri}/data_spatial/${domain.value}/latest.json`, {
		cache: 'no-store'
	});

	if (!latestRes.ok) {
		loading.set(false);
		throw new Error(`HTTP ${latestRes.status}`);
	}
	l.set(await latestRes.json());
};

export const getMetaData = async (): Promise<DomainMetaDataJson> => {
	const latest = get(l);
	if (!latest) throw new Error('latest.json not loaded');

	// modelRun is always pinned to latest.reference_time. Set unconditionally
	// so a domain switch (which reloads latest.json for the new domain) also
	// advances modelRun — otherwise getOMUrl would build URLs with the
	// previous domain's runPath, 404.
	mR.set(new Date(latest.reference_time));

	const result = { ...latest } as DomainMetaDataJson;
	result.valid_times = [...latest.valid_times].sort();
	return result;
};

export const matchVariableOrFirst = () => {
	const variable = get(v);
	const metaJson = get(mJ);
	if (!metaJson || metaJson.variables.includes(variable)) return;

	let matched: string | undefined;
	const prefix = variable.match(VARIABLE_PREFIX)?.groups?.prefix;

	if (prefix) {
		matched = metaJson.variables.find((mv) => mv.startsWith(prefix));
	}

	v.set(matched ?? metaJson.variables[0]);
};
