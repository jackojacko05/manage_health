/**
 * あすけん 食事記録スクレイパー
 *
 * 使い方:
 *   npx tsx src/scrape-asken.ts          # headless
 *   npx tsx src/scrape-asken.ts --debug  # headful（初回ログイン・デバッグ用）
 *
 * 出力: JSON → stdout
 * ログ: → stderr
 *
 * データソース:
 *   - /wsp/comment/YYYY-MM-DD : 食品単位 (name, quantity, calories)
 *   - /wsp/advice/YYYY-MM-DD/{3,4,5} : 食事単位の栄養素 (朝/昼/夕)
 *   - 間食はカロリーのみ（commentページ合計）
 */

import { chromium, type Page, type BrowserContext } from 'playwright';
import * as dotenv from 'dotenv';
import * as path from 'path';
import * as crypto from 'crypto';
import {
  storageStateExists,
  getStorageStatePath,
  saveStorageState,
} from './auth';
import type {
  DailyMeals,
  FoodEntry,
  MealDivision,
  MealSummary,
} from './types';

dotenv.config({ path: path.join(__dirname, '..', '.env') });

const DEBUG = process.argv.includes('--debug');
// 日付引数（複数可・順不同）
//   0個: effectiveToday() を from=to で使う
//   1個: from=to=その日
//   2個以上: ソートして [from, to] の範囲
const DATE_ARGS = process.argv
  .filter((a) => /^\d{4}-\d{2}-\d{2}$/.test(a))
  .sort();

// 終了コード分類（skillのフォールバック判断に使う）:
//   0: 成功
//   1: 汎用エラー
//   2: ログイン必要（セッション失効・認証情報不足） → ユーザーに再ログイン依頼
//   3: DOMパース失敗（構造変更の可能性） → Opus+Playwrightに修復依頼
class ScrapeError extends Error {
  constructor(public code: number, message: string) {
    super(message);
  }
}

const LOGIN_URL = 'https://www.asken.jp/login';
const COMMENT_URL = (date: string) => `https://www.asken.jp/wsp/comment/${date}`;
const ADVICE_URL = (date: string, mealId: number) =>
  `https://www.asken.jp/wsp/advice/${date}/${mealId}`;

const DIVISION_BY_ADVICE_ID: Record<number, MealDivision> = {
  3: '朝食',
  4: '昼食',
  5: '夕食',
};

const SECTION_KEY_BY_DIVISION: Record<MealDivision, string> = {
  朝食: 'breakfast',
  昼食: 'lunch',
  夕食: 'dinner',
  間食: 'sweets',
};

// 「実効的な今日」: 朝5時を日付境界とする
//   00:00〜04:59 に実行 → 前日扱い（例: 翌朝2時のcronで前日分を拾う）
//   05:00〜23:59 に実行 → 当日
function effectiveToday(): string {
  const d = new Date();
  if (d.getHours() < 5) {
    d.setDate(d.getDate() - 1);
  }
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// YYYY-MM-DD 文字列を指定日数だけシフトして返す
function shiftDate(dateStr: string, deltaDays: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + deltaDays);
  return (
    dt.getFullYear() +
    '-' + String(dt.getMonth() + 1).padStart(2, '0') +
    '-' + String(dt.getDate()).padStart(2, '0')
  );
}

// [from, to] の範囲を「新しい日付 → 古い日付」の順で1日ずつ返すイテレータ
function* dateRange(from: string, to: string): Generator<string> {
  let cur = to;
  while (cur >= from) {
    yield cur;
    if (cur === from) break;
    cur = shiftDate(cur, -1);
  }
}

function parseNumber(s: string): number {
  const n = parseFloat(s.replace(/[^0-9.]/g, ''));
  return isNaN(n) ? 0 : n;
}

export function makeFoodHash(entry: FoodEntry): string {
  const raw = `${entry.division}|${entry.name}|${entry.quantity}`;
  return crypto.createHash('sha1').update(raw).digest('hex').slice(0, 8);
}

export function makeMealHash(m: MealSummary): string {
  const raw = `${m.division}|${m.calories}|${m.protein}|${m.fat}|${m.carbs}|${m.fiber}`;
  return crypto.createHash('sha1').update(raw).digest('hex').slice(0, 8);
}

async function ensureLoggedIn(
  page: Page,
  context: BrowserContext,
  dateStr: string
): Promise<void> {
  await page.goto(COMMENT_URL(dateStr), { waitUntil: 'domcontentloaded' });
  if (!page.url().includes('/login') && !page.url().includes('/sign_in')) {
    return;
  }
  console.error('[scrape-asken] Session expired. Logging in...');

  if (!DEBUG) {
    const email = process.env.ASKEN_EMAIL;
    const password = process.env.ASKEN_PASSWORD;
    if (!email || !password) {
      throw new ScrapeError(
        2,
        'ASKEN_EMAIL/ASKEN_PASSWORD not set in .env (and storageState expired)'
      );
    }
    try {
      await page.goto(LOGIN_URL, { waitUntil: 'networkidle' });
      await page.fill('#CustomerMemberEmail', email);
      await page.fill('#CustomerMemberPasswdPlain', password);
      await page.click('#SubmitSubmit, input[type="image"]');
      await page.waitForURL((url) => !url.toString().includes('/login'), {
        timeout: 15000,
      });
    } catch (e: any) {
      throw new ScrapeError(2, `Auto-login failed: ${e.message}`);
    }
  } else {
    console.error('[scrape-asken] [DEBUG] Please log in manually.');
    await page.waitForURL((url) => !url.toString().includes('/login'), {
      timeout: 120000,
    });
  }

  await saveStorageState(context);
  console.error('[scrape-asken] Login complete.');
  await page.goto(COMMENT_URL(dateStr), { waitUntil: 'networkidle' });
}

async function scrapeFoods(
  page: Page,
  dateStr: string
): Promise<{ foods: FoodEntry[]; mealCalories: Record<MealDivision, number> }> {
  if (!page.url().includes('/wsp/comment')) {
    await page.goto(COMMENT_URL(dateStr), { waitUntil: 'networkidle' });
  }

  const data = await page.evaluate((keyMap: Record<string, string>) => {
    const result: Record<
      string,
      { calories: number; foods: Array<{ name: string; quantity: string; calories: number }>; sectionFound: boolean }
    > = {};
    for (const [div, key] of Object.entries(keyMap)) {
      const section = document.querySelector(`#karute_report_${key}`);
      if (!section) {
        result[div] = { calories: 0, foods: [], sectionFound: false };
        continue;
      }
      const sumText = section.querySelector('.sum_energy')?.textContent?.trim() ?? '';
      const cal = parseFloat(sumText.replace(/[^0-9.]/g, '')) || 0;
      const foods = Array.from(section.querySelectorAll('table.detail_table tr'))
        .map((tr) => {
          const name = tr.querySelector('td.name')?.textContent?.trim() ?? '';
          const quantity = tr.querySelector('td.quantity')?.textContent?.trim() ?? '';
          const energyText = tr.querySelector('td.energy')?.textContent?.trim() ?? '';
          const calories = parseFloat(energyText.replace(/[^0-9.]/g, '')) || 0;
          return { name, quantity, calories };
        })
        .filter((f) => f.name);
      result[div] = { calories: cal, foods, sectionFound: true };
    }
    return result;
  }, SECTION_KEY_BY_DIVISION as unknown as Record<string, string>);

  // DOM構造チェック: 4区分とも見つからない = ページ構造変更の可能性
  const anySection = (Object.values(data) as Array<{ sectionFound: boolean }>).some(
    (v) => v.sectionFound
  );
  if (!anySection) {
    throw new ScrapeError(
      3,
      `No meal sections found at ${page.url()}. DOM selectors (#karute_report_*) may have changed.`
    );
  }

  const foods: FoodEntry[] = [];
  const mealCalories: Record<MealDivision, number> = {
    朝食: 0,
    昼食: 0,
    夕食: 0,
    間食: 0,
  };
  for (const div of Object.keys(data) as MealDivision[]) {
    mealCalories[div] = data[div].calories;
    for (const f of data[div].foods) {
      foods.push({ division: div, name: f.name, quantity: f.quantity, calories: f.calories });
    }
  }
  return { foods, mealCalories };
}

function cleanAdviceText(raw: string): string {
  return raw
    .replace(/\s+/g, ' ')          // 連続空白・改行を1スペースに
    .replace(/^\s+|\s+$/g, '')     // 前後トリム
    .replace(/ (・)/g, '\n・')     // 箇条書きを改行で整形
    .trim();
}

async function scrapeAdviceTexts(page: Page): Promise<string> {
  const texts = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.text_advice'))
      .map((el) => el.textContent?.trim() ?? '')
      .filter((t) => t.length > 5)
  );
  return texts.map(cleanAdviceText).join('\n\n');
}

async function scrapeMealNutrients(
  page: Page,
  dateStr: string,
  mealId: number
): Promise<Omit<MealSummary, 'division'>> {
  await page.goto(ADVICE_URL(dateStr, mealId), { waitUntil: 'networkidle' });

  const nutrients = await page.evaluate(() => {
    const items: Array<{ title: string; val: string }> = [];
    document.querySelectorAll('li.line_left').forEach((li) => {
      const title = li.querySelector('li.title')?.textContent?.trim();
      const val = li.querySelector('li.val')?.textContent?.trim();
      if (title && val) items.push({ title, val });
    });
    return items;
  });

  const pick = (key: string): number => {
    const hit = nutrients.find((n) => n.title === key);
    if (!hit) return 0;
    const m = hit.val.match(/-?[\d.]+/);
    return m ? parseFloat(m[0]) : 0;
  };

  const advice = await scrapeAdviceTexts(page);

  return {
    calories: pick('エネルギー'),
    protein: pick('タンパク質'),
    fat: pick('脂質'),
    carbs: pick('炭水化物'),
    fiber: pick('食物繊維'),
    advice: advice || undefined,
  };
}

async function scrapeDailyAdvice(page: Page, dateStr: string): Promise<string> {
  await page.goto(`https://www.asken.jp/wsp/advice/${dateStr}`, { waitUntil: 'networkidle' });
  return scrapeAdviceTexts(page);
}

async function scrapeOneDay(page: Page, dateStr: string): Promise<DailyMeals> {
  console.error(`[scrape-asken] ===== ${dateStr} =====`);
  const { foods, mealCalories } = await scrapeFoods(page, dateStr);
  console.error(`[scrape-asken] Found ${foods.length} food entries.`);

  const meals: MealSummary[] = [];
  for (const [idStr, div] of Object.entries(DIVISION_BY_ADVICE_ID)) {
    const id = parseInt(idStr, 10);
    if (mealCalories[div] === 0) {
      console.error(`[scrape-asken] Skip nutrients for ${div} (0 kcal).`);
      continue;
    }
    const n = await scrapeMealNutrients(page, dateStr, id);
    meals.push({ division: div, ...n });
    console.error(
      `[scrape-asken] ${div}: ${n.calories}kcal P${n.protein}g F${n.fat}g C${n.carbs}g Fb${n.fiber}g`
    );
  }
  if (mealCalories['間食'] > 0) {
    meals.push({
      division: '間食',
      calories: mealCalories['間食'],
      protein: 0,
      fat: 0,
      carbs: 0,
      fiber: 0,
    });
    console.error(`[scrape-asken] 間食: ${mealCalories['間食']}kcal (calories only)`);
  }

  const dailyAdvice = await scrapeDailyAdvice(page, dateStr);
  if (dailyAdvice) {
    console.error(`[scrape-asken] dailyAdvice: ${dailyAdvice.slice(0, 60)}...`);
  }

  return {
    date: dateStr,
    foods,
    meals,
    dailyAdvice: dailyAdvice || undefined,
  };
}

async function main() {
  // 日付範囲の決定
  let fromDate: string;
  let toDate: string;
  if (DATE_ARGS.length === 0) {
    fromDate = toDate = effectiveToday();
  } else if (DATE_ARGS.length === 1) {
    fromDate = toDate = DATE_ARGS[0];
  } else {
    fromDate = DATE_ARGS[0];
    toDate = DATE_ARGS[DATE_ARGS.length - 1];
  }
  const dates = Array.from(dateRange(fromDate, toDate));
  console.error(
    `[scrape-asken] from=${fromDate} to=${toDate} (${dates.length} day${dates.length > 1 ? 's' : ''}) debug=${DEBUG}`
  );

  const browser = await chromium.launch({ headless: !DEBUG, slowMo: DEBUG ? 500 : 0 });
  const contextOptions: Parameters<typeof browser.newContext>[0] = { locale: 'ja-JP' };
  if (storageStateExists()) {
    console.error('[scrape-asken] Loading storageState...');
    contextOptions.storageState = getStorageStatePath();
  }
  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();

  // ログイン判定は範囲の先頭日で1回だけ行う
  await ensureLoggedIn(page, context, dates[0]);

  const results: DailyMeals[] = [];
  for (const dateStr of dates) {
    results.push(await scrapeOneDay(page, dateStr));
  }

  await browser.close();

  process.stdout.write(JSON.stringify(results, null, 2) + '\n');
  console.error(`[scrape-asken] Done. ${results.length} day${results.length > 1 ? 's' : ''} scraped.`);
}

main().catch((err: any) => {
  if (err instanceof ScrapeError) {
    console.error(`[scrape-asken] FATAL (code=${err.code}): ${err.message}`);
    process.exit(err.code);
  }
  console.error('[scrape-asken] FATAL:', err);
  process.exit(1);
});
