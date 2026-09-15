/**
 * Unit inference.
 *
 * Metric names arrive from the device, not from a fixed list: today `cpu` and
 * `agent`, later BMP280 and DHT11. The unit is inferred from the metric name so
 * a new sensor plots correctly without a code change, and each unit becomes its
 * own chart panel. Mixing units on one pair of axes would be a dual-axis chart,
 * which misstates the relationship between the series.
 */

export interface Unit {
  /** Stable identifier, also the panel key. */
  id: string;
  /** Axis label. */
  label: string;
  /** Short suffix for tooltips and legends; empty for dimensionless counts. */
  suffix: string;
  /** Human-readable value, used in tooltips, legends and the table view. */
  format: (value: number) => string;
  /** Compact form for axis ticks. */
  formatTick: (value: number) => string;
}

function fixed(digits: number): (value: number) => string {
  return (value) => value.toFixed(digits);
}

function formatBytes(value: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  const sign = value < 0 ? '-' : '';
  let size = Math.abs(value);
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  const digits = size >= 100 || index === 0 ? 0 : 1;
  return `${sign}${size.toFixed(digits)} ${units[index]}`;
}

function formatDuration(value: number): string {
  const sign = value < 0 ? '-' : '';
  const total = Math.round(Math.abs(value));
  if (total < 60) return `${sign}${total} s`;
  if (total < 3600) return `${sign}${Math.floor(total / 60)} min ${total % 60} s`;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (hours < 24) return `${sign}${hours} h ${minutes} min`;
  return `${sign}${Math.floor(hours / 24)} d ${hours % 24} h`;
}

function formatCount(value: number): string {
  return Number.isInteger(value) ? value.toLocaleString('en-US') : value.toFixed(2);
}

const CELSIUS: Unit = {
  id: 'celsius',
  label: 'Temperature, °C',
  suffix: '°C',
  format: (value) => `${value.toFixed(1)} °C`,
  formatTick: fixed(0),
};

const PERCENT: Unit = {
  id: 'percent',
  label: 'Relative humidity, %',
  suffix: '%',
  format: (value) => `${value.toFixed(1)} %`,
  formatTick: fixed(0),
};

const PRESSURE: Unit = {
  id: 'hectopascal',
  label: 'Pressure, hPa',
  suffix: 'hPa',
  format: (value) => `${value.toFixed(1)} hPa`,
  formatTick: fixed(0),
};

const BYTES: Unit = {
  id: 'bytes',
  label: 'Size',
  suffix: '',
  format: formatBytes,
  formatTick: formatBytes,
};

const SECONDS: Unit = {
  id: 'seconds',
  label: 'Age',
  suffix: '',
  format: formatDuration,
  formatTick: (value) => formatDuration(value),
};

/**
 * The axis used when one plot carries series of different units. Each series is
 * rescaled to its own range, so the shapes can be compared while the legend and
 * the table keep the measured values in their real units.
 */
const NORMALIZED: Unit = {
  id: 'normalized',
  label: 'Rescaled to each series own range, %',
  suffix: '%',
  format: (value) => `${value.toFixed(0)} %`,
  formatTick: (value) => value.toFixed(0),
};

const COUNT: Unit = {
  id: 'count',
  label: 'Count',
  suffix: '',
  format: formatCount,
  formatTick: formatCount,
};

/** Panels appear in this order; unknown units fall in at the end. */
export const UNIT_ORDER = [CELSIUS.id, PERCENT.id, PRESSURE.id, COUNT.id, BYTES.id, SECONDS.id];

const RULES: Array<{ test: RegExp; unit: Unit }> = [
  { test: /(^|_)(temperature|temp)(_c)?$/, unit: CELSIUS },
  { test: /_c$/, unit: CELSIUS },
  { test: /(^|_)humidity/, unit: PERCENT },
  { test: /(_pct|_percent)$/, unit: PERCENT },
  { test: /(^|_)pressure/, unit: PRESSURE },
  { test: /_hpa$/, unit: PRESSURE },
  { test: /(^|_)bytes$/, unit: BYTES },
  { test: /_seconds$/, unit: SECONDS },
];

/** Infer the unit of a metric from its name. Unknown metrics plot as counts. */
export function unitForMetric(metric: string): Unit {
  const name = metric.toLowerCase();
  for (const rule of RULES) {
    if (rule.test.test(name)) return rule.unit;
  }
  return COUNT;
}

export const UNITS = { CELSIUS, PERCENT, PRESSURE, BYTES, SECONDS, COUNT, NORMALIZED };
