/**
 * Apple Health export.xml から HeartRate 全サンプルを CSV 出力
 *
 * 使い方:
 *   npx tsx src/export-heartrate-csv.ts <path/to/export.xml> [--from YYYY-MM-DD] [--to YYYY-MM-DD] > /tmp/heartrate.csv
 *
 * 出力 CSV カラム（Notion「心拍数」DB 用）:
 *   計測ID, 計測時刻, 心拍数, ソース
 *     - 計測ID: HealthKit startDate をそのまま（ユニークキー）
 *     - 計測時刻: ISO8601（+09:00 付き）
 *     - 心拍数: bpm
 *     - ソース: sourceName
 *
 * Notion 取り込み手順:
 *   Notion で「Import → CSV」で新規 DB を作成（初回）。
 *   2 回目以降は DB を開いて「Merge with CSV」で計測ID一致 upsert。
 *
 * メモリ対策:
 *   SAX streaming + 逐次 stdout 書き出し。JSON 中間ファイルを作らない。
 */

import * as fs from 'fs';
import * as sax from 'sax';

function csvEscape(s: string): string {
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

/** "2024-04-01 09:30:00 +0900" → "2024-04-01T09:30:00+09:00" */
function toIso(hkDate: string): string {
  // HealthKit: "YYYY-MM-DD HH:MM:SS ±HHMM"
  const m = hkDate.match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) ([+-])(\d{2})(\d{2})$/);
  if (!m) return hkDate;
  return `${m[1]}T${m[2]}${m[3]}${m[4]}:${m[5]}`;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args[0] === '--help') {
    console.error('Usage: export-heartrate-csv.ts <export.xml> [--from YYYY-MM-DD] [--to YYYY-MM-DD]');
    process.exit(1);
  }

  const xmlPath = args[0];
  let fromDate = '';
  let toDate = '';
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--from' && args[i + 1]) fromDate = args[++i];
    if (args[i] === '--to'   && args[i + 1]) toDate   = args[++i];
  }

  if (!fs.existsSync(xmlPath)) {
    console.error(`[export-heartrate] ERROR: File not found: ${xmlPath}`);
    process.exit(1);
  }

  // ヘッダー
  process.stdout.write('計測ID,計測時刻,心拍数,ソース\n');

  let count = 0;

  await new Promise<void>((resolve, reject) => {
    const parser = sax.createStream(true, { trim: true });

    parser.on('opentag', (node) => {
      if (node.name !== 'Record') return;
      const attrs = node.attributes as Record<string, string>;
      if (attrs['type'] !== 'HKQuantityTypeIdentifierHeartRate') return;

      const startDate = attrs['startDate'] ?? '';
      const valueStr  = attrs['value'] ?? '';
      const value     = parseFloat(valueStr);
      if (isNaN(value) || !startDate) return;

      const date = startDate.slice(0, 10);
      if (fromDate && date < fromDate) return;
      if (toDate   && date > toDate)   return;

      const iso    = toIso(startDate);
      const source = attrs['sourceName'] ?? '';

      const row = [
        csvEscape(startDate),
        csvEscape(iso),
        String(value),
        csvEscape(source),
      ].join(',');
      process.stdout.write(row + '\n');
      count++;

      if (count % 50000 === 0) {
        console.error(`[export-heartrate] ${count.toLocaleString()} 行書き出し済み`);
      }
    });

    parser.on('end', resolve);
    parser.on('error', () => {
      (parser as any)._parser.error = null;
      (parser as any)._parser.resume();
    });

    fs.createReadStream(xmlPath, { encoding: 'utf8' }).pipe(parser);
  });

  console.error(`[export-heartrate] Done: ${count.toLocaleString()} 行`);
}

main().catch((e) => {
  console.error('[export-heartrate] FATAL:', e);
  process.exit(1);
});
