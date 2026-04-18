/**
 * あすけん 食事記録スクレイパー
 *
 * 使い方:
 *   npx tsx src/scrape-asken.ts          # headless（毎時実行用）
 *   npx tsx src/scrape-asken.ts --debug  # headful（初回ログイン・デバッグ用）
 *
 * 出力: JSON → stdout
 * ログ: → stderr（Claude Scheduled Taskはstderrを無視するので安全）
 */

import { chromium } from 'playwright';
import * as dotenv from 'dotenv';
import * as path from 'path';
import * as crypto from 'crypto';
import {
  storageStateExists,
  getStorageStatePath,
  saveStorageState,
} from './auth';
import type { DailyMeals, FoodEntry, MealDivision } from './types';

dotenv.config({ path: path.join(__dirname, '..', '.env') });

const DEBUG = process.argv.includes('--debug');

const LOGIN_URL = 'https://www.asken.jp/login';
const DIARY_BASE_URL = 'https://www.asken.jp/my_diary';

function today(): string {
  const d = new Date();
  const jst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  return jst.toISOString().slice(0, 10);
}

function parseFoodEntry(
  division: MealDivision,
  nameText: string,
  gramsText: string,
  nutriText: string
): FoodEntry | null {
  const name = nameText.trim();
  if (!name) return null;

  const grams = parseFloat(gramsText.replace(/[^0-9.]/g, '')) || 0;

  // 栄養素はカロリー/タンパク質/脂質/炭水化物/食物繊維の順を想定
  const nums = nutriText
    .split(/[\s,、\/]+/)
    .map((s) => parseFloat(s.replace(/[^0-9.]/g, '')))
    .filter((n) => !isNaN(n));

  return {
    division,
    name,
    grams,
    calories: nums[0] ?? 0,
    protein: nums[1] ?? 0,
    fat: nums[2] ?? 0,
    carbs: nums[3] ?? 0,
    fiber: nums[4] ?? 0,
  };
}

export function makeHash(entry: FoodEntry): string {
  const raw = `${entry.division}|${entry.name}|${entry.grams}`;
  return crypto.createHash('sha1').update(raw).digest('hex').slice(0, 8);
}

async function main() {
  const dateStr = today();
  console.error(`[scrape-asken] date=${dateStr} debug=${DEBUG}`);

  const launchOptions = {
    headless: !DEBUG,
    slowMo: DEBUG ? 500 : 0,
  };

  const browser = await chromium.launch(launchOptions);

  let context;
  if (storageStateExists()) {
    console.error('[scrape-asken] storageState found, loading session...');
    context = await browser.newContext({
      storageState: getStorageStatePath(),
      locale: 'ja-JP',
    });
  } else {
    console.error('[scrape-asken] No storageState, starting fresh context...');
    context = await browser.newContext({ locale: 'ja-JP' });
  }

  const page = await context.newPage();

  // ---- ログイン確認・必要ならログイン ----
  await page.goto(DIARY_BASE_URL, { waitUntil: 'domcontentloaded' });

  if (page.url().includes('/login') || page.url().includes('/sign_in')) {
    console.error('[scrape-asken] Session expired or not logged in. Logging in...');

    if (!DEBUG) {
      // headlessでログインが必要な場合は認証情報を使う
      const email = process.env.ASKEN_EMAIL;
      const password = process.env.ASKEN_PASSWORD;
      if (!email || !password) {
        console.error('[scrape-asken] ERROR: ASKEN_EMAIL/ASKEN_PASSWORD not set in .env');
        process.exit(1);
      }

      await page.goto(LOGIN_URL, { waitUntil: 'networkidle' });

      // メールアドレス入力
      await page.fill('input[type="email"], input[name="email"], input[id*="email"]', email);
      // パスワード入力
      await page.fill('input[type="password"]', password);
      // ログインボタン
      await page.click('button[type="submit"], input[type="submit"], .login-btn, .btn-login');
      await page.waitForURL((url) => !url.toString().includes('/login'), { timeout: 15000 });

    } else {
      // --debug時: ユーザーが手動ログインするのを待つ
      console.error('[scrape-asken] [DEBUG] Please log in manually in the browser window.');
      console.error('[scrape-asken] [DEBUG] Waiting for navigation away from login page...');
      await page.waitForURL((url) => !url.toString().includes('/login'), { timeout: 120000 });
    }

    await saveStorageState(context);
    console.error('[scrape-asken] Login complete, session saved.');

    // ログイン後に日記ページへ
    await page.goto(DIARY_BASE_URL, { waitUntil: 'domcontentloaded' });
  }

  // ---- 当日の食事記録ページへ ----
  const diaryUrl = `${DIARY_BASE_URL}?date=${dateStr}`;
  if (page.url() !== diaryUrl) {
    await page.goto(diaryUrl, { waitUntil: 'networkidle' });
  }

  console.error(`[scrape-asken] Scraping ${page.url()}`);

  // ---- DOM解析 ----
  const entries: FoodEntry[] = [];
  const DIVISIONS: MealDivision[] = ['朝食', '昼食', '夕食', '間食'];

  for (const division of DIVISIONS) {
    // あすけんの食事区分セクションを探す
    // セクション見出しに区分名が含まれる要素を探し、その配下の食品リストを取得
    const sectionItems = await page.evaluate((div: string) => {
      const results: Array<{
        name: string;
        grams: string;
        nutriText: string;
      }> = [];

      // 区分名を含む要素を探す（複数のパターンに対応）
      const allElements = Array.from(document.querySelectorAll('*'));
      let sectionEl: Element | null = null;

      for (const el of allElements) {
        const text = el.textContent?.trim() ?? '';
        // 正確に区分名のみを含む見出し系要素
        if (
          text === div &&
          (el.tagName === 'H1' ||
            el.tagName === 'H2' ||
            el.tagName === 'H3' ||
            el.tagName === 'H4' ||
            el.tagName === 'SPAN' ||
            el.tagName === 'DIV' ||
            el.tagName === 'P') &&
          el.children.length === 0
        ) {
          sectionEl = el;
          break;
        }
      }

      if (!sectionEl) return results;

      // セクション要素の親または兄弟から食品行を取得
      const container =
        sectionEl.closest('[class*="meal"], [class*="food"], [class*="diary"], section, article, li') ??
        sectionEl.parentElement;
      if (!container) return results;

      // 食品行候補: tr, li, [class*="item"], [class*="food"], [class*="row"]
      const rows = container.querySelectorAll(
        'tr, li, [class*="item"], [class*="food-row"], [class*="foodRow"]'
      );

      for (const row of Array.from(rows)) {
        // 区分名セルを除外
        if (row.textContent?.trim() === div) continue;

        // 食品名を探す（最初の非数値テキスト）
        const cells = Array.from(row.querySelectorAll('td, span, div, p'));
        if (cells.length === 0) continue;

        const nameEl = cells.find(
          (c) =>
            c.children.length === 0 &&
            c.textContent &&
            c.textContent.trim().length > 0 &&
            !/^[\d.]+$/.test(c.textContent.trim())
        );
        if (!nameEl) continue;

        const name = nameEl.textContent?.trim() ?? '';
        if (!name || name === div) continue;

        // グラム数
        const gramsEl = cells.find(
          (c) => c !== nameEl && /\d/.test(c.textContent ?? '') && /[gｇ]/.test(c.textContent ?? '')
        );
        const grams = gramsEl?.textContent?.trim() ?? '0';

        // 栄養素テキスト（残りのセルを連結）
        const nutriParts = cells
          .filter((c) => c !== nameEl && c !== gramsEl && /\d/.test(c.textContent ?? ''))
          .map((c) => c.textContent?.trim())
          .join(' ');

        results.push({ name, grams, nutriText: nutriParts });
      }

      return results;
    }, division);

    for (const item of sectionItems) {
      const entry = parseFoodEntry(division, item.name, item.grams, item.nutriText);
      if (entry) {
        entries.push(entry);
        console.error(`[scrape-asken] ${division}: ${entry.name} ${entry.calories}kcal`);
      }
    }
  }

  await browser.close();

  const result: DailyMeals = { date: dateStr, entries };
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  console.error(`[scrape-asken] Done. ${entries.length} entries found.`);
}

main().catch((err) => {
  console.error('[scrape-asken] FATAL:', err);
  process.exit(1);
});
