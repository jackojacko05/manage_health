import { chromium } from 'playwright';
import * as path from 'path';
import * as fs from 'fs';

const STATE = path.join(process.env.HOME!, 'GitHub/manage_health/data/storageState.json');
const DATE = '2026-04-18'; // 昨日

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    storageState: fs.existsSync(STATE) ? STATE : undefined,
    locale: 'ja-JP',
  });
  const page = await ctx.newPage();
  await page.goto(`https://www.asken.jp/wsp/comment/${DATE}`, { waitUntil: 'networkidle' });
  console.error('URL:', page.url());

  const html = await page.content();
  fs.writeFileSync('/tmp/asken_comment_yesterday.html', html);
  console.error(`Saved (${html.length} bytes)`);

  // breakfast セクションの実際の中身を確認
  const info = await page.evaluate(() => {
    const sec = document.querySelector('#karute_report_breakfast');
    if (!sec) return 'section not found';
    return sec.innerHTML.slice(0, 3000);
  });
  console.log(info);

  await browser.close();
})();
