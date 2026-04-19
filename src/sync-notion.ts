/**
 * Notion同期スクリプト（あすけん食事データ）
 *
 * 使い方:
 *   # 単独実行（scrape結果をstdinから読む）
 *   npx tsx src/scrape-asken.ts | npx tsx src/sync-notion.ts
 *
 *   # ワンショット
 *   npm run sync
 *
 * 動作:
 *   stdin JSON (DailyMeals | DailyMeals[]) を読み込み、Notionに差分書き込み:
 *   1. 健康ログDBに当日エントリをupsert
 *   2. foods[] のうち、ハッシュが既存にないものを食事記録DBに作成
 *   3. meals[] のうち、ハッシュが既存にないものを食事サマリDBに作成
 *
 * 終了コード:
 *   0: 成功（差分ゼロでも成功）
 *   10: 設定エラー（NOTION_TOKEN未設定など）
 *   11: Notion API エラー
 *   12: 入力JSONパースエラー
 */

import * as dotenv from 'dotenv';
import * as path from 'path';
import { updatePage, P } from './notion-api';
import {
  requireEnv,
  readStdinJson,
  nowJstIso,
  nowJstHHmm,
  hash,
  upsertHealthLogByDate,
  appendByHash,
  AppendItem,
} from './lib/notion-sync';
import type { DailyMeals, FoodEntry, MealSummary } from './types';

dotenv.config({ path: path.join(__dirname, '..', '.env') });

function foodHash(e: FoodEntry): string {
  return hash([e.division, e.name, e.quantity]);
}

function mealHash(m: MealSummary): string {
  return hash([m.division, m.calories, m.protein, m.fat, m.carbs, m.fiber]);
}

async function main() {
  const env = requireEnv([
    'NOTION_TOKEN',
    'NOTION_DB_HEALTH_LOG',
    'NOTION_DB_FOOD_RECORD',
    'NOTION_DB_MEAL_SUMMARY',
  ]);

  const token         = env.NOTION_TOKEN;
  const dbHealthLog   = env.NOTION_DB_HEALTH_LOG;
  const dbFoodRecord  = env.NOTION_DB_FOOD_RECORD;
  const dbMealSummary = env.NOTION_DB_MEAL_SUMMARY;

  const parsed = await readStdinJson<DailyMeals | DailyMeals[]>();
  const days: DailyMeals[] = Array.isArray(parsed) ? parsed : [parsed];
  for (const d of days) {
    if (!d.date || !Array.isArray(d.foods) || !Array.isArray(d.meals)) {
      console.error(`[sync-notion] ERROR: Invalid shape for ${d.date ?? '(no date)'}`);
      process.exit(12);
    }
  }

  console.error(`[sync-notion] ${days.length} day${days.length > 1 ? 's' : ''} to sync`);

  try {
    const summaries = [];
    for (const input of days) {
      summaries.push(await syncOneDay(token, dbHealthLog, dbFoodRecord, dbMealSummary, input));
    }
    process.stdout.write(
      JSON.stringify(summaries.length === 1 ? summaries[0] : summaries, null, 2) + '\n'
    );
    const totals = summaries.reduce(
      (acc, s) => ({
        foodsCreated: acc.foodsCreated + s.foods.created,
        mealsCreated: acc.mealsCreated + s.meals.created,
      }),
      { foodsCreated: 0, mealsCreated: 0 }
    );
    console.error(
      `[sync-notion] All done. foods +${totals.foodsCreated}, meals +${totals.mealsCreated} across ${summaries.length} day(s)`
    );
  } catch (e: any) {
    console.error('[sync-notion] ERROR (Notion API):', e.message);
    process.exit(11);
  }
}

interface SyncSummary {
  date: string;
  foods: { total: number; created: number; skipped: number };
  meals: { total: number; created: number; skipped: number };
}

async function syncOneDay(
  token: string,
  dbHealthLog: string,
  dbFoodRecord: string,
  dbMealSummary: string,
  input: DailyMeals
): Promise<SyncSummary> {
  const dateStr = input.date;
  console.error(
    `[sync-notion] ===== ${dateStr} (foods=${input.foods.length} meals=${input.meals.length}) =====`
  );

  // 1. 健康ログ upsert
  const createProps: Record<string, unknown> = {};
  if (input.dailyAdvice) createProps['食事アドバイス'] = P.richText(input.dailyAdvice);

  const { page: healthLogPage, created } = await upsertHealthLogByDate(
    token, dbHealthLog, dateStr, createProps
  );

  if (created) {
    console.error(`[sync-notion] Created 健康ログ for ${dateStr}`);
  } else {
    console.error(`[sync-notion] 健康ログ exists for ${dateStr}`);
    if (input.dailyAdvice) {
      await updatePage(token, healthLogPage.id, {
        食事アドバイス: P.richText(input.dailyAdvice),
      });
      console.error(`[sync-notion] Updated 食事アドバイス on 健康ログ`);
    }
  }

  // 2. 食事記録（foods）差分追加
  const foodItems: AppendItem[] = input.foods.map((food) => ({
    hash: foodHash(food),
    label: `食事記録: ${food.division} ${food.name} ${food.calories}kcal`,
    buildProps: () => ({
      エントリID: P.title(`${dateStr} ${nowJstHHmm()} ${food.name}`),
      検出時刻: P.date(nowJstIso()),
      食事区分: P.select(food.division),
      メニュー名: P.richText(food.name),
      カロリー: P.number(food.calories),
      ハッシュ: P.richText(foodHash(food)),
      日付: P.relation([healthLogPage.id]),
    }),
  }));

  const foodResult = await appendByHash(
    token, dbFoodRecord, healthLogPage.id, 'ハッシュ', '日付', foodItems
  );

  // 3. 食事サマリ（meals）差分追加
  const mealItems: AppendItem[] = input.meals.map((meal) => ({
    hash: mealHash(meal),
    label: `食事サマリ: ${meal.division} ${meal.calories}kcal P${meal.protein}/F${meal.fat}/C${meal.carbs}`,
    buildProps: () => {
      const props: Record<string, unknown> = {
        エントリID: P.title(`${dateStr} ${nowJstHHmm()} ${meal.division}`),
        更新時刻: P.date(nowJstIso()),
        食事区分: P.select(meal.division),
        カロリー: P.number(meal.calories),
        タンパク質: P.number(meal.protein),
        脂質: P.number(meal.fat),
        炭水化物: P.number(meal.carbs),
        食物繊維: P.number(meal.fiber),
        ハッシュ: P.richText(mealHash(meal)),
        日付: P.relation([healthLogPage.id]),
      };
      if (meal.advice) props['アドバイス'] = P.richText(meal.advice);
      return props;
    },
  }));

  const mealResult = await appendByHash(
    token, dbMealSummary, healthLogPage.id, 'ハッシュ', '日付', mealItems
  );

  console.error(
    `[sync-notion] ${dateStr} done: foods +${foodResult.created}, meals +${mealResult.created}`
  );

  return {
    date: dateStr,
    foods: { total: input.foods.length, created: foodResult.created, skipped: foodResult.skipped },
    meals: { total: input.meals.length, created: mealResult.created, skipped: mealResult.skipped },
  };
}

main().catch((e) => {
  console.error('[sync-notion] FATAL:', e);
  process.exit(1);
});
