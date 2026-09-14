import { describe, expect, it } from 'vitest';
import { UNITS, unitForMetric } from '../src/model/units.ts';

describe('unitForMetric', () => {
  it('recognises the metrics the agent sends today', () => {
    expect(unitForMetric('cpu_temperature_c').id).toBe('celsius');
    expect(unitForMetric('queued').id).toBe('count');
    expect(unitForMetric('dropped').id).toBe('count');
    expect(unitForMetric('bytes').id).toBe('bytes');
    expect(unitForMetric('oldest_age_seconds').id).toBe('seconds');
  });

  it('recognises the sensors planned next', () => {
    expect(unitForMetric('bmp280_temperature_c').id).toBe('celsius');
    expect(unitForMetric('pressure_hpa').id).toBe('hectopascal');
    expect(unitForMetric('humidity_pct').id).toBe('percent');
    expect(unitForMetric('dht11_humidity').id).toBe('percent');
  });

  it('falls back to a count for an unknown metric', () => {
    expect(unitForMetric('something_new').id).toBe('count');
  });
});

describe('formatting', () => {
  it('scales byte counts', () => {
    expect(UNITS.BYTES.format(512)).toBe('512 B');
    expect(UNITS.BYTES.format(2048)).toBe('2.0 KiB');
    // Three significant digits are enough; decimals only add noise on an axis.
    expect(UNITS.BYTES.format(520_455)).toBe('508 KiB');
    expect(UNITS.BYTES.format(6_000_000_000)).toBe('5.6 GiB');
  });

  it('writes durations in familiar units', () => {
    expect(UNITS.SECONDS.format(45)).toBe('45 s');
    expect(UNITS.SECONDS.format(125)).toBe('2 min 5 s');
    expect(UNITS.SECONDS.format(29_625)).toBe('8 h 13 min');
    expect(UNITS.SECONDS.format(180_000)).toBe('2 d 2 h');
  });

  it('keeps one decimal on temperature', () => {
    expect(UNITS.CELSIUS.format(42.75)).toBe('42.8 °C');
  });

  it('groups large counts', () => {
    expect(UNITS.COUNT.format(4096)).toBe('4,096');
  });
});
