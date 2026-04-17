import { writable } from 'svelte/store';

/**
 * Actions provided by the TimeSelector component so that the
 * keyboard handler can trigger time navigation.
 */
export interface TimeSelectorActions {
	previousHour?: () => void;
	nextHour?: () => void;
	previousDay?: () => void;
	nextDay?: () => void;
	jumpToCurrentTime?: () => void;
	timeNavigationDisabled?: boolean;
}

export const timeSelectorActions = writable<TimeSelectorActions>({});
