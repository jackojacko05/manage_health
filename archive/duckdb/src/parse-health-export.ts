/**
 * Apple Health export.xml パーサー
 *
 * 使い方:
 *   npx tsx src/parse-health-export.ts <path/to/export.xml> [--from YYYY-MM-DD] [--to YYYY-MM-DD]
 *
 * 出力 (stdout):
 *   HealthExport JSON
 *     { dailies: DailyHealth[], hrv: HrvSample[] }
 *
 * 終了コード:
 *   0: 成功
 *   1: 引数不正 / ファイル読み込みエラー
 */

import * as fs from 'fs';
import * as sax from 'sax';
import type { DailyHealth, HrvSample, HealthExport } from './types';

// ---- 対象 HealthKit Record type ----
const TARGET_TYPES = new Set([
  'HKQuantityTypeIdentifierBodyMass',
  'HKQuantityTypeIdentifierBodyFatPercentage',
  'HKQuantityTypeIdentifierLeanBodyMass',
  'HKQuantityTypeIdentifierHeight',
  'HKQuantityTypeIdentifierBodyMassIndex',
  'HKQuantityTypeIdentifierStepCount',
  'HKQuantityTypeIdentifierDistanceWalkingRunning',
  'HKQuantityTypeIdentifierBasalEnergyBurned',
  'HKQuantityTypeIdentifierHeartRate',
  'HKQuantityTypeIdentifierRespiratoryRate',
  'HKQuantityTypeIdentifierOxygenSaturation',
  'HKQuantityTypeIdentifierHeartRateVariabilitySDNN',
]);

// ---- ユーティリティ ----

/** HealthKit の日時文字列（"2024-04-01 09:30:00 +0900"）を YYYY-MM-DD (JST) に変換 */
function toDateJst(hkDate: string): string {
  // フォーマット: "2024-04-01 09:30:00 +0900"
  // JST として扱う（+0900 固定）
  return hkDate.slice(0, 10);
}

/** HKQuantityTypeIdentifier の suffix を返す */
function typeKey(type: string): string {
  return type.replace('HKQuantityTypeIdentifier', '').replace('HKCategoryTypeIdentifier', '');
}

// ---- メイン ----

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args[0] === '--help') {
    console.error('Usage: parse-health-export.ts <export.xml> [--from YYYY-MM-DD] [--to YYYY-MM-DD]');
    process.exit(1);
  }

  const xmlPath = args[0];
  let fromDate = '';
  let toDate = '';
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--from' && args[i + 1]) { fromDate = args[++i]; }
    if (args[i] === '--to'   && args[i + 1]) { toDate   = args[++i]; }
  }

  if (!fs.existsSync(xmlPath)) {
    console.error(`[parse-health] ERROR: File not found: ${xmlPath}`);
    process.exit(1);
  }

  // 日別アキュムレーター
  const dailyMap = new Map<string, {
    bodyMassVals: { t: string; v: number }[];
    bodyFatVals:  { t: string; v: number }[];
    leanMassVals: { t: string; v: number }[];
    heightVals:   { t: string; v: number }[];
    bmiVals:      { t: string; v: number }[];
    steps: number;
    distanceKm: number;
    basalCalories: number;
    hrSamples: number[];
    rrSamples: number[];
    spo2Samples: number[];
  }>();

  const hrvSamples: HrvSample[] = [];

  function getDay(date: string) {
    if (!dailyMap.has(date)) {
      dailyMap.set(date, {
        bodyMassVals: [], bodyFatVals: [], leanMassVals: [],
        heightVals: [], bmiVals: [],
        steps: 0, distanceKm: 0, basalCalories: 0,
        hrSamples: [], rrSamples: [], spo2Samples: [],
      });
    }
    return dailyMap.get(date)!;
  }

  // ---- SAX streaming parse ----
  await new Promise<void>((resolve, reject) => {
    const parser = sax.createStream(true /* strict */, { trim: true });

    parser.on('opentag', (node) => {
      if (node.name !== 'Record') return;
      const attrs = node.attributes as Record<string, string>;
      const type  = attrs['type'] ?? '';
      if (!TARGET_TYPES.has(type)) return;

      const startDate = attrs['startDate'] ?? '';
      const valueStr  = attrs['value'] ?? '';
      const value     = parseFloat(valueStr);
      if (isNaN(value)) return;

      const date = toDateJst(startDate);
      if (fromDate && date < fromDate) return;
      if (toDate   && date > toDate)   return;

      const k = typeKey(type);
      const day = getDay(date);

      switch (k) {
        case 'BodyMass':
          day.bodyMassVals.push({ t: startDate, v: value }); break;
        case 'BodyFatPercentage':
          day.bodyFatVals.push({ t: startDate, v: value }); break;
        case 'LeanBodyMass':
          day.leanMassVals.push({ t: startDate, v: value }); break;
        case 'Height': {
          // cm に正規化（unit が m なら *100）
          const unit = attrs['unit'] ?? 'cm';
          const v = unit === 'm' ? value * 100 : value;
          day.heightVals.push({ t: startDate, v });
          break;
        }
        case 'BodyMassIndex':
          day.bmiVals.push({ t: startDate, v: value }); break;
        case 'StepCount':
          day.steps += value; break;
        case 'DistanceWalkingRunning': {
          const unit = attrs['unit'] ?? 'km';
          day.distanceKm += unit === 'mi' ? value * 1.60934 : value;
          break;
        }
        case 'BasalEnergyBurned':
          day.basalCalories += value; break;
        case 'HeartRate':
          day.hrSamples.push(value); break;
        case 'RespiratoryRate':
          day.rrSamples.push(value); break;
        case 'OxygenSaturation':
          // 0-1 の場合は %に変換
          day.spo2Samples.push(value <= 1 ? value * 100 : value); break;
        case 'HeartRateVariabilitySDNN':
          hrvSamples.push({
            startDate,
            sdnn: value,
            source: attrs['sourceName'] ?? '',
          });
          break;
      }
    });

    parser.on('end', resolve);
    parser.on('error', (e) => {
      // SAX は DOCTYPE/entity エラーを出すことがある。無視して続行
      (parser as any)._parser.error = null;
      (parser as any)._parser.resume();
    });

    fs.createReadStream(xmlPath, { encoding: 'utf8' }).pipe(parser);
  });

  // ---- 集計 ----
  function latest<T extends { t: string; v: number }>(arr: T[]): number | undefined {
    if (arr.length === 0) return undefined;
    return arr.reduce((a, b) => (a.t >= b.t ? a : b)).v;
  }
  function avg(arr: number[]): number | undefined {
    if (arr.length === 0) return undefined;
    return Math.round((arr.reduce((a, b) => a + b, 0) / arr.length) * 10) / 10;
  }
  function round2(n: number): number {
    return Math.round(n * 100) / 100;
  }

  const sortedDates = [...dailyMap.keys()].sort();
  const dailies: DailyHealth[] = sortedDates.map((date) => {
    const d = dailyMap.get(date)!;
    const entry: DailyHealth = { date };
    const bm = latest(d.bodyMassVals);
    if (bm !== undefined)  entry.bodyMass = round2(bm);
    const bf = latest(d.bodyFatVals);
    if (bf !== undefined)  entry.bodyFat = round2(bf);
    const lm = latest(d.leanMassVals);
    if (lm !== undefined)  entry.leanBodyMass = round2(lm);
    const ht = latest(d.heightVals);
    if (ht !== undefined)  entry.height = round2(ht);
    const bmi = latest(d.bmiVals);
    if (bmi !== undefined) entry.bmi = round2(bmi);
    if (d.steps > 0)       entry.steps = Math.round(d.steps);
    if (d.distanceKm > 0)  entry.distanceKm = round2(d.distanceKm);
    if (d.basalCalories > 0) entry.basalCalories = Math.round(d.basalCalories);
    const hr = avg(d.hrSamples);
    if (hr !== undefined)  entry.avgHeartRate = hr;
    const rr = avg(d.rrSamples);
    if (rr !== undefined)  entry.avgRespiratoryRate = rr;
    const sp = avg(d.spo2Samples);
    if (sp !== undefined)  entry.avgOxygenSaturation = sp;
    return entry;
  });

  // HRV は startDate でソート
  hrvSamples.sort((a, b) => a.startDate.localeCompare(b.startDate));

  const output: HealthExport = { dailies, hrv: hrvSamples };
  process.stdout.write(JSON.stringify(output, null, 2) + '\n');
  console.error(
    `[parse-health] Done: ${dailies.length} days, ${hrvSamples.length} HRV samples`
  );
}

main().catch((e) => {
  console.error('[parse-health] FATAL:', e);
  process.exit(1);
});
