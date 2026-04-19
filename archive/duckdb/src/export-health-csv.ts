/**
 * HealthExport JSON → Notion インポート用 CSV
 *
 * 使い方:
 *   npm run parse:health -- ~/Downloads/apple_health_export/export.xml > /tmp/health.json
 *   npx tsx src/export-health-csv.ts < /tmp/health.json > /tmp/health.csv
 *
 * 出力 CSV のカラムは Notion「健康ログ」DB の列名に一致：
 *   日付, 記録日, 体重, 体脂肪率, 除脂肪体重, 身長, BMI,
 *   歩数, 距離, 安静時消費カロリー, 平均心拍数, 呼吸数, 血中酸素
 *
 * Notion へのインポート手順:
 *   1. 健康ログ DB を開く
 *   2. 右上「...」→「Merge with CSV」（既存行は 日付 タイトル一致で更新、なければ追加）
 *   3. 生成した /tmp/health.csv をアップロード
 */

import { readStdinJson } from './lib/notion-sync';
import type { HealthExport, DailyHealth } from './types';

const COLUMNS: { key: keyof DailyHealth | '記録日'; header: string }[] = [
  // 日付 (title) は別で出す
  { key: '記録日',             header: '記録日' },
  { key: 'bodyMass',            header: '体重' },
  { key: 'bodyFat',             header: '体脂肪率' },
  { key: 'leanBodyMass',        header: '除脂肪体重' },
  { key: 'height',              header: '身長' },
  { key: 'bmi',                 header: 'BMI' },
  { key: 'steps',               header: '歩数' },
  { key: 'distanceKm',          header: '距離' },
  { key: 'basalCalories',       header: '安静時消費カロリー' },
  { key: 'avgHeartRate',        header: '平均心拍数' },
  { key: 'avgRespiratoryRate',  header: '呼吸数' },
  { key: 'avgOxygenSaturation', header: '血中酸素' },
];

function csvEscape(s: string): string {
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function formatNumber(n: number | undefined): string {
  if (n === undefined || n === null || Number.isNaN(n)) return '';
  return String(n);
}

async function main() {
  const input = await readStdinJson<HealthExport>();
  if (!Array.isArray(input.dailies)) {
    console.error('[export-csv] ERROR: 入力 JSON に dailies 配列がありません');
    process.exit(12);
  }

  // ヘッダー
  const headers = ['日付', ...COLUMNS.map((c) => c.header)];
  process.stdout.write(headers.join(',') + '\n');

  for (const d of input.dailies) {
    const row: string[] = [csvEscape(d.date)];
    for (const col of COLUMNS) {
      if (col.key === '記録日') {
        row.push(csvEscape(d.date));
      } else {
        const v = d[col.key as keyof DailyHealth];
        if (col.key === 'bodyFat' && typeof v === 'number') {
          // 0.22 → 22.0 に変換（Notion 側は %表示なので実数で）
          row.push(formatNumber(Math.round(v * 1000) / 10));
        } else if (typeof v === 'number') {
          row.push(formatNumber(v));
        } else {
          row.push('');
        }
      }
    }
    process.stdout.write(row.join(',') + '\n');
  }

  console.error(`[export-csv] ${input.dailies.length} 行を出力しました`);
}

main().catch((e) => {
  console.error('[export-csv] FATAL:', e);
  process.exit(1);
});
