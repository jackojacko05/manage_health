/**
 * Apple Health → Notion 同期スクリプト
 *
 * 使い方:
 *   # parse-health-export.ts の出力を stdin に渡す
 *   npm run parse:health -- ~/Downloads/apple_health_export/export.xml | npm run sync:health
 *
 *   # ファイル経由
 *   npm run parse:health -- ~/Downloads/apple_health_export/export.xml > /tmp/health.json
 *   npm run sync:health < /tmp/health.json
 *
 * 動作:
 *   1. 日別の健康データ（DailyHealth）を健康ログ DB に upsert
 *      ※ あすけん由来プロパティ（食事アドバイス等）は上書きしない
 *   2. HRV サンプルを HRV記録 DB に append-only（startDate をユニークキーに）
 *
 * 終了コード:
 *   0: 成功
 *   10: 環境変数未設定
 *   11: Notion API エラー
 *   12: stdin JSON パース失敗
 */

import * as dotenv from 'dotenv';
import * as path from 'path';
import { updatePage, createPage, queryDatabase, P, getPropText } from './notion-api';
import {
  requireEnv,
  readStdinJson,
  upsertHealthLogByDate,
} from './lib/notion-sync';
import type { HealthExport, DailyHealth, HrvSample } from './types';

dotenv.config({ path: path.join(__dirname, '..', '.env') });

// ---- HealthKit 由来のプロパティのみ書き込む（ホワイトリスト） ----
function buildHealthProps(d: DailyHealth): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  if (d.bodyMass      !== undefined) props['体重']             = P.number(d.bodyMass);
  if (d.bodyFat       !== undefined) props['体脂肪率']          = P.number(Math.round(d.bodyFat * 1000) / 10); // 0.22 → 22.0
  if (d.leanBodyMass  !== undefined) props['除脂肪体重']        = P.number(d.leanBodyMass);
  if (d.steps         !== undefined) props['歩数']             = P.number(d.steps);
  if (d.distanceKm    !== undefined) props['距離']             = P.number(d.distanceKm);
  if (d.basalCalories !== undefined) props['安静時消費カロリー'] = P.number(d.basalCalories);
  if (d.avgHeartRate  !== undefined) props['平均心拍数']        = P.number(d.avgHeartRate);
  if (d.avgRespiratoryRate !== undefined) props['呼吸数']      = P.number(d.avgRespiratoryRate);
  if (d.avgOxygenSaturation !== undefined) props['血中酸素']   = P.number(d.avgOxygenSaturation);
  return props;
}

async function syncDailyHealth(
  token: string,
  dbHealthLog: string,
  d: DailyHealth
): Promise<{ date: string; created: boolean }> {
  const { page, created } = await upsertHealthLogByDate(token, dbHealthLog, d.date);

  const healthProps = buildHealthProps(d);
  if (Object.keys(healthProps).length > 0) {
    await updatePage(token, page.id, healthProps);
  }

  console.error(
    `[sync-health] ${d.date} ${created ? 'created' : 'updated'}: ` +
    `体重=${d.bodyMass ?? '-'} 歩数=${d.steps ?? '-'} HR=${d.avgHeartRate ?? '-'}`
  );
  return { date: d.date, created };
}

async function syncHrvSamples(
  token: string,
  dbHealthLog: string,
  dbHrv: string,
  samples: HrvSample[]
): Promise<{ created: number; skipped: number }> {
  // 健康ログページを日付ごとにキャッシュ
  const pageCache = new Map<string, string>();  // date → page.id

  async function getHealthLogId(date: string): Promise<string> {
    if (pageCache.has(date)) return pageCache.get(date)!;
    const { page } = await upsertHealthLogByDate(token, dbHealthLog, date);
    pageCache.set(date, page.id);
    return page.id;
  }

  // 既存の HRV レコードの計測ID を全件取得（タイトル）
  // 件数が多い場合は queryDatabase がページネーションで全件取る
  console.error(`[sync-health] HRV: 既存レコードを確認中...`);
  const existingHrv = await queryDatabase(token, dbHrv);
  const existingIds = new Set(
    existingHrv.map((p) => getPropText(p, '計測ID')).filter(Boolean)
  );
  console.error(`[sync-health] HRV: 既存 ${existingIds.size} 件`);

  let created = 0;
  let skipped = 0;

  for (const s of samples) {
    if (existingIds.has(s.startDate)) {
      skipped++;
      continue;
    }
    const date = s.startDate.slice(0, 10);
    const healthLogId = await getHealthLogId(date);

    await createPage(token, dbHrv, {
      '計測ID':   P.title(s.startDate),
      '日付':     P.relation([healthLogId]),
      '計測時刻': P.date(s.startDate),
      'SDNN':     P.number(s.sdnn),
      'ソース':   P.richText(s.source),
    });
    existingIds.add(s.startDate);
    created++;
    if (created % 10 === 0) {
      console.error(`[sync-health] HRV: ${created} 件追加済み...`);
    }
  }

  return { created, skipped };
}

async function main() {
  const env = requireEnv([
    'NOTION_TOKEN',
    'NOTION_DB_HEALTH_LOG',
    'NOTION_DB_HRV_RECORD',
  ]);
  const token      = env.NOTION_TOKEN;
  const dbHealthLog = env.NOTION_DB_HEALTH_LOG;
  const dbHrv      = env.NOTION_DB_HRV_RECORD;

  const input = await readStdinJson<HealthExport>();
  if (!Array.isArray(input.dailies) || !Array.isArray(input.hrv)) {
    console.error('[sync-health] ERROR: 入力 JSON が HealthExport 形式ではありません');
    process.exit(12);
  }

  console.error(
    `[sync-health] Input: ${input.dailies.length} days, ${input.hrv.length} HRV samples`
  );

  try {
    // 1. 日別健康データを同期
    let healthCreated = 0;
    let healthUpdated = 0;
    for (const d of input.dailies) {
      const r = await syncDailyHealth(token, dbHealthLog, d);
      if (r.created) healthCreated++; else healthUpdated++;
    }
    console.error(
      `[sync-health] 健康ログ: ${healthCreated} 件作成, ${healthUpdated} 件更新`
    );

    // 2. HRV サンプルを同期
    let hrvResult = { created: 0, skipped: 0 };
    if (input.hrv.length > 0) {
      hrvResult = await syncHrvSamples(token, dbHealthLog, dbHrv, input.hrv);
      console.error(
        `[sync-health] HRV: +${hrvResult.created} 件追加, ${hrvResult.skipped} 件スキップ`
      );
    }

    const summary = {
      health: { days: input.dailies.length, created: healthCreated, updated: healthUpdated },
      hrv: { total: input.hrv.length, created: hrvResult.created, skipped: hrvResult.skipped },
    };
    process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
    console.error('[sync-health] 完了');
  } catch (e: any) {
    console.error('[sync-health] ERROR (Notion API):', e.message);
    process.exit(11);
  }
}

main().catch((e) => {
  console.error('[sync-health] FATAL:', e);
  process.exit(1);
});
