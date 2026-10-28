import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

export const normalize = value => String(value).normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
export const kcal = item => Math.round(item.grams * item.kcalPer100g / 100);
// 互斥詞：兩邊名稱分別出現同一組的左右兩側，就一定不是同一種食物（模型也不能推翻）。
const EXCLUSIVE = [
  [['無糖', '零糖', '0糖', '不加糖', '無加糖', '零卡'], ['有糖', '含糖', '加糖', '全糖', '半糖', '微糖', '少糖', '減糖']],
  [['全糖'], ['半糖', '微糖', '少糖', '減糖']],
  [['炸'], ['水煮', '清蒸', '蒸', '烤', '滷', '燙', '涼拌']],
  [['生食', '生的', '未煮'], ['熟', '煮', '蒸', '烤', '炸', '滷', '燙']],
  [['去皮'], ['帶皮', '連皮']],
  [['脫脂', '低脂'], ['全脂']],
];
export function conflicts(a, b) {
  const x = normalize(a); const y = normalize(b);
  const has = (s, words) => words.some(w => s.includes(w));
  // 左側優先：「不加糖」含「加糖」、「未煮」含「煮」，仍應歸在左側。
  const side = (s, left, right) => has(s, left) ? 'L' : has(s, right) ? 'R' : '';
  return EXCLUSIVE.some(([left, right]) => { const p = side(x, left, right); const q = side(y, left, right); return p && q && p !== q; });
}
// 字元雙字組相似度（Dice）；一方完整包含另一方（至少 3 字）也視為相近。
function similarity(a, b) {
  if (!a || !b) return 0;
  const shorter = a.length <= b.length ? a : b; const longer = shorter === a ? b : a;
  if (shorter.length >= 3 && longer.includes(shorter)) return 0.9;
  const grams = s => { const list = []; for (let i = 0; i < s.length - 1; i++) list.push(s.slice(i, i + 2)); return list; };
  const left = grams(a); const right = grams(b);
  if (!left.length || !right.length) return 0;
  const pool = [...right]; let shared = 0;
  for (const g of left) { const index = pool.indexOf(g); if (index >= 0) { shared++; pool.splice(index, 1); } }
  return 2 * shared / (left.length + right.length);
}
const foodText = food => [food.name, ...food.aliases].join(' ');
const bad = message => Object.assign(new Error(message), { status: 400 });
const text = (value, max = 200) => typeof value === 'string' ? value.trim().slice(0, max) : '';
export function validDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}
export function safeUrl(value) {
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) ? url.href : ''; } catch { return ''; }
}
export function validateFood(input) {
  const name = text(input?.name, 100);
  const energy = input?.kcalPer100g;
  if (!name || typeof energy !== 'number' || !Number.isFinite(energy) || energy < 0 || energy > 1000)
    throw bad('食物需要名稱，以及 0～1000 的每 100g 熱量。');
  return { name, aliases: [...new Set((Array.isArray(input.aliases) ? input.aliases : []).map(a => text(a, 100)).filter(Boolean))].slice(0, 20),
    kcalPer100g: energy, source: ['manual', 'web', 'llm', 'label'].includes(input.source) ? input.source : 'manual',
    sourceUrl: safeUrl(input.sourceUrl), sourceTitle: text(input.sourceTitle), notes: text(input.notes, 1000) };
}
export function validateItems(items) {
  if (!Array.isArray(items) || !items.length || items.length > 30) throw bad('每餐需要 1～30 項食物。');
  return items.map(item => {
    const food = validateFood(item);
    if (typeof item.grams !== 'number' || !Number.isFinite(item.grams) || item.grams <= 0 || item.grams > 5000)
      throw bad('食物重量需要介於 0～5000g 之間。');
    return { ...food, id: text(item.id, 100) || randomUUID(), grams: item.grams,
      foodId: text(item.foodId, 100), matched: !!item.matched, confidence: text(item.confidence, 30),
      portionNote: text(item.portionNote, 500), cache: !!item.cache, recognizedName: text(item.recognizedName, 100) };
  });
}
function validPlan(p) {
  const num = (v, lo, hi) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
  if (!p || !['f', 'm'].includes(p.sex) || !Number.isInteger(p.age) || !num(p.age, 10, 100) || !num(p.height, 100, 230)
    || !num(p.weight, 25, 300) || !num(p.target, 25, 300) || ![1.2, 1.375, 1.55, 1.725].includes(p.activity))
    throw bad('減重目標資料不正確，請檢查性別、年齡、身高、體重、目標與活動量。');
  const now = new Date(); const today = new Date(now - now.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  if (p.startDate !== undefined && (!validDate(p.startDate) || p.startDate > today)) throw bad('計劃開始日期不正確。');
  return { sex: p.sex, age: p.age, height: p.height, weight: p.weight, target: p.target, activity: p.activity, ...(p.startDate && { startDate: p.startDate }) };
}
export function validPhoto(photo) {
  if (!photo) return '';
  if (typeof photo !== 'string' || photo.length > 3_000_000 || !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(photo))
    throw bad('照片格式或大小不符，請重新選擇 JPG、PNG 或 WebP。');
  return photo;
}

const AUTOMATED = ['web', 'llm', 'label'];

// shared：主日誌。朋友日誌的食物相關方法都改用主日誌的共用食物庫；餐點、設定與 meta 各自保存。
export function createJournal(filename, { foods: shared = null } = {}) {
  const db = new DatabaseSync(filename);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000;
    CREATE TABLE IF NOT EXISTS foods (id TEXT PRIMARY KEY, name TEXT NOT NULL, normalized TEXT NOT NULL UNIQUE, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS meals (id TEXT PRIMARY KEY, day TEXT NOT NULL, time TEXT NOT NULL, name TEXT NOT NULL, items TEXT NOT NULL, photo TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS meals_day ON meals(day);
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, status TEXT NOT NULL, created_at TEXT NOT NULL, text TEXT NOT NULL, photo TEXT NOT NULL,
      steps TEXT NOT NULL DEFAULT '[]', result TEXT, error TEXT NOT NULL DEFAULT '');
  `);
  const jobColumns = db.prepare('PRAGMA table_info(jobs)').all().map(c => c.name);
  if (!jobColumns.includes('meal_id')) db.exec("ALTER TABLE jobs ADD COLUMN meal_id TEXT NOT NULL DEFAULT ''");
  if (!jobColumns.includes('kind')) db.exec("ALTER TABLE jobs ADD COLUMN kind TEXT NOT NULL DEFAULT 'analyze'");
  // 背景分析在伺服器重啟時中斷，無法續跑。
  db.prepare("UPDATE jobs SET status='error', error=? WHERE status='running'").run('伺服器重新啟動，請重試。');
  const getMeta = key => db.prepare('SELECT value FROM meta WHERE key=?').get(key)?.value ?? '';
  const setMeta = (key, value) => db.prepare('INSERT INTO meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, String(value));
  function foods(query = '') {
    const all = db.prepare('SELECT id,data FROM foods ORDER BY name').all().map(row => ({ ...JSON.parse(row.data), id: row.id }));
    const q = normalize(query);
    return q ? all.filter(f => [f.name, ...f.aliases].some(s => normalize(s).includes(q))) : all;
  }
  function findFood(names) {
    const keys = names.map(normalize).filter(Boolean); const wanted = names.join(' ');
    // 同義名稱可能較籠統（例如「加多寶涼茶」），所以完全命中也要通過互斥詞檢查。
    const list = foods().filter(f => !conflicts(wanted, foodText(f)));
    // 依序比對：主名稱優先，模型給的同義名稱可能有誤（如把滷蛋當成茶葉蛋的別名），只在主名稱沒命中時才用。
    for (const key of keys) {
      const hit = list.find(f => normalize(f.name) === key) || list.find(f => f.aliases.some(alias => normalize(alias) === key));
      if (hit) return hit;
    }
    return null;
  }
  // 沒有完全命中時，找名稱相近、且沒有互斥詞的候選，交給模型判斷是否同一種。
  function candidates(names, limit = 5) {
    const keys = names.map(normalize).filter(Boolean); const wanted = names.join(' ');
    return foods().filter(f => !conflicts(wanted, foodText(f)))
      .map(f => ({ food: f, score: Math.max(...[f.name, ...f.aliases].flatMap(s => keys.map(k => similarity(k, normalize(s))))) }))
      .filter(c => c.score >= 0.5).sort((a, b) => b.score - a.score).slice(0, limit).map(c => c.food);
  }
  // 使用者確認「是同一種」後，把模型這次取的名稱記成同義名稱，下次直接命中。
  function addAliases(id, names) {
    const row = db.prepare('SELECT data FROM foods WHERE id=?').get(id);
    if (!row) return;
    const food = JSON.parse(row.data); const known = new Set([food.name, ...food.aliases].map(normalize));
    const added = names.filter(n => typeof n === 'string' && n.trim() && !known.has(normalize(n)) && known.add(normalize(n)));
    if (!added.length || food.aliases.length >= 20) return;
    food.aliases = [...food.aliases, ...added.map(n => n.trim().slice(0, 100))].slice(0, 20);
    db.prepare('UPDATE foods SET data=? WHERE id=?').run(JSON.stringify(food), id);
  }
  // 食物庫在 app 內不能手動修改；只有保存餐點時自動快取，以及維護者用腳本整理。
  function putFood(input, overwrite = true) {
    const food = validateFood(input);
    const existing = db.prepare('SELECT id FROM foods WHERE normalized=?').get(normalize(food.name));
    if (existing && !overwrite) return existing.id;
    const id = existing?.id || randomUUID();
    db.prepare('INSERT INTO foods(id,name,normalized,data) VALUES(?,?,?,?) ON CONFLICT(normalized) DO UPDATE SET name=excluded.name,data=excluded.data')
      .run(id, food.name, normalize(food.name), JSON.stringify(food));
    return id;
  }
  const local = { foods, findFood, candidates, addAliases, putFood };
  const library = shared ? Object.fromEntries(Object.keys(local).map(key => [key, shared[key]])) : local;
  // 一次性搬移：朋友日誌原有的自動查詢食物（web/llm/label）複製到共用庫，同名不覆蓋；原表保留不動。
  if (shared && !getMeta('foodsMigrated')) {
    for (const food of foods()) if (AUTOMATED.includes(food.source)) try { shared.putFood(food, false); } catch { /* 不合格的舊資料留在原表 */ }
    setMeta('foodsMigrated', new Date().toISOString());
  }
  function preferences() {
    const values = Object.fromEntries(db.prepare('SELECT key,value FROM settings').all().map(r => [r.key, JSON.parse(r.value)]));
    return { goal: 1800, fallback: 'web', model: '', name: '我', plan: null, ...values };
  }
  function updatePreferences(input) {
    const next = preferences();
    if ('goal' in input) {
      if (!Number.isInteger(input.goal) || input.goal < 500 || input.goal > 10000) throw bad('每日目標需為 500～10000 kcal。');
      next.goal = input.goal;
    }
    if ('fallback' in input) {
      if (!['web', 'llm'].includes(input.fallback)) throw bad('缺資料處理方式不正確。');
      next.fallback = input.fallback;
    }
    if ('model' in input) next.model = text(input.model, 100);
    if ('name' in input) next.name = text(input.name, 12) || '我';
    if ('plan' in input) next.plan = input.plan === null ? null : validPlan(input.plan);
    for (const [key, value] of Object.entries(next)) db.prepare('INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value));
    return next;
  }
  function readMeal(row, withPhoto = true) {
    const items = JSON.parse(row.items);
    return { id: row.id, day: row.day, time: row.time, name: row.name, items, kcal: items.reduce((s, i) => s + kcal(i), 0),
      ...(withPhoto ? { photo: row.photo } : {}), hasPhoto: !!row.photo };
  }
  function meals(day) {
    if (!validDate(day)) throw bad('日期格式不正確。');
    return db.prepare('SELECT * FROM meals WHERE day=? ORDER BY time DESC,created_at DESC').all(day).map(row => readMeal(row, false));
  }
  function meal(id) { const row = db.prepare('SELECT * FROM meals WHERE id=?').get(id); return row ? readMeal(row) : null; }
  function saveMeal(input, { shareFoods = true } = {}) {
    if (!validDate(input.day) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(input.time)) throw bad('日期或時間不正確。');
    const items = validateItems(input.items); const photo = validPhoto(input.photo);
    const name = text(input.name, 120) || text(items.map(i => i.name).join('、'), 120);
    const id = text(input.id, 100) || randomUUID();
    if (input.id && !meal(id)) throw Object.assign(new Error('找不到餐點。'), { status: 404 });
    db.exec('BEGIN IMMEDIATE');
    try {
      // 確認保存時，未修改的自動查詢結果寫入共用食物庫（可能在另一個檔案，不在這個交易內）；不覆蓋已有資料。
      // shareFoods=false（未開 FRIENDS_CACHE 的朋友）：完全不寫共用食物庫。
      if (shareFoods) for (const item of items) if (item.cache && !item.matched && AUTOMATED.includes(item.source)) item.foodId = library.putFood(item, false);
      if (shareFoods) for (const item of items) if (item.matched && item.foodId && item.recognizedName) library.addAliases(item.foodId, [item.recognizedName]);
      db.prepare('INSERT INTO meals VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET day=excluded.day,time=excluded.time,name=excluded.name,items=excluded.items,photo=excluded.photo')
        .run(id, input.day, input.time, name, JSON.stringify(items), photo, new Date().toISOString());
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    return meal(id);
  }
  function week(day) {
    if (!validDate(day)) throw bad('日期格式不正確。');
    return Array.from({ length: 7 }, (_, index) => {
      const d = new Date(day + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() - d.getUTCDay() + index);
      const key = d.toISOString().slice(0, 10); const list = meals(key);
      return { day: key, kcal: list.reduce((sum, m) => sum + m.kcal, 0), count: list.length };
    });
  }
  // 連勝：從今天（今天還沒記錄則從昨天）往回數，連續「有記錄且總熱量不超過目前目標」的天數。
  function streak(today) {
    const goal = preferences().goal, prev = d => new Date(Date.parse(d) - 864e5).toISOString().slice(0, 10);
    let n = 0, expect = today, day = null, total = 0;
    const ok = () => (day === expect || (expect === today && day === prev(today))) && total <= goal && (expect = prev(day), ++n);
    for (const r of db.prepare('SELECT day, items FROM meals WHERE day <= ? ORDER BY day DESC').iterate(today)) {
      if (r.day !== day) { if (day && !ok()) return n; day = r.day; total = 0; }
      total += JSON.parse(r.items).reduce((t, i) => t + kcal(i), 0);
    }
    if (day) ok();
    return n;
  }
  // 管理員檢視用：日誌擁有者等中繼資料、統計與跨日期的最近餐點（不含照片）。
  function stats() {
    const m = db.prepare('SELECT COUNT(*) AS count, MIN(day) AS first, MAX(day) AS last, MAX(created_at) AS updated FROM meals').get();
    const kcalTotal = db.prepare('SELECT items FROM meals').all().reduce((sum, r) => sum + JSON.parse(r.items).reduce((t, i) => t + kcal(i), 0), 0);
    return { meals: m.count, firstDay: m.first || '', lastDay: m.last || '', updatedAt: m.updated || '', kcalTotal,
      foods: library.foods().length, goal: preferences().goal };
  }
  function recentMeals(limit = 100) {
    return db.prepare('SELECT * FROM meals ORDER BY day DESC,time DESC,created_at DESC LIMIT ?').all(Math.min(Math.max(1, limit | 0), 500)).map(row => readMeal(row, false));
  }
  // 背景分析工作：每本日誌最多保留最新 20 筆。
  const readJob = (row, withPhoto) => ({ id: row.id, kind: row.kind, status: row.status, createdAt: row.created_at, text: row.text, hasPhoto: !!row.photo,
    steps: JSON.parse(row.steps), error: row.error, mealId: row.meal_id, ...(row.result ? { result: JSON.parse(row.result) } : {}), ...(withPhoto ? { photo: row.photo } : {}) });
  function createJob({ text: input, photo = '', kind = 'analyze', mealId = '' }) {
    const id = randomUUID();
    db.prepare("INSERT INTO jobs(id,kind,status,created_at,text,photo,meal_id) VALUES(?,?,'running',?,?,?,?)").run(id, kind, new Date().toISOString(), input, photo, mealId);
    db.prepare('DELETE FROM jobs WHERE id NOT IN (SELECT id FROM jobs ORDER BY created_at DESC, rowid DESC LIMIT 20)').run();
    return id;
  }
  function updateJob(id, { status, steps, result, error, mealId }) {
    db.prepare('UPDATE jobs SET status=COALESCE(?,status), steps=COALESCE(?,steps), result=COALESCE(?,result), error=COALESCE(?,error), meal_id=COALESCE(?,meal_id) WHERE id=?')
      .run(status ?? null, steps ? JSON.stringify(steps) : null, result ? JSON.stringify(result) : null, error ?? null, mealId ?? null, id);
  }
  // 已完成的工作若對應餐點已被刪除，就一併移除，避免首頁一直顯示「已自動記錄」。
  const listJobs = () => {
    db.prepare("DELETE FROM jobs WHERE status='done' AND meal_id<>'' AND meal_id NOT IN (SELECT id FROM meals)").run();
    return db.prepare('SELECT * FROM jobs ORDER BY created_at DESC, rowid DESC LIMIT 20').all().map(row => readJob(row, false));
  };
  function getJob(id) { const row = db.prepare('SELECT * FROM jobs WHERE id=?').get(id); return row ? readJob(row, true) : null; }
  const deleteJob = id => db.prepare('DELETE FROM jobs WHERE id=?').run(id).changes;
  return { close: () => db.close(), getMeta, setMeta, stats, recentMeals, ...library, preferences, updatePreferences, meals, meal, saveMeal, week, streak,
    createJob, updateJob, listJobs, getJob, deleteJob,
    deleteMeal: id => { db.prepare("DELETE FROM jobs WHERE status='done' AND meal_id=?").run(id); return db.prepare('DELETE FROM meals WHERE id=?').run(id).changes; },
    exportData: () => ({ version: 1, settings: preferences(), foods: library.foods(), meals: db.prepare('SELECT * FROM meals ORDER BY day,time').all().map(row => readMeal(row)) }),
  };
}
