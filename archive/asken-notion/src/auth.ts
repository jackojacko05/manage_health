import { BrowserContext } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';

const STATE_PATH = path.join(__dirname, '..', 'data', 'storageState.json');

export function storageStateExists(): boolean {
  return fs.existsSync(STATE_PATH);
}

export function getStorageStatePath(): string {
  return STATE_PATH;
}

export async function saveStorageState(context: BrowserContext): Promise<void> {
  await context.storageState({ path: STATE_PATH });
  console.error(`[auth] storageState saved to ${STATE_PATH}`);
}
