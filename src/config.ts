/** Runtime configuration. Nothing here is secret. */

const rawBase: string = import.meta.env['VITE_API_URL'] ?? '';

/** Base URL of the monitoring Worker API, without a trailing slash. */
export const API_BASE = rawBase.replace(/\/+$/, '');

/** Poll interval for the dashboard while the tab is visible. */
export const POLL_INTERVAL_MS = 120_000;

/** Server-side retention, mirrored here to clamp requested ranges. */
export const MEASUREMENT_RETENTION_DAYS = 90;
export const PHOTO_RETENTION_DAYS = 30;

/** The agent samples every 10 minutes. */
export const SAMPLE_INTERVAL_SECONDS = 600;

/** A measurement newer than this means the device is delivering normally. */
export const DEVICE_ONLINE_SECONDS = 15 * 60;
export const DEVICE_LATE_SECONDS = 60 * 60;

/** Largest page the API allows, and the cap on how many pages we will follow. */
export const MAX_PAGE_LIMIT = 1000;
export const MAX_PAGES = 8;

/** localStorage keys. */
export const SESSION_STORAGE_KEY = 'monitor.session';
export const HIDDEN_SERIES_STORAGE_KEY = 'monitor.hiddenSeries';
export const RANGE_STORAGE_KEY = 'monitor.range';

export const SECONDS_PER_DAY = 86_400;
