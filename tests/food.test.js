import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createJournal, conflicts } from '../server/journal.js';
import { analyzeMeal, collectResponse } from '../server/food-analysis.js';
import { retryOnTimeout } from '../server/food-routes.js';

const rice = { name: '測試熟飯', aliases: ['測試白飯'], kcalPer100g: 130, source: 'manual', notes: '僅測試 fixture' };
const recognized = { name: '測試午餐', note: '重量為估計', items: [{ name: '測試白飯', grams: 200, aliases: [], confidence: 'medium', portionNote: '估計200g' }] };
const answer = data => ({ text: JSON.stringify(data), searched: false, citations: [] });
const baseMeal = () => ({ name: '測試餐', day: '2026-10-02', time: '12:30', photo: '', items: [{ ...rice, source: 'web', grams: 200, cache: true }] });

test('SQLite 跨日紀錄、熱量重算、編輯、重開與刪除', t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'meal-test-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const filename = path.join(dir, 'test.sqlite'); let db = createJournal(filename);
  const saved = db.saveMeal(baseMeal()); assert.equal(saved.kcal, 260); assert.equal(db.foods().length, 1);
  db.saveMeal({ ...baseMeal(), day: '2026-10-01', items: [{ ...rice, grams: 100 }] });
  assert.equal(db.meals('2026-10-02').length, 1); assert.equal(db.week('2026-10-02')[0].day, '2026-09-27'); assert.equal(db.week('2026-10-02').find(h => h.day === '2026-10-01').kcal, 130);
  db.saveMeal({ ...saved, items: [{ ...saved.items[0], grams: 300 }] });
  assert.equal(db.meal(saved.id).kcal, 390);
  db.updatePreferences({ goal: 1823, fallback: 'llm', model: 'gpt-5.6-sol' }); db.close();
  db = createJournal(filename); assert.equal(db.meal(saved.id).kcal, 390); assert.equal(db.preferences().goal, 1823);
  db.deleteMeal(saved.id); assert.equal(db.meals('2026-10-02').length, 0); assert.equal(db.foods().length, 1); db.close();
});
test('日誌名稱：預設「我」、保存、空白重設、最多 12 字', () => {
  const db = createJournal(':memory:'); assert.equal(db.preferences().name, '我');
  db.updatePreferences({ name: ' 小明 ' }); assert.equal(db.preferences().name, '小明');
  db.updatePreferences({ name: '' }); assert.equal(db.preferences().name, '我');
  db.updatePreferences({ name: '一二三四五六七八九十甲乙丙' }); assert.equal(db.preferences().name, '一二三四五六七八九十甲乙'); db.close();
});
test('餐點名稱留空時用食物名稱以「、」串接；有填則保留', () => {
  const db = createJournal(':memory:'); const items = [{ ...rice, name: '白飯', grams: 100 }, { ...rice, name: '滷肉', grams: 50 }];
  assert.equal(db.saveMeal({ ...baseMeal(), name: '', items }).name, '白飯、滷肉');
  assert.equal(db.saveMeal({ ...baseMeal(), name: '午餐', items }).name, '午餐'); db.close();
});
test('拒絕無效日期、重量、熱量與照片', () => {
  const db = createJournal(':memory:');
  assert.throws(() => db.saveMeal({ ...baseMeal(), day: '2026-02-30' }));
  assert.throws(() => db.saveMeal({ ...baseMeal(), items: [{ ...rice, grams: -1 }] }));
  assert.throws(() => db.saveMeal({ ...baseMeal(), photo: 'http://untrusted.invalid/picture' }));
  assert.equal(db.meals('2026-10-02').length, 0); db.close();
});
test('名稱與別名命中本機庫，不再要求熱量推論', async () => {
  const db = createJournal(':memory:'); db.putFood(rice); let calls = 0;
  const result = await analyzeMeal({ text: '一碗測試飯', photo: '', journal: db, emit() {}, infer: async () => { calls++; return answer(recognized); } });
  assert.equal(calls, 1); assert.equal(result.items[0].matched, true); assert.equal(result.items[0].kcalPer100g, 130);
  assert.equal(result.items[0].grams, 200); db.close();
});
test('辨識提示依目前使用者的計畫加入拳頭大小參照', async () => {
  const db = createJournal(':memory:'); db.putFood(rice);
  for (const [plan, expected] of [[{ sex: 'm', height: 175 }, '拳頭寬約 8.8 cm（一拳頭約 280 ml）：熟飯、麵一拳頭約 200–220 g'],
    [{ sex: 'f', height: 160 }, '拳頭寬約 7.7 cm（一拳頭約 190 ml）'], [null, '拳頭寬約 8.5 cm（一拳頭約 250 ml）：熟飯、麵一拳頭約 180–200 g']]) {
    let prompt = '';
    await analyzeMeal({ text: '飯一拳頭', photo: '', journal: { ...db, preferences: () => ({ ...db.preferences(), plan }) }, emit() {},
      infer: async body => { prompt = body.instructions; return answer(recognized); } });
    assert.ok(prompt.includes(expected), expected);
  }
  db.close();
});
test('辨識輸入加上用餐時間脈絡；系統指示不隨時間改變', async () => {
  const db = createJournal(':memory:'); db.putFood(rice); const seen = [];
  const run = at => analyzeMeal({ text: '測試餐', photo: '', at, journal: db, emit() {}, infer: async body => { seen.push(body); return answer(recognized); } });
  for (const [at, expected] of [[new Date(2026, 9, 28, 7, 40), '用餐時間：週三 07:40（早餐時段）'], [new Date(2026, 9, 28, 12, 5), '（午餐時段）'],
    [new Date(2026, 9, 28, 15, 0), '（下午點心時段）'], [new Date(2026, 9, 28, 20, 59), '（晚餐時段）'], [new Date(2026, 9, 29, 4, 59), '週四 04:59（宵夜時段）']]) {
    await run(at); const content = seen.at(-1).input[0].content;
    assert.ok(content[0].text.includes(expected), expected); assert.equal(content[1].text, '測試餐');
  }
  await run(undefined); assert.equal(seen.at(-1).input[0].content.length, 1); // 未給時間（AI 估算）：不加脈絡
  assert.ok(seen[0].instructions.includes('用餐時間只作為判斷常見份量與餐點型態的參考'));
  assert.ok(seen.every(b => b.instructions === seen[0].instructions)); db.close();
});
test('資料庫未命中時估算；確認前不寫入；之後仍保留 LLM 來源', async () => {
  const db = createJournal(':memory:'); let calls = 0;
  const result = await analyzeMeal({ text: '測試餐', photo: '', fallback: 'llm', journal: db, emit() {},
    infer: async () => answer(calls++ === 0 ? recognized : { kcalPer100g: 150, notes: '估算' }) });
  assert.equal(db.foods().length, 0); assert.equal(result.items[0].source, 'llm');
  db.saveMeal({ ...baseMeal(), items: result.items });
  const hit = db.findFood(['測試白飯']); assert.equal(hit.source, 'llm'); assert.equal(hit.kcalPer100g, 150); db.close();
});
test('照片營養標示直接使用，不查熱量；無效值照常查', async () => {
  for (const [label, source, n] of [[45, 'label', 1], [2000, 'llm', 2], ['45', 'llm', 2]]) {
    const db = createJournal(':memory:'); db.putFood(rice); let calls = 0;
    const result = await analyzeMeal({ text: '一瓶測試飲料', photo: '', fallback: 'llm', journal: db, emit() {}, infer: async () =>
      answer(calls++ === 0 ? { name: '飲料', items: [{ name: '測試飲料', grams: 250, labelKcalPer100g: label }] } : { kcalPer100g: 50, notes: '估算' }) });
    assert.equal(calls, n); assert.equal(result.items[0].source, source); assert.equal(result.items[0].grams, 250);
    if (n === 1) { assert.equal(result.items[0].kcalPer100g, 45); db.saveMeal({ ...baseMeal(), items: result.items }); assert.equal(db.findFood(['測試飲料']).source, 'label'); }
    db.close();
  }
});
test('真實搜尋引用才標記為 web；虛構引用退回估算', async () => {
  // 引用網址帶 utm 參數、模型網址多結尾斜線，仍算同一頁。
  for (const [valid, cited, given] of [[true, 'https://example.org/nutrition', 'https://example.org/nutrition'],
    [true, 'https://example.org/nutrition?utm_source=openai', 'https://example.org/nutrition/'], [false, 'https://example.org/other', 'https://example.org/nutrition']]) {
    const db = createJournal(':memory:'); let calls = 0;
    const result = await analyzeMeal({ text: '測試餐', photo: '', fallback: 'web', journal: db, emit() {}, infer: async body => {
      calls++; if (calls === 1) return answer(recognized);
      if (calls === 2) { assert.equal(body.tools[0].type, 'web_search'); return { ...answer({ kcalPer100g: 135, sourceUrl: given }), searched: true,
        citations: [{ url: cited, title: '測試來源' }] }; }
      return answer({ kcalPer100g: 140, notes: '估算' });
    } });
    assert.equal(result.items[0].source, valid ? 'web' : 'llm'); assert.equal(calls, valid ? 2 : 3);
    if (valid) assert.equal(result.items[0].sourceUrl, 'https://example.org/nutrition');
    db.close();
  }
});
test('沒有可靠參照物（typical）才改用來源的一般份量；有參照物或來源無份量則保留辨識重量', async () => {
  const url = 'https://example.org/nutrition';
  for (const [basis, servingGrams, grams] of [['typical', 350, 350], ['reference', 350, 200], ['typical', null, 200], [undefined, 350, 200]]) {
    const db = createJournal(':memory:'); let calls = 0;
    const result = await analyzeMeal({ text: '測試餐', photo: '', fallback: 'web', journal: db, emit() {}, infer: async body => {
      if (calls++ === 0) { assert.ok(body.instructions.includes('"portionBasis"')); return answer({ ...recognized, items: [{ ...recognized.items[0], portionBasis: basis }] }); }
      assert.ok(body.instructions.includes('"servingGrams"'));
      return { ...answer({ kcalPer100g: 135, sourceUrl: url, servingGrams }), searched: true, citations: [{ url, title: '測試來源' }] };
    } });
    const item = result.items[0];
    assert.equal(item.source, 'web'); assert.equal(item.grams, grams, `${basis}/${servingGrams}`);
    assert.equal(item.portionNote, grams === 350 ? '依一般份量 350 g（測試來源）；估計200g' : '估計200g');
    db.close();
  }
});
test('LLM 估算路徑的一般份量標示為 LLM 估算', async () => {
  const db = createJournal(':memory:'); let calls = 0;
  const result = await analyzeMeal({ text: '測試餐', photo: '', fallback: 'llm', journal: db, emit() {}, infer: async () =>
    answer(calls++ === 0 ? { ...recognized, items: [{ ...recognized.items[0], portionBasis: 'typical' }] } : { kcalPer100g: 150, servingGrams: 300, notes: '估算' }) });
  assert.equal(result.items[0].source, 'llm'); assert.equal(result.items[0].grams, 300);
  assert.equal(result.items[0].portionNote, '依一般份量估計 300 g（LLM 估算）；估計200g'); db.close();
});
test('搜尋不支援時 fallback，額度錯誤不重複花額度', async () => {
  for (const status of [400, 429]) {
    const db = createJournal(':memory:'); let calls = 0;
    const promise = analyzeMeal({ text: '測試餐', photo: '', journal: db, emit() {}, infer: async () => {
      calls++; if (calls === 1) return answer(recognized);
      if (calls === 2) throw Object.assign(new Error('上游錯誤'), { status });
      return answer({ kcalPer100g: 140 });
    } });
    if (status === 429) { await assert.rejects(promise); assert.equal(calls, 2); }
    else { assert.equal((await promise).items[0].source, 'llm'); assert.equal(calls, 3); }
    db.close();
  }
});
test('未收錄項目最多 3 項同時查詢，結果維持辨識順序', async () => {
  const db = createJournal(':memory:'); let inFlight = 0; let max = 0;
  const names = ['測試甲', '測試乙', '測試丙', '測試丁'];
  const result = await analyzeMeal({ text: '測試餐', photo: '', fallback: 'llm', journal: db, emit() {}, infer: async body => {
    if (typeof body.input[0].content !== 'string') return answer({ name: '測試餐', items: names.map((name, k) => ({ name, grams: 100 + k, aliases: [] })) });
    const food = JSON.parse(body.input[0].content).food; inFlight++; max = Math.max(max, inFlight);
    await new Promise(resolve => setTimeout(resolve, 10 * (4 - names.indexOf(food)))); inFlight--;
    return answer({ kcalPer100g: 100 + names.indexOf(food) });
  } });
  assert.equal(max, 3);
  assert.deepEqual(result.items.map(i => [i.name, i.grams, i.kcalPer100g]), names.map((name, k) => [name, 100 + k, 100 + k])); db.close();
});
test('單次模型呼叫逾時重試一次；再逾時才失敗，其他錯誤不重試', async () => {
  const hang = signal => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
  let calls = 0;
  assert.equal(await retryOnTimeout(signal => ++calls === 1 ? hang(signal) : 'ok', new AbortController().signal, 20), 'ok'); assert.equal(calls, 2);
  calls = 0; await assert.rejects(retryOnTimeout(signal => { calls++; return hang(signal); }, new AbortController().signal, 20), e => e.timeout); assert.equal(calls, 2);
  calls = 0; await assert.rejects(retryOnTimeout(async () => { calls++; throw Object.assign(new Error('額度'), { status: 429 }); }, new AbortController().signal, 20)); assert.equal(calls, 1);
});
test('網路搜尋重試後仍逾時：改用 LLM 估算並附警告；估算也逾時才失敗', async () => {
  const timeout = () => Object.assign(new Error('timeout'), { timeout: true });
  for (const estimateTimesOut of [false, true]) {
    const db = createJournal(':memory:'); let calls = 0;
    const promise = analyzeMeal({ text: '測試餐', photo: '', journal: db, emit() {}, infer: async () => {
      calls++; if (calls === 1) return answer(recognized);
      if (calls === 2 || estimateTimesOut) throw timeout();
      return answer({ kcalPer100g: 140 });
    } });
    if (estimateTimesOut) await assert.rejects(promise, e => e.timeout);
    else { const r = await promise; assert.equal(r.items[0].source, 'llm'); assert.deepEqual(r.warnings, ['「測試白飯」搜尋逾時，改用 LLM 估算。']); }
    db.close();
  }
});
test('圖片送入 input_image，非食物不產生假紀錄', async () => {
  const db = createJournal(':memory:');
  await assert.rejects(analyzeMeal({ text: '', photo: 'data:image/jpeg;base64,AAAA', journal: db, emit() {}, infer: async body => {
    assert.equal(body.input[0].content[1].type, 'input_image'); return answer({ items: [], note: '不是食物' });
  } }), /不是食物/); assert.equal(db.foods().length, 0); db.close();
});
test('SSE 蒐集已完成 output、網路引用與中斷拒絕', async () => {
  const event = { type: 'response.completed', response: { output: [{ type: 'web_search_call', status: 'completed' },
    { type: 'message', content: [{ type: 'output_text', text: '{"kcalPer100g":130}', annotations: [{ type: 'url_citation', url: 'https://example.org/', title: '來源' }] }] }] } };
  const result = await collectResponse(new Response('data: '+JSON.stringify(event)+'\n\n').body);
  assert.equal(result.searched, true); assert.equal(result.citations.length, 1);
  await assert.rejects(collectResponse(new Response('data: {"type":"response.output_text.delta","delta":"partial"}\n\n').body), /中斷/);
});
const tea = { name: '加多寶涼茶（含糖）', aliases: ['加多寶植物飲料'], kcalPer100g: 34, source: 'manual' };
const canned = { name: '測試餐', items: [{ name: '加多寶有糖罐裝涼茶', aliases: ['加多寶罐裝涼茶'], grams: 310, confidence: 'high', portionNote: '一罐' }] };
test('互斥詞：有糖/無糖、炸/蒸、否定詞不誤判', () => {
  assert.equal(conflicts('加多寶無糖涼茶', '加多寶涼茶（含糖）'), true);
  assert.equal(conflicts('炸雞腿', '清蒸雞腿'), true);
  assert.equal(conflicts('不加糖豆漿', '含糖豆漿'), true);
  assert.equal(conflicts('不加糖豆漿', '無糖豆漿'), false);
  assert.equal(conflicts('加多寶有糖罐裝涼茶', '加多寶涼茶（含糖）'), false);
  assert.equal(conflicts('全糖奶茶', '半糖奶茶'), true);
});
test('相近候選併入查熱量那次呼叫；判斷相同就用本機資料，確認後學會名稱', async () => {
  for (const fallback of ['web', 'llm']) {
    const db = createJournal(':memory:'); const id = db.putFood(tea); let calls = 0;
    const result = await analyzeMeal({ text: '一罐加多寶', photo: '', fallback, journal: db, emit() {}, infer: async body => {
      calls++; if (calls === 1) return answer(canned);
      assert.match(body.instructions, /加多寶涼茶（含糖）/);
      if (fallback === 'web') assert.equal(body.tool_choice, 'auto');
      return answer({ sameAs: id });
    } });
    assert.equal(calls, 2);
    const item = result.items[0];
    assert.equal(item.matched, true); assert.equal(item.foodId, id); assert.equal(item.kcalPer100g, 34);
    assert.equal(item.grams, 310); assert.equal(item.recognizedName, '加多寶有糖罐裝涼茶');
    db.saveMeal({ name: '加多寶', day: '2026-10-02', time: '12:00', photo: '', items: result.items });
    assert.equal(db.findFood(['加多寶有糖罐裝涼茶'])?.id, id); assert.equal(db.foods().length, 1);
    db.close();
  }
});
test('模型判斷不同或回傳不存在的 id：照常查熱量，保留相近項目給使用者', async () => {
  for (const sameAs of [null, 'not-a-candidate']) {
    const db = createJournal(':memory:'); db.putFood(tea); let calls = 0;
    const result = await analyzeMeal({ text: '一罐加多寶', photo: '', fallback: 'llm', journal: db, emit() {}, infer: async () => {
      calls++; return answer(calls === 1 ? canned : { sameAs, kcalPer100g: 40, notes: '估算' });
    } });
    assert.equal(calls, 2); assert.equal(result.items[0].matched, false); assert.equal(result.items[0].kcalPer100g, 40);
    assert.deepEqual(result.items[0].similar.map(f => f.name), ['加多寶涼茶（含糖）']);
    db.close();
  }
});
test('互斥詞擋下籠統同義名稱與候選，不送給模型比對', async () => {
  const db = createJournal(':memory:'); db.putFood({ ...tea, aliases: ['加多寶涼茶'] }); let calls = 0;
  assert.equal(db.findFood(['加多寶無糖涼茶', '加多寶涼茶']), null);
  assert.equal(db.findFood(['加多寶涼茶'])?.name, '加多寶涼茶（含糖）');
  const result = await analyzeMeal({ text: '無糖加多寶', photo: '', fallback: 'llm', journal: db, emit() {}, infer: async body => {
    calls++; if (calls === 1) return answer({ name: '測試', items: [{ name: '加多寶無糖涼茶', aliases: ['加多寶涼茶'], grams: 310 }] });
    assert.doesNotMatch(body.instructions, /相近項目/); return answer({ kcalPer100g: 1 });
  } });
  assert.equal(result.items[0].matched, false); assert.deepEqual(result.items[0].similar, []); db.close();
});
test('findFood 主名稱優先於模型給的同義名稱（茶葉蛋不會被當成滷蛋）', () => {
  const db = createJournal(':memory:');
  db.putFood({ name: '滷蛋', aliases: ['醬油蛋'], kcalPer100g: 184, source: 'web' });
  db.putFood({ name: '茶葉蛋', kcalPer100g: 147, source: 'web' });
  assert.equal(db.findFood(['茶葉蛋', '滷蛋'])?.name, '茶葉蛋');
  assert.equal(db.findFood(['蛋', '滷蛋'])?.name, '滷蛋');
  assert.equal(db.findFood(['蛋', '醬油蛋'])?.name, '滷蛋'); db.close();
});
test('共用食物庫：朋友讀主日誌的 foods，自動查詢結果與學到的名稱寫回共用庫，餐點與設定各自保存', () => {
  const owner = createJournal(':memory:'); const friend = createJournal(':memory:', { foods: owner });
  const id = owner.putFood(rice); assert.equal(friend.findFood(['測試白飯']).id, id);
  const web = { ...rice, name: '朋友新菜', source: 'web', grams: 100, cache: true };
  const saved = friend.saveMeal({ ...baseMeal(), items: [web, { ...web, name: '改過熱量', cache: false }, { ...web, name: '手動菜', source: 'manual' },
    { ...rice, foodId: id, matched: true, recognizedName: '朋友叫法', grams: 50 }] });
  assert.equal(saved.items[0].foodId, owner.findFood(['朋友新菜']).id); assert.equal(owner.findFood(['改過熱量']), null); assert.equal(owner.findFood(['手動菜']), null);
  assert.equal(owner.findFood(['朋友叫法']).id, id); assert.equal(friend.foods().length, 2); assert.equal(friend.stats().foods, 2);
  assert.equal(owner.meals('2026-10-02').length, 0); assert.equal(friend.meals('2026-10-02').length, 1); assert.equal(friend.exportData().foods.length, 2);
  friend.updatePreferences({ goal: 1500, name: '朋友' }); assert.equal(owner.preferences().goal, 1800); assert.equal(owner.preferences().name, '我');
  friend.close(); owner.close();
});
test('共用食物庫搬移：朋友原有的自動查詢食物複製進主庫，手動與同名不動，只做一次', t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'meal-shared-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ownerFile = path.join(dir, 'meals.sqlite'); const friendFile = path.join(dir, 'meals-friend.sqlite');
  let friend = createJournal(friendFile);
  friend.putFood({ ...rice, source: 'web', kcalPer100g: 999 }); friend.putFood({ ...rice, name: '朋友網路', source: 'llm' }); friend.putFood({ ...rice, name: '朋友手動' }); friend.close();
  const owner = createJournal(ownerFile); owner.putFood(rice);
  friend = createJournal(friendFile, { foods: owner });
  assert.equal(owner.findFood(['測試熟飯']).kcalPer100g, 130); assert.ok(owner.findFood(['朋友網路'])); assert.equal(owner.findFood(['朋友手動']), null);
  friend.close(); owner.putFood({ ...rice, name: '朋友網路', kcalPer100g: 1 });
  friend = createJournal(friendFile, { foods: owner }); assert.equal(owner.findFood(['朋友網路']).kcalPer100g, 1); assert.ok(friend.getMeta('foodsMigrated')); friend.close();
  friend = createJournal(friendFile); assert.equal(friend.foods().length, 3); friend.close(); owner.close();
});
test('連勝：連續達標天數、今天未記錄不中斷、今天超標為 0、缺一天中斷、用目前目標', () => {
  const db = createJournal(':memory:'); db.updatePreferences({ goal: 1000 });
  const eat = (day, grams) => db.saveMeal({ ...baseMeal(), day, items: [{ ...rice, grams }] }); // 130 kcal/100g
  assert.equal(db.streak('2026-10-12'), 0);
  eat('2026-10-08', 100); eat('2026-10-10', 100); eat('2026-10-11', 300); eat('2026-10-11', 300); // 10-11 合計 780
  assert.equal(db.streak('2026-10-12'), 2); // 今天未記錄從昨天算；10-09 缺一天中斷
  eat('2026-10-12', 100); assert.equal(db.streak('2026-10-12'), 3);
  eat('2026-10-12', 700); assert.equal(db.streak('2026-10-12'), 0); // 今天 1040 > 1000
  db.updatePreferences({ goal: 1100 }); assert.equal(db.streak('2026-10-12'), 3);
  db.updatePreferences({ goal: 700 }); assert.equal(db.streak('2026-10-11'), 0); // 780 超過目前目標
  assert.equal(db.streak('2026-10-10'), 1);
  db.close();
});
