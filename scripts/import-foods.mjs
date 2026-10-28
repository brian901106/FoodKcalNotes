// 維護者用：把整理好的資料集（data/*.json）匯入主日誌的共用食物庫。
// 用法：node scripts/import-foods.mjs data/a.json [data/b.json …] [--dry-run]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createJournal, normalize, validateFood } from '../server/journal.js';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const files = args.filter(a => a !== '--dry-run');
if (!files.length) { console.error('用法：node scripts/import-foods.mjs data/a.json [data/b.json …] [--dry-run]'); process.exit(1); }

// 與 server/server.js 相同的資料夾規則。
const dataDirectory = process.env.MEAL_JOURNAL_DATA_DIR || path.join(os.homedir(), '.my-chatgpt-local');
const filename = path.join(dataDirectory, 'meals.sqlite');
const journal = createJournal(filename);
const keyOwner = new Map(journal.foods().flatMap(f => [f.name, ...f.aliases].map(k => [normalize(k), f.name])));
const before = journal.foods().length;

if (!dryRun) {
  const stamp = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().replace(/\D/g, '').slice(0, 14).replace(/^(\d{8})/, '$1-');
  const backup = path.join(dataDirectory, `meals-backup-${stamp}.sqlite`);
  const db = new DatabaseSync(filename); db.exec('PRAGMA busy_timeout=3000'); db.prepare('VACUUM INTO ?').run(backup); db.close();
  console.log(`備份：${backup}`);
} else console.log('--dry-run：只回報，不寫入。');

for (const file of files) {
  const counts = { added: 0, skipped: 0, invalid: 0 };
  for (const [index, item] of JSON.parse(fs.readFileSync(file, 'utf8')).entries()) {
    const keys = [item?.name, ...(Array.isArray(item?.aliases) ? item.aliases : [])].map(k => normalize(k ?? '')).filter(Boolean);
    const clash = keys.find(k => keyOwner.has(k));
    if (clash) { counts.skipped++; console.log(`  略過 ${item.name}：「${clash}」已屬於 ${keyOwner.get(clash)}`); continue; }
    try { validateFood(item); if (!dryRun) journal.putFood(item, false); } catch (error) { counts.invalid++; console.log(`  無效 #${index} ${item?.name ?? ''}：${error.message}`); continue; }
    counts.added++; keys.forEach(k => keyOwner.set(k, item.name));
  }
  console.log(`${file}：新增 ${counts.added}，略過 ${counts.skipped}，無效 ${counts.invalid}`);
}
console.log(`食物總數：${before} → ${journal.foods().length}`);
journal.close();
