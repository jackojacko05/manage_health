/**
 * Notion同期スクリプト
 *
 * 使い方:
 *   # 単独実行（scrape結果をstdinから読む）
 *   npx tsx src/scrape-asken.ts | npx tsx src/sync-notion.ts
 *
 *   # ワンショット
 *   npm run sync
 *
 * 動作:
 *   stdin JSON (DailyMeals) を読み込み、Notionに差分書き込み:
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
import * as crypto from 'crypto';
import { queryDatabase, createPage, P, getPropText, NotionPage } from './notion-api';
import type { DailyMeals, FoodEntry, MealSummary } from './types';

dotenv.config({ path: path.join(__dirname, '..', '.env') });

// ---- DB IDs (CLAUDE.mdの値) ----
const DB = {
  healthLog: '69b6d762-8fc3-4d84-8292-32d8f8605998',
  foodRecord: '8cc7bf9d-ee58-46e2-a732-9dab077f6b70',
  mealSummary: '8cb932fa-4f23-42de-aadb-190fee05f5dd',
};

function hash(parts: (string | number)[]): string {
  return crypto.createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 8);
}

function foodHash(e: FoodEntry): string {
  return hash([e.division, e.name, e.quantity]);
}

function mealHash(m: MealSummary): string {
  return hash([m.division, m.calories, m.protein, m.fat, m.carbs, m.fiber]);
}

function nowJstIso(): string {
  // e.g. "2026-04-18T19:05:23+09:00"
  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    jst.getUTCFullYear() +
    '-' +
    pad(jst.getUTCMonth() + 1) +
    '-' +
    pad(jst.getUTCDate()) +
    'T' +
    pad(jst.getUTCHours()) +
    ':' +
    pad(jst.getUTCMinutes()) +
    ':' +
    pad(jst.getUTCSeconds()) +
    '+09:00'
  );
}

function nowJstHHmm(): string {
  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return pad(jst.getUTCHours()) + ':' + pad(jst.getUTCMinutes());
}

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

async function main() {
  const token = process.env.NOTION_TOKEN;
  if (!token) {
    console.error('[sync-notion] ERROR: NOTION_TOKEN not set in .env');
    process.exit(10);
  }

  // ---- Parse stdin JSON ----
  let input: DailyMeals;
  try {
    const raw = await readStdin();
    input = JSON.parse(raw);
    if (!input.date || !Array.isArray(input.foods) || !Array.isArray(input.meals)) {
      throw new Error('Invalid shape');
    }
  } catch (e: any) {
    console.error('[sync-notion] ERROR: Failed to parse stdin JSON:', e.message);
    process.exit(12);
  }

  const dateStr = input.date;
  console.error(
    `[sync-notion] date=${dateStr} foods=${input.foods.length} meals=${input.meals.length}`
  );

  try {
    // ---- 1. 健康ログ: upsert 当日エントリ ----
    const existingHealthLogs = await queryDatabase(token, DB.healthLog, {
      property: '日付',
      title: { equals: dateStr },
    });
    let healthLogPage: NotionPage;
    if (existingHealthLogs.length === 0) {
      healthLogPage = await createPage(token, DB.healthLog, {
        日付: P.title(dateStr),
        記録日: P.date(dateStr, false),
      });
      console.error(`[sync-notion] Created 健康ログ for ${dateStr}`);
    } else {
      healthLogPage = existingHealthLogs[0];
      console.error(`[sync-notion] 健康ログ exists for ${dateStr}`);
    }

    // ---- 2. 食事記録: 当日の既存ハッシュSet ----
    const existingFoods = await queryDatabase(token, DB.foodRecord, {
      property: '日付',
      relation: { contains: healthLogPage.id },
    });
    const existingFoodHashes = new Set(
      existingFoods.map((p) => getPropText(p, 'ハッシュ')).filter(Boolean)
    );

    // ---- 3. foods[] を差分作成 ----
    let foodsCreated = 0;
    for (const food of input.foods) {
      const h = foodHash(food);
      if (existingFoodHashes.has(h)) continue;
      const title = `${dateStr} ${nowJstHHmm()} ${food.name}`;
      await createPage(token, DB.foodRecord, {
        エントリID: P.title(title),
        検出時刻: P.date(nowJstIso(), true),
        食事区分: P.select(food.division),
        メニュー名: P.richText(food.name),
        カロリー: P.number(food.calories),
        ハッシュ: P.richText(h),
        日付: P.relation([healthLogPage.id]),
      });
      foodsCreated++;
      console.error(`[sync-notion]  + 食事記録: ${food.division} ${food.name} ${food.calories}kcal`);
    }

    // ---- 4. 食事サマリ: 当日の既存ハッシュSet ----
    const existingMeals = await queryDatabase(token, DB.mealSummary, {
      property: '日付',
      relation: { contains: healthLogPage.id },
    });
    const existingMealHashes = new Set(
      existingMeals.map((p) => getPropText(p, 'ハッシュ')).filter(Boolean)
    );

    // ---- 5. meals[] を差分作成 ----
    let mealsCreated = 0;
    for (const meal of input.meals) {
      const h = mealHash(meal);
      if (existingMealHashes.has(h)) continue;
      const title = `${dateStr} ${nowJstHHmm()} ${meal.division}`;
      await createPage(token, DB.mealSummary, {
        エントリID: P.title(title),
        更新時刻: P.date(nowJstIso(), true),
        食事区分: P.select(meal.division),
        カロリー: P.number(meal.calories),
        タンパク質: P.number(meal.protein),
        脂質: P.number(meal.fat),
        炭水化物: P.number(meal.carbs),
        食物繊維: P.number(meal.fiber),
        ハッシュ: P.richText(h),
        日付: P.relation([healthLogPage.id]),
      });
      mealsCreated++;
      console.error(
        `[sync-notion]  + 食事サマリ: ${meal.division} ${meal.calories}kcal P${meal.protein}/F${meal.fat}/C${meal.carbs}`
      );
    }

    // ---- 6. サマリ出力（stdout, JSON） ----
    const summary = {
      date: dateStr,
      foods: { total: input.foods.length, created: foodsCreated, skipped: input.foods.length - foodsCreated },
      meals: { total: input.meals.length, created: mealsCreated, skipped: input.meals.length - mealsCreated },
    };
    process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
    console.error(`[sync-notion] Done. foods +${foodsCreated}, meals +${mealsCreated}`);
  } catch (e: any) {
    console.error('[sync-notion] ERROR (Notion API):', e.message);
    process.exit(11);
  }
}

main().catch((e) => {
  console.error('[sync-notion] FATAL:', e);
  process.exit(1);
});
