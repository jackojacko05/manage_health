import assert from 'node:assert/strict';
import test from 'node:test';

process.env.GCP_PROJECT_ID = 'test-project';

const {
  aggregatedSleepSession,
  canonicalSleepState,
  metricValue,
  parseSleepSegment,
} = require('./index') as typeof import('./index');

test('aggregated sleep uses totalSleep instead of generic qty', () => {
  const point = {
    date: '2026-07-11',
    qty: 0.5,
    totalSleep: 6.3,
    asleep: 6.2,
    inBed: 6.38,
    core: 3.5,
    deep: 1.0,
    rem: 1.7,
    awake: 0.08,
    sleepStart: '2026-07-11 01:25:00 +0900',
    sleepEnd: '2026-07-11 07:48:00 +0900',
    inBedStart: '2026-07-11 01:24:00 +0900',
    inBedEnd: '2026-07-11 07:47:00 +0900',
    source: 'Apple Watch',
  };

  const session = aggregatedSleepSession('hr', point);
  assert.ok(session);
  assert.equal(session.sleep_date, '2026-07-11');
  assert.equal(session.total_sleep_seconds, 6.3 * 3600);
  assert.equal(session.in_bed_seconds, 6.38 * 3600);
  assert.equal(metricValue('sleep_analysis', 'hr', point, session.sleep_start), 6.3 * 3600);
});

test('sleep date follows sleepStart noon boundary even when payload date disagrees', () => {
  const session = aggregatedSleepSession('hr', {
    date: '2026-07-10',
    totalSleep: 6,
    sleepStart: '2026-07-11 01:25:00 +0900',
    sleepEnd: '2026-07-11 07:25:00 +0900',
  });
  assert.equal(session?.sleep_date, '2026-07-11');

  const previousEvening = aggregatedSleepSession('hr', {
    date: '2026-07-10',
    totalSleep: 6,
    sleepStart: '2026-07-10 23:30:00 +0900',
  });
  assert.equal(previousEvening?.sleep_date, '2026-07-11');
});

test('scalar and object sleep measurements honor their units', () => {
  const session = aggregatedSleepSession('hours', {
    date: '2026-07-11',
    totalSleep: { qty: 6.3, units: 'hours' },
    inBed: { value: 383, unit: 'minutes' },
    sleepStart: '2026-07-11 01:25:00 +0900',
  });
  assert.equal(session?.total_sleep_seconds, 6.3 * 3600);
  assert.equal(session?.in_bed_seconds, 383 * 60);
});

test('unaggregated Awake and In Bed segments are not counted as sleep', () => {
  const states = ['Awake', 'in bed', 'in-bed', 'HKCategoryValueSleepAnalysisAwake',
    'HKCategoryValueSleepAnalysisInBed', 0, '0', 2, '2'];
  for (const value of states) {
    assert.equal(metricValue('sleep_analysis', 'hr', {
      date: '2026-07-11', value, qty: 0.2,
    }, '2026-07-11T01:25:00+09:00'), null, String(value));
  }
});

test('unaggregated sleep stages remain countable across enum forms', () => {
  for (const value of ['Asleep', 'Core', 'Deep', 'REM', 'HKCategoryValueSleepAnalysisAsleepCore', 1, 3, 4, 5]) {
    const seconds = metricValue('sleep_analysis', 'hr', {
      date: '2026-07-11', value, qty: 0.75,
    }, '2026-07-11T01:25:00+09:00');
    assert.equal(seconds, 45 * 60, String(value));
  }
});

test('segment parser preserves interval, raw state, source, and unknown states', () => {
  const parsed = parseSleepSegment({
    date: '2026-07-11 01:25:00 +0900',
    startDate: '2026-07-11 01:25:00 +0900',
    endDate: '2026-07-11 02:25:00 +0900',
    value: 'HKCategoryValueSleepAnalysisAsleepCore',
    sourceName: 'Apple Watch',
    uuid: 'segment-1',
    qty: 3600,
  });
  assert.ok(parsed.row);
  assert.equal(parsed.row.state, 'sleep');
  assert.equal(parsed.row.raw_state, 'HKCategoryValueSleepAnalysisAsleepCore');
  assert.equal(parsed.row.source, 'Apple Watch');
  assert.equal(parsed.row.record_id, 'segment-1');
  assert.equal(parsed.row.duration_seconds, 3600);
  assert.equal(parsed.row.sleep_date, '2026-07-11');
});

test('segment parser accepts Awake and InBed and keeps an unknown state', () => {
  assert.equal(canonicalSleepState('Awake'), 'awake');
  assert.equal(canonicalSleepState(0), 'inbed');
  assert.equal(canonicalSleepState('vendor-specific-state'), 'unknown');
  assert.equal(parseSleepSegment({
    date: '2026-07-11 02:25:00 +0900',
    startDate: '2026-07-11 02:25:00 +0900',
    endDate: '2026-07-11 02:35:00 +0900',
    value: 'Awake',
  }).row?.state, 'awake');
  assert.equal(parseSleepSegment({
    date: '2026-07-11 02:35:00 +0900',
    startDate: '2026-07-11 02:35:00 +0900',
    endDate: '2026-07-11 02:45:00 +0900',
    value: 0,
  }).row?.state, 'inbed');
  assert.equal(parseSleepSegment({
    date: '2026-07-11 02:45:00 +0900',
    startDate: '2026-07-11 02:45:00 +0900',
    endDate: '2026-07-11 02:55:00 +0900',
    value: 'VendorState',
  }).row?.state, 'unknown');
});

test('segment parser maps localized Apple Health sleep states', () => {
  assert.equal(canonicalSleepState('起きている'), 'awake');
  assert.equal(canonicalSleepState('ベッドに入る'), 'inbed');
  assert.equal(canonicalSleepState('コア'), 'sleep');
  assert.equal(canonicalSleepState('深い'), 'sleep');
  assert.equal(canonicalSleepState('レム'), 'sleep');
});

test('segment parser rejects invalid periods with a reason', () => {
  const invalid = parseSleepSegment({
    date: '2026-07-11 02:00:00 +0900',
    startDate: '2026-07-11 02:00:00 +0900',
    endDate: '2026-07-11 01:00:00 +0900',
    value: 'Asleep',
  });
  assert.equal(invalid.row, null);
  assert.equal(invalid.reason, 'non_positive_or_invalid_duration');
});
