/**
 * Apple Health → Notion 同期スクリプト
 *
 * 使い方:
 *   npm run parse:health -- ~/Downloads/apple_health_export/export.xml > /tmp/health.json
 *   npm run sync:health < /tmp/health.json
 *
 * 動作:
 *   1. 健康ログ DB の全既存日付を一括取得（クエリ1回）
 *   2. 日別データを並列（concurrency=5）で create / update
 *      ※ HealthKit 列のみ書き込む
 *   3. HRV サンプルを HRV記録 DB に append-only
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
import { requireEnv, readStdinJson } from './lib/notion-sync';
import type { HealthExport, DailyHealth, HrvSample } from './types';

dotenv.config({ path: path.join(__dirname, '..', '.env') });

const CONCURRENCY = 5;

// ---- 並列制御 ----
async function pMap<T, R>(
  items: T[],
  fn: (item: T, index: number) => Promise<R>,
  concurrency: number
): Promise<R[]> {
  const results: R[] = [];
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return results;
}

// ---- HealthKit 由来プロパティ（ホワイトリスト） ----
function buildHealthProps(d: DailyHealth): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  if (d.bodyMass      !== undefined) props['体重']             = P.number(d.bodyMass);
  if (d.bodyFat       !== undefined) props['体脂肪率']          = P.number(Math.round(d.bodyFat * 1000) / 10);
  if (d.leanBodyMass  !== undefined) props['除脂肪体重']        = P.number(d.leanBodyMass);
  if (d.steps         !== undefined) props['歩数']             = P.number(d.steps);
  if (d.distanceKm    !== undefined) props['距離']             = P.number(d.distanceKm);
  if (d.basalCalories !== undefined) props['安静時消費カロリー'] = P.number(d.basalCalories);
  if (d.avgHeartRate  !== undefined) props['平均心拍数']        = P.number(d.avgHeartRate);
  if (d.avgRespiratoryRate !== undefined) props['呼吸数']      = P.number(d.avgRespiratoryRate);
  if (d.avgOxygenSaturation !== undefined) props['血中酸素']   = P.number(d.avgOxygenSaturation);
  return props;
}

async function main() {
  const env = requireEnv([
    'NOTION_TOKEN',
    'NOTION_DB_HEALTH_LOG',
    'NOTION_DB_HRV_RECORD',
  ]);
  const token       = env.NOTION_TOKEN;
  const dbHealthLog = env.NOTION_DB_HEALTH_LOG;
  const dbHrv       = env.NOTION_DB_HRV_RECORD;

  const input = await readStdinJson<HealthExport>();
  if (!Array.isArray(input.dailies) || !Array.isArray(input.hrv)) {
    console.error('[sync-health] ERROR: 入力 JSON が HealthExport 形式ではありません');
    process.exit(12);
  }
  console.error(`[sync-health] Input: ${input.dailies.length} days, ${input.hrv.length} HRV samples`);

  try {
    // ---- 1. 健康ログ DB の全既存ページを一括取得 ----
    console.error('[sync-health] 既存の健康ログを一括取得中...');
    const existingPages = await queryDatabase(token, dbHealthLog);
    // date → { id, exists }
    const pageMap = new Map<string, string>(); // date → pageId
    for (const p of existingPages) {
      const d = getPropText(p, '日付');
      if (d) pageMap.set(d, p.id);
    }
    console.error(`[sync-health] 既存: ${pageMap.size} 件`);

    // ---- 2. 日別データを並列 upsert ----
    let created = 0;
    let updated = 0;
    let done = 0;
    const total = input.dailies.length;

    await pMap(input.dailies, async (d) => {
      const healthProps = buildHealthProps(d);
      let pageId = pageMap.get(d.date);
      if (!pageId) {
        // 新規作成
        const page = await createPage(token, dbHealthLog, {
          日付: P.title(d.date),
          記録日: P.date(d.date),
          ...healthProps,
        });
        pageMap.set(d.date, page.id);
        created++;
      } else {
        // 既存を update（HealthKit 列のみ）
        if (Object.keys(healthProps).length > 0) {
          await updatePage(token, pageId, healthProps);
        }
        updated++;
      }
      done++;
      if (done % 100 === 0 || done === total) {
        console.error(`[sync-health] 健康ログ: ${done}/${total} (作成${created} 更新${updated})`);
      }
    }, CONCURRENCY);

    console.error(`[sync-health] 健康ログ完了: ${created} 件作成, ${updated} 件更新`);

    // ---- 3. HRV サンプルを append-only ----
    let hrvCreated = 0;
    let hrvSkipped = 0;
    if (input.hrv.length > 0) {
      console.error('[sync-health] HRV: 既存レコードを一括取得中...');
      const existingHrv = await queryDatabase(token, dbHrv);
      const existingIds = new Set(
        existingHrv.map((p) => getPropText(p, '計測ID')).filter(Boolean)
      );
      console.error(`[sync-health] HRV: 既存 ${existingIds.size} 件`);

      const newSamples = input.hrv.filter((s) => !existingIds.has(s.startDate));
      hrvSkipped = input.hrv.length - newSamples.length;

      await pMap(newSamples, async (s) => {
        const date = s.startDate.slice(0, 10);
        let healthLogId = pageMap.get(date);
        if (!healthLogId) {
          const page = await createPage(token, dbHealthLog, {
            日付: P.title(date),
            記録日: P.date(date),
          });
          pageMap.set(date, page.id);
          healthLogId = page.id;
        }
        await createPage(token, dbHrv, {
          '計測ID':   P.title(s.startDate),
          '日付':     P.relation([healthLogId]),
          '計測時刻': P.date(s.startDate),
          'SDNN':     P.number(s.sdnn),
          'ソース':   P.richText(s.source),
        });
        hrvCreated++;
        if (hrvCreated % 50 === 0) {
          console.error(`[sync-health] HRV: ${hrvCreated}/${newSamples.length} 追加済み`);
        }
      }, CONCURRENCY);

      console.error(`[sync-health] HRV: +${hrvCreated} 追加, ${hrvSkipped} スキップ`);
    }

    const summary = {
      health: { days: total, created, updated },
      hrv: { total: input.hrv.length, created: hrvCreated, skipped: hrvSkipped },
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
