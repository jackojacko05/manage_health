/**
 * One-shot historical backfill: Apple Health export.xml → BigQuery.
 *
 * Input:  ${XML_PATH}  (default: /tmp/apple_health_export/export.xml, ~1.5 GB)
 * Output: /tmp/bq_migrate/*.ndjson, then `bq load --replace` into:
 *   - ${PROJECT}.${DATASET}.heart_rate   (raw samples)
 *   - ${PROJECT}.${DATASET}.hrv          (raw samples)
 *   - ${PROJECT}.${DATASET}.workouts     (events)
 *   - ${PROJECT}.${DATASET}.raw_metrics  (hourly-aggregated)
 *
 * Usage:
 *   GCP_PROJECT_ID=your-project npx tsx migrate-from-export-xml.ts [--dry-run]
 *
 * Design:
 *   - sax stream-parse (the XML is too large for in-memory DOM)
 *   - HR / HRV → raw sample rows
 *   - Other metrics → hourly buckets with SUM or AVG per HAE's naming convention
 *   - Workout → one row per event with WorkoutStatistics folded in
 *
 * See references/backfill-from-xml.md and references/customize-metrics.md
 * in the health-pipeline skill for the metric-mapping rationale.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as sax from 'sax';
import * as crypto from 'crypto';
import { execSync } from 'child_process';

const XML_PATH =
  process.env.XML_PATH ||
  '/tmp/apple_health_export/export.xml';
const OUT_DIR = process.env.OUT_DIR || '/tmp/bq_migrate';
const PROJECT_ID = process.env.GCP_PROJECT_ID;
if (!PROJECT_ID) {
  throw new Error('GCP_PROJECT_ID environment variable is required');
}
const DATASET = process.env.BQ_DATASET || 'health';
const DRY = process.argv.includes('--dry-run');

// ------ HAE と揃える metric_name マッピング ------
// 観測済みの HAE の metric_name に寄せる。未知の type は snake_case 自動変換。
const HK_TO_METRIC: Record<string, string> = {
  HKQuantityTypeIdentifierStepCount: 'step_count',
  HKQuantityTypeIdentifierDistanceWalkingRunning: 'walking_running_distance',
  HKQuantityTypeIdentifierDistanceCycling: 'cycling_distance',
  HKQuantityTypeIdentifierBasalEnergyBurned: 'basal_energy_burned',
  HKQuantityTypeIdentifierActiveEnergyBurned: 'active_energy',
  HKQuantityTypeIdentifierAppleExerciseTime: 'apple_exercise_time',
  HKQuantityTypeIdentifierAppleStandTime: 'apple_stand_time',
  HKCategoryTypeIdentifierAppleStandHour: 'apple_stand_hour',
  HKQuantityTypeIdentifierFlightsClimbed: 'flights_climbed',
  HKQuantityTypeIdentifierTimeInDaylight: 'time_in_daylight',
  HKQuantityTypeIdentifierPhysicalEffort: 'physical_effort',
  HKQuantityTypeIdentifierRespiratoryRate: 'respiratory_rate',
  HKQuantityTypeIdentifierOxygenSaturation: 'blood_oxygen_saturation',
  HKQuantityTypeIdentifierWalkingSpeed: 'walking_speed',
  HKQuantityTypeIdentifierWalkingStepLength: 'walking_step_length',
  HKQuantityTypeIdentifierWalkingDoubleSupportPercentage:
    'walking_double_support_percentage',
  HKQuantityTypeIdentifierWalkingAsymmetryPercentage:
    'walking_asymmetry_percentage',
  HKQuantityTypeIdentifierEnvironmentalAudioExposure:
    'environmental_audio_exposure',
  HKQuantityTypeIdentifierHeadphoneAudioExposure: 'headphone_audio_exposure',
  HKQuantityTypeIdentifierEnvironmentalSoundReduction:
    'environmental_sound_reduction',
  HKQuantityTypeIdentifierBodyMass: 'weight_body_mass',
  HKQuantityTypeIdentifierBodyFatPercentage: 'body_fat_percentage',
  HKQuantityTypeIdentifierLeanBodyMass: 'lean_body_mass',
  HKQuantityTypeIdentifierHeight: 'height',
  HKQuantityTypeIdentifierBodyMassIndex: 'body_mass_index',
  HKQuantityTypeIdentifierRestingHeartRate: 'resting_heart_rate',
  HKQuantityTypeIdentifierHeartRateRecoveryOneMinute:
    'heart_rate_recovery_one_minute',
  HKQuantityTypeIdentifierVO2Max: 'vo2_max',
  HKCategoryTypeIdentifierSleepAnalysis: 'sleep_analysis',
  HKCategoryTypeIdentifierHighHeartRateEvent: 'high_heart_rate_event',
  HKCategoryTypeIdentifierAudioExposureEvent: 'audio_exposure_event',
  HKCategoryTypeIdentifierMenstrualFlow: 'menstrual_flow',
  HKCategoryTypeIdentifierHeadache: 'headache',
  HKCategoryTypeIdentifierFatigue: 'fatigue',
  HKCategoryTypeIdentifierAbdominalCramps: 'abdominal_cramps',
  HKCategoryTypeIdentifierLowerBackPain: 'lower_back_pain',
  HKCategoryTypeIdentifierSexualActivity: 'sexual_activity',
  HKCategoryTypeIdentifierContraceptive: 'contraceptive',
  HKQuantityTypeIdentifierRunningSpeed: 'running_speed',
  HKQuantityTypeIdentifierRunningPower: 'running_power',
  HKQuantityTypeIdentifierRunningStrideLength: 'running_stride_length',
  HKQuantityTypeIdentifierRunningGroundContactTime:
    'running_ground_contact_time',
  HKQuantityTypeIdentifierRunningVerticalOscillation:
    'running_vertical_oscillation',
  HKQuantityTypeIdentifierStairAscentSpeed: 'stair_ascent_speed',
  HKQuantityTypeIdentifierStairDescentSpeed: 'stair_descent_speed',
  HKQuantityTypeIdentifierSixMinuteWalkTestDistance:
    'six_minute_walk_test_distance',
  HKQuantityTypeIdentifierAppleWalkingSteadiness: 'apple_walking_steadiness',
  HKQuantityTypeIdentifierDietaryEnergyConsumed: 'dietary_energy',
  HKQuantityTypeIdentifierDietaryProtein: 'protein',
  HKQuantityTypeIdentifierDietaryCarbohydrates: 'carbohydrates',
  HKQuantityTypeIdentifierDietaryFatTotal: 'total_fat',
  HKQuantityTypeIdentifierDietaryFatSaturated: 'saturated_fat',
  HKQuantityTypeIdentifierDietaryFiber: 'fiber',
  HKQuantityTypeIdentifierDietarySodium: 'sodium',
  HKQuantityTypeIdentifierDietarySugar: 'sugar',
  HKQuantityTypeIdentifierDietaryCalcium: 'calcium',
  HKQuantityTypeIdentifierDietaryIron: 'iron',
  HKQuantityTypeIdentifierDietaryRiboflavin: 'riboflavin',
  HKQuantityTypeIdentifierDietaryThiamin: 'thiamin',
  HKQuantityTypeIdentifierDietaryVitaminA: 'vitamin_a',
  HKQuantityTypeIdentifierDietaryVitaminC: 'vitamin_c',
  HKQuantityTypeIdentifierDietaryVitaminE: 'vitamin_e',
};

// 合算するメトリック（累積値）。未指定は AVG。
const SUM_METRICS = new Set([
  'step_count',
  'walking_running_distance',
  'cycling_distance',
  'basal_energy_burned',
  'active_energy',
  'apple_exercise_time',
  'apple_stand_time',
  'flights_climbed',
  'time_in_daylight',
  'dietary_energy',
  'protein',
  'carbohydrates',
  'total_fat',
  'saturated_fat',
  'fiber',
  'sodium',
  'sugar',
  'calcium',
  'iron',
  'riboflavin',
  'thiamin',
  'vitamin_a',
  'vitamin_c',
  'vitamin_e',
]);

function metricName(hkType: string): string {
  if (HK_TO_METRIC[hkType]) return HK_TO_METRIC[hkType];
  const suffix = hkType
    .replace('HKQuantityTypeIdentifier', '')
    .replace('HKCategoryTypeIdentifier', '');
  return suffix
    .replace(/([A-Z])([A-Z][a-z])/g, '$1_$2')
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .toLowerCase();
}

// ------ 日付変換 "2023-10-11 23:56:22 +0900" → ISO8601 ------
function toIso(s: string): string | null {
  if (!s) return null;
  const m = s.match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) ([+-])(\d{2})(\d{2})$/);
  if (!m) return null;
  return `${m[1]}T${m[2]}${m[3]}${m[4]}:${m[5]}`;
}

// ts を 1時間単位に丸めた ISO 文字列 (UTC) を返す
function hourBucket(iso: string): string {
  const d = new Date(iso);
  d.setUTCMinutes(0, 0, 0);
  return d.toISOString();
}

function shortSource(s?: string): string | null {
  if (!s) return null;
  // "平山智香子さんのApple Watch" 等の個人名を含むのは分析に不要なので device 種別だけ残す
  if (/Apple Watch/i.test(s)) return 'Apple Watch';
  if (/iPhone/i.test(s)) return 'iPhone';
  if (/ヘルスケア/.test(s) || /Health/i.test(s)) return 'Health';
  return s.slice(0, 40);
}

function isSleepAsleepState(value?: string): boolean {
  // Apple Health sleep categories. The daily "time asleep" total is the sum of
  // asleep states only; InBed and Awake are separate display totals.
  const v = String(value ?? '').trim().toLowerCase().replace(/[_-]+/g, '');
  return [
    'hkcategoryvaluesleepanalysisasleep',
    'hkcategoryvaluesleepanalysisasleepunspecified',
    'hkcategoryvaluesleepanalysisasleepcore',
    'hkcategoryvaluesleepanalysisasleepdeep',
    'hkcategoryvaluesleepanalysisasleeprem',
    '1',
    '3',
    '4',
    '5',
  ].includes(v);
}

// ------ 書き出し用 WriteStream ------
fs.mkdirSync(OUT_DIR, { recursive: true });
const streams = {
  heart_rate: fs.createWriteStream(path.join(OUT_DIR, 'heart_rate.ndjson')),
  hrv: fs.createWriteStream(path.join(OUT_DIR, 'hrv.ndjson')),
  workouts: fs.createWriteStream(path.join(OUT_DIR, 'workouts.ndjson')),
  raw_metrics: fs.createWriteStream(path.join(OUT_DIR, 'raw_metrics.ndjson')),
};
function emit(table: keyof typeof streams, obj: any) {
  streams[table].write(JSON.stringify(obj) + '\n');
}

// ------ Hour バケット集計バッファ ------
// key = `${metric}|${hourBucketIso}|${source}`
const bucket = new Map<
  string,
  { metric: string; ts: string; source: string | null; unit: string; sum: number; n: number; useSum: boolean }
>();

function aggPush(metric: string, iso: string, value: number, unit: string, source: string | null) {
  const hr = hourBucket(iso);
  const k = `${metric}|${hr}|${source ?? ''}`;
  let b = bucket.get(k);
  if (!b) {
    b = {
      metric,
      ts: hr,
      source,
      unit,
      sum: 0,
      n: 0,
      useSum: SUM_METRICS.has(metric),
    };
    bucket.set(k, b);
  }
  b.sum += value;
  b.n += 1;
}

// ------ Workout 状態 ------
let currentWorkout: any = null;
const workoutStats: Map<string, Record<string, any>> = new Map(); // workoutKey -> stats

// ------ カウンタ ------
const counters = { hr: 0, hrv: 0, raw: 0, workout: 0, stat: 0, unknown: 0 };

const parser = sax.createStream(true, { trim: true });

parser.on('opentag', (node: any) => {
  const tag = node.name;
  const a = node.attributes;

  if (tag === 'Record') {
    const type = a.type as string;
    const startIso = toIso(a.startDate);
    if (!startIso) return;
    const valueStr = a.value as string | undefined;
    const unit = (a.unit as string) || '';
    const source = shortSource(a.sourceName);

    if (type === 'HKQuantityTypeIdentifierHeartRate') {
      const bpm = Number(valueStr);
      if (!Number.isFinite(bpm)) return;
      emit('heart_rate', { start_at: startIso, bpm, source });
      counters.hr++;
      return;
    }
    if (type === 'HKQuantityTypeIdentifierHeartRateVariabilitySDNN') {
      const sdnn = Number(valueStr);
      if (!Number.isFinite(sdnn)) return;
      emit('hrv', { start_at: startIso, sdnn, source });
      counters.hrv++;
      return;
    }

    const metric = metricName(type);

    if (type === 'HKCategoryTypeIdentifierSleepAnalysis') {
      const endIso = toIso(a.endDate);
      if (!endIso || !isSleepAsleepState(valueStr)) return;
      const value = (new Date(endIso).getTime() - new Date(startIso).getTime()) / 1000;
      if (!Number.isFinite(value) || value <= 0) return;
      emit('raw_metrics', {
        metric_name: metric,
        ts: startIso,
        value,
        unit: 's',
        source,
        sleep_kind: 'segment',
      });
      counters.raw++;
      return;
    }

    // CategoryType の value は文字列。数値化できない場合は duration (sec)
    // に変換する。睡眠は上で asleep states だけをセグメント保存する。
    let value: number;
    const numericVal = Number(valueStr);
    if (Number.isFinite(numericVal)) {
      value = numericVal;
    } else if (type.startsWith('HKCategoryType')) {
      // 継続時間をそのサンプルの長さとして秒で代用
      const endIso = toIso(a.endDate);
      if (!endIso) return;
      value = (new Date(endIso).getTime() - new Date(startIso).getTime()) / 1000;
    } else {
      return;
    }

    aggPush(metric, startIso, value, unit, source);
    counters.raw++;
    return;
  }

  if (tag === 'Workout') {
    const startIso = toIso(a.startDate);
    const endIso = toIso(a.endDate);
    if (!startIso || !endIso) {
      currentWorkout = null;
      return;
    }
    const durationMin = Number(a.duration) || null;
    currentWorkout = {
      start_at: startIso,
      end_at: endIso,
      activity_type:
        (a.workoutActivityType || '').replace('HKWorkoutActivityType', ''),
      duration_min: a.durationUnit === 'min' ? durationMin : null,
      total_kcal: null as number | null,
      distance_km: null as number | null,
      avg_hr: null as number | null,
      source: shortSource(a.sourceName),
    };
    return;
  }

  if (tag === 'WorkoutStatistics' && currentWorkout) {
    const type = a.type as string;
    counters.stat++;
    if (type === 'HKQuantityTypeIdentifierActiveEnergyBurned') {
      const n = Number(a.sum);
      if (Number.isFinite(n)) currentWorkout.total_kcal = n;
    } else if (type === 'HKQuantityTypeIdentifierDistanceWalkingRunning' || type === 'HKQuantityTypeIdentifierDistanceCycling') {
      const n = Number(a.sum);
      if (Number.isFinite(n)) currentWorkout.distance_km = n;
    } else if (type === 'HKQuantityTypeIdentifierHeartRate') {
      const n = Number(a.average);
      if (Number.isFinite(n)) currentWorkout.avg_hr = n;
    }
    return;
  }
});

parser.on('closetag', (tag: string) => {
  if (tag === 'Workout' && currentWorkout) {
    emit('workouts', currentWorkout);
    counters.workout++;
    currentWorkout = null;
  }
});

parser.on('error', (e) => {
  console.error('[sax] error', e);
  parser._parser.error = null;
  parser._parser.resume();
});

parser.on('end', () => {
  // Hour バケットをフラッシュ
  for (const b of bucket.values()) {
    const value = b.useSum ? b.sum : b.sum / b.n;
    emit('raw_metrics', {
      metric_name: b.metric,
      ts: b.ts,
      value,
      unit: b.unit,
      source: b.source,
    });
  }
  console.log('[migrate] parsed counts:', counters);
  console.log('[migrate] hour buckets:', bucket.size);

  // stream.end() は非同期フラッシュ。全ストリームの finish イベントを待ってから bq load する。
  let pending = Object.values(streams).length;
  const onFinish = () => {
    pending--;
    if (pending > 0) return;
    runBqLoad();
  };
  Object.values(streams).forEach((s) => { s.end(); s.once('finish', onFinish); });

  if (DRY) {
    // dry-run では finish を待たずに即リターン（ファイルは書き出し中のまま終了）
    console.log('[migrate] --dry-run: skipping bq load');
    return;
  }

  function runBqLoad() {
  // ------ BQ load ------
  const loads = [
    { file: 'heart_rate.ndjson', table: 'heart_rate' },
    { file: 'hrv.ndjson', table: 'hrv' },
    { file: 'workouts.ndjson', table: 'workouts' },
    { file: 'raw_metrics.ndjson', table: 'raw_metrics' },
  ];
  for (const { file, table } of loads) {
    const p = path.join(OUT_DIR, file);
    const sz = fs.statSync(p).size;
    console.log(`[bq load] ${table} <- ${file} (${(sz / 1024 / 1024).toFixed(1)} MB)`);
    if (sz === 0) {
      console.log(`[bq load] skip empty ${file}`);
      continue;
    }
    // --replace: historical 取込なので全件洗い替え。今日分 HAE の数十行はその後の
    // 通常 ingest で追いつく（DISTINCT 工程は最終 Step で実施）
    execSync(
      `bq load --project_id=${PROJECT_ID} --source_format=NEWLINE_DELIMITED_JSON --replace=true ${PROJECT_ID}:${DATASET}.${table} ${p}`,
      { stdio: 'inherit' },
    );
  }

  // ingest_log
  const logSql = `INSERT INTO \`${PROJECT_ID}.${DATASET}.ingest_log\` (source, file_hash, file_name, rows_added) VALUES ('historical-export-xml', '${crypto.randomBytes(12).toString('hex')}', '${XML_PATH}', ${counters.hr + counters.hrv + counters.workout + bucket.size})`;
  execSync(`bq query --project_id=${PROJECT_ID} --nouse_legacy_sql`, {
    input: logSql,
    stdio: ['pipe', 'inherit', 'inherit'],
  });

  console.log('[migrate] done');
  } // end runBqLoad
});

console.log(`[migrate] streaming ${XML_PATH} ...`);
fs.createReadStream(XML_PATH, { encoding: 'utf8' }).pipe(parser);
