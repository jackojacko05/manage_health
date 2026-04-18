/**
 * Notion REST API 薄クライアント
 * - Integration tokenで認証
 * - 必要最小限のエンドポイントだけ実装
 */

const NOTION_API = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';

function headers(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    'Notion-Version': NOTION_VERSION,
    'Content-Type': 'application/json',
  };
}

export interface NotionPage {
  id: string;
  url: string;
  properties: Record<string, any>;
}

export interface QueryResult {
  results: NotionPage[];
  has_more: boolean;
  next_cursor: string | null;
}

export async function queryDatabase(
  token: string,
  dataSourceId: string,
  filter?: any,
  pageSize = 100
): Promise<NotionPage[]> {
  const all: NotionPage[] = [];
  let cursor: string | undefined;
  do {
    const body: any = { page_size: pageSize };
    if (filter) body.filter = filter;
    if (cursor) body.start_cursor = cursor;

    const res = await fetch(`${NOTION_API}/databases/${dataSourceId}/query`, {
      method: 'POST',
      headers: headers(token),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`Notion query failed: ${res.status} ${await res.text()}`);
    }
    const data = (await res.json()) as QueryResult;
    all.push(...data.results);
    cursor = data.has_more && data.next_cursor ? data.next_cursor : undefined;
  } while (cursor);
  return all;
}

export async function createPage(
  token: string,
  dataSourceId: string,
  properties: Record<string, any>
): Promise<NotionPage> {
  const res = await fetch(`${NOTION_API}/pages`, {
    method: 'POST',
    headers: headers(token),
    body: JSON.stringify({
      parent: { database_id: dataSourceId },
      properties,
    }),
  });
  if (!res.ok) {
    throw new Error(`Notion create failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as NotionPage;
}

// ---- Property builders (typed shortcuts) ----
export const P = {
  title: (text: string) => ({ title: [{ type: 'text', text: { content: text } }] }),
  richText: (text: string) => ({
    rich_text: [{ type: 'text', text: { content: text } }],
  }),
  number: (n: number) => ({ number: n }),
  select: (name: string) => ({ select: { name } }),
  date: (startISO: string) => ({
    date: { start: startISO },
  }),
  relation: (pageIds: string[]) => ({
    relation: pageIds.map((id) => ({ id })),
  }),
};

// Extract text from a property (title or rich_text)
export function getPropText(page: NotionPage, propName: string): string {
  const p = page.properties?.[propName];
  if (!p) return '';
  if (p.type === 'title') return p.title?.map((t: any) => t.plain_text).join('') ?? '';
  if (p.type === 'rich_text')
    return p.rich_text?.map((t: any) => t.plain_text).join('') ?? '';
  return '';
}
