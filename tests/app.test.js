import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { generateKeyPair, SignJWT } from 'jose';
import { createApp, allowedModel } from '../server/app.js';
import { verifyIdentity, ISSUER } from '../server/oauth.js';
import { readSSE } from '../server/sse.js';
import { createJournal } from '../server/journal.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

async function fixture(t, extra = {}) {
  const account = { client_id: 'oaiapp_test', subject: 'user-1', access_token: 'old-test-token',
    refresh_token: 'test-refresh', scopes: ['chatgpt.tokens.use.direct'], expiresAt: 0 };
  const store = { data: { hostId: 'test-host', accounts: [account], activeId: account.client_id }, save() {} };
  const calls = { refresh: 0, exchange: 0, responses: [] };
  const oauth = {
    authorization: async tx => `https://auth.openai.com/authorize?state=${tx.state}`,
    exchange: async () => { calls.exchange++; return { access_token: 'new-test-token', refresh_token: 'new-test-refresh',
      expires_in: 3600, scope: 'chatgpt.tokens.use.direct', id_token: 'test-id' }; },
    verify: async () => ({ sub: 'user-1', email: 'test@example.invalid' }),
    refresh: async () => { calls.refresh++; await new Promise(resolve => setTimeout(resolve, 15));
      return { access_token: 'new-test-token', refresh_token: 'rotated', expires_in: 3600, scope: 'chatgpt.tokens.use.direct' }; },
    revoke: async () => true,
  };
  const fetcher = async (url, options) => {
    assert.equal(options.headers.Authorization, 'Bearer new-test-token');
    if (url.endsWith('/models')) return Response.json({ models: [
      { slug: 'gpt-5.6-sol', display_name: 'GPT-5.6-Sol', visibility: 'list' },
      { slug: 'gpt-5.6-luna', display_name: 'GPT-5.6-Luna', visibility: 'list' },
      { slug: 'gpt-5.6-terra', display_name: 'Test model', visibility: 'list' },
      { slug: 'gpt-6-astra', display_name: 'GPT-6-Astra', visibility: 'list' },
      { slug: 'hidden', visibility: 'hidden' }] });
    const body = JSON.parse(options.body); calls.responses.push(body);
    if (calls.status) return Response.json({ error: { code: 'usage_limit_reached' } }, { status: calls.status });
    // reply 可為函式（依請求內容回覆），回傳陣列時當作完整 output。
    let reply = calls.reply; if (typeof reply === 'function') reply = reply(body);
    const output = Array.isArray(reply) ? reply : [{type:'message',content:[{type:'output_text',text:reply||JSON.stringify({name:'測試餐',items:[{name:'測試飯',grams:100}]})}]}];
    return new Response('data: '+JSON.stringify({type:'response.completed',response:{output}})+'\n\n');
  };
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const journal = createJournal(':memory:');
  t.after(() => journal.close());
  const friends = new Map();
  const journalFor = login => { if (!friends.has(login)) { const j = createJournal(':memory:', { foods: journal }); t.after(() => j.close()); friends.set(login, j); } return friends.get(login); };
  const { app, errors, pending } = createApp({ store, origin, oauth, fetcher, journal, ...extra,
    remoteOrigins: ['https://pc.example.ts.net'], ownerLogin: 'owner@example.com', journalFor,
    listJournals: () => [{ id: 'owner', login: 'owner@example.com', owner: true, journal }, ...[...friends].map(([login, j]) => { j.setMeta('login', login); return { id: login.replace(/[^a-z]/g, ''), login, owner: false, journal: j }; })] });
  app.get('/', (req, res) => res.send('test'));
  app.use(errors); server.on('request', app);
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const home = await fetch(origin);
  const cookie = home.headers.get('set-cookie').split(';')[0];
  const status = await (await fetch(`${origin}/api/status`, { headers: { cookie } })).json();
  const request = (path, body, { method = body ? 'POST' : 'GET', ...extra } = {}) => new Promise((resolve, reject) => {
    const req = httpRequest(origin + path, {
    method, redirect: 'manual',
    headers: { cookie, ...(method !== 'GET' ? { 'Content-Type': 'application/json', 'X-CSRF-Token': status.csrf } : {}), ...extra },
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode, headers: res.headers })));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
  // 背景分析：送出後輪詢到工作結束。
  const analyze = async (body, extra, path = '/api/analyze') => {
    const { id } = await (await request(path, body, extra)).json();
    for (;;) {
      const job = await (await request('/api/jobs/' + id, null, extra)).json();
      if (job.status !== 'running') return job;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  };
  return { request, analyze, pending, account, calls, origin, cookie, store, journal };
}
// 自動保存的日期時間：工作建立時的伺服器本機時間。
const localAt = iso => { const d = new Date(iso); const pad = n => String(n).padStart(2, '0');
  return [`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, `${pad(d.getHours())}:${pad(d.getMinutes())}`]; };

test('拒絕跨來源、缺少 CSRF 與未知 Host', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/models', null, { Origin: 'https://evil.invalid' })).status, 403);
  assert.equal((await f.request('/api/logout', {}, { 'X-CSRF-Token': 'wrong' })).status, 403);
  const hostStatus = await new Promise((resolve, reject) => {
    const req = httpRequest(f.origin + '/api/status', { headers: { Host: 'evil.invalid', Cookie: f.cookie } }, res => {
      res.resume(); resolve(res.statusCode);
    });
    req.on('error', reject); req.end();
  });
  assert.equal(hostStatus, 403);
});
test('開發模式拒絕遠端要求', async t => {
  const f = await fixture(t, { devMode: true });
  const res = await f.request('/api/status', null, { Host: 'pc.example.ts.net', Origin: 'https://pc.example.ts.net', 'Tailscale-User-Login': 'owner@example.com' });
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error, '開發模式只限本機使用。');
  assert.equal((await f.request('/api/status')).status, 200);
});

test('允許 OAuth 回程的跨站首頁導覽，仍拒絕跨站 API 與登入 POST', async t => {
  const f = await fixture(t);
  const navigation = { Origin: 'https://external.invalid', 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' };
  assert.equal((await f.request('/?login=success', null, navigation)).status, 200);
  assert.equal((await f.request('/?login_error=cancelled', null, navigation)).status, 200);
  assert.equal((await f.request('/api/status', null, navigation)).status, 403);
  assert.equal((await f.request('/auth/chatgpt', {}, navigation)).status, 403);
  assert.equal((await f.request('/', null, { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty' })).status, 200);
  assert.equal((await f.request('/', null, { 'Sec-Fetch-Site': 'same-site' })).status, 200);
  assert.equal((await f.request('/', null, { Origin: 'https://external.invalid' })).status, 200);
  assert.equal((await f.request('/api/status', null, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
});
test('同時要求只 refresh 一次，保存旋轉 token 並隱藏模型', async t => {
  const f = await fixture(t);
  const results = await Promise.all([f.request('/api/models'), f.request('/api/models')]);
  assert.equal(f.calls.refresh, 1); assert.equal(f.account.refresh_token, 'rotated');
  assert.deepEqual((await results[0].json()).models.map(m => m.slug), ['gpt-5.6-sol', 'gpt-5.6-luna', 'gpt-5.6-terra']);
  const status = await (await f.request('/api/status')).text();
  assert.equal(status.includes('new-test-token'), false);
  assert.equal(status.includes('rotated'), false);
});
test('OAuth state、cookie、client ID 與重放驗證', async t => {
  const f = await fixture(t);
  await f.request('/auth/chatgpt', { client_id: 'oaiapp_test' });
  const state = [...f.pending.keys()][0];
  const callback = `/auth/callback?state=${state}&code=fake-code`;
  await f.request(callback, null, { cookie: 'local_session=wrong' });
  assert.equal(f.calls.exchange, 0); assert.equal(f.pending.has(state), true);
  await f.request(callback + '&client_id=wrong');
  assert.equal(f.calls.exchange, 0); assert.equal(f.pending.has(state), false);
  await f.request('/auth/chatgpt', { client_id: 'oaiapp_test' });
  const valid = `/auth/callback?state=${[...f.pending.keys()][0]}&code=fake-code`;
  assert.equal((await f.request(valid)).headers.get('location'), '/?login=success');
  await f.request(valid); assert.equal(f.calls.exchange, 1);
});
test('逾時與使用者取消 OAuth 不交換 code', async t => {
  const f = await fixture(t);
  await f.request('/auth/chatgpt', {});
  const state = [...f.pending.keys()][0]; f.pending.get(state).expiresAt = 0;
  await f.request(`/auth/callback?state=${state}&code=fake`);
  await f.request('/auth/chatgpt', {});
  await f.request(`/auth/callback?state=${[...f.pending.keys()][0]}&error=access_denied`);
  assert.equal(f.calls.exchange, 0);
});
test('飲食 API 傳入圖片並遵守 Responses contract，保存後可查日期', async t => {
  const f = await fixture(t); f.journal.putFood({name:'測試飯',kcalPer100g:130,source:'manual'});
  assert.equal((await f.request('/api/analyze', {model:'hidden',text:'飯'})).status,400);
  const job = await f.analyze({model:'gpt-5.6-terra',photo:'data:image/jpeg;base64,AAAA'});
  assert.equal(job.status,'done');
  const draft = job.result;
  assert.equal(draft.items[0].matched,true);
  assert.equal(f.calls.responses[0].stream,true); assert.equal(f.calls.responses[0].store,false);
  assert.equal(f.calls.responses[0].input[0].content[2].type,'input_image');
  // 用餐時間脈絡取自工作建立時間（與自動存檔時間相同）。
  const [, hhmm] = localAt(job.createdAt); assert.match(f.calls.responses[0].input[0].content[0].text, new RegExp(`^用餐時間：週. ${hhmm}（`));
  const auto = await (await f.request('/api/meals/' + job.mealId)).json();
  assert.deepEqual([auto.day, auto.time], localAt(job.createdAt));
  assert.deepEqual([auto.name, auto.items.map(i => [i.name, i.grams]), auto.photo, auto.kcal], ['測試餐', [['測試飯', 100]], 'data:image/jpeg;base64,AAAA', 130]);
  f.journal.deleteMeal(auto.id); assert.equal((await (await f.request('/api/journal?day=2026-10-02')).json()).since,'');
  const saved = await (await f.request('/api/meals',{...draft,day:'2026-10-02',time:'12:30',photo:''})).json();
  assert.equal(saved.kcal,130);
  await f.request('/api/meals',{...draft,day:'2026-10-05',time:'08:00',photo:''});
  const journal = await (await f.request('/api/journal?day=2026-10-02')).json();
  assert.equal(journal.meals.length,1); assert.equal(journal.since,'2026-10-02');
  assert.equal((await (await f.request('/api/journal?day=2026-10-02&today=2026-10-05')).json()).streak,1);
});
test('背景分析工作：立即回 id、跑完存結果、只列目前日誌、可刪除；模型錯誤記為 error', async t => {
  const f = await fixture(t); f.journal.putFood({ name: '測試飯', kcalPer100g: 130, source: 'manual' });
  const remote = { Host: 'pc.example.ts.net', Origin: 'https://pc.example.ts.net', 'Tailscale-User-Login': 'friend@example.com' };
  const posted = await (await f.request('/api/analyze', { model: 'gpt-5.6-terra', text: '飯', photo: 'data:image/jpeg;base64,AAAA' })).json();
  assert.equal(typeof posted.id, 'string');
  const job = await f.analyze({ model: 'gpt-5.6-terra', text: '麵' });
  assert.equal(job.status, 'done'); assert.equal(job.text, '麵'); assert.equal(job.photo, ''); assert.equal(job.error, '');
  assert.equal(typeof job.mealId, 'string'); assert.equal((await f.request('/api/meals/' + job.mealId, null, remote)).status, 404);
  assert.equal(job.result.items[0].name, '測試飯'); assert.ok(job.steps.length >= 2); assert.deepEqual(Object.keys(job.steps[0]).sort(), ['label', 'message']);
  const first = await (await f.request('/api/jobs/' + posted.id)).json();
  assert.equal(first.photo, 'data:image/jpeg;base64,AAAA'); assert.equal(first.hasPhoto, true);
  const { jobs } = await (await f.request('/api/jobs')).json();
  assert.deepEqual(jobs.map(j => j.id), [job.id, posted.id]); assert.equal(jobs.some(j => 'photo' in j), false);
  assert.deepEqual((await (await f.request('/api/jobs', null, remote)).json()).jobs, []);
  assert.equal((await f.request('/api/jobs/' + job.id, null, remote)).status, 404);
  assert.equal((await f.request('/api/jobs/' + job.id, null, { ...remote, method: 'DELETE' })).status, 404);
  assert.deepEqual(await (await f.request('/api/jobs/' + job.id, null, { method: 'DELETE' })).json(), { ok: true });
  assert.equal((await f.request('/api/jobs/' + job.id)).status, 404);
  assert.equal((await f.request('/api/meals/' + job.mealId)).status, 200); // 刪除工作不刪餐點
  assert.equal((await f.request('/api/jobs/' + job.id, null, { method: 'DELETE' })).status, 404);
  f.calls.status = 429;
  const failed = await f.analyze({ model: 'gpt-5.6-terra', text: '飯' });
  assert.equal(failed.status, 'error'); assert.match(failed.error, /HTTP 429/); assert.equal('result' in failed, false); assert.equal(failed.mealId, '');
});
test('刪除餐點會移除對應的已完成工作；舊的孤兒工作在列表時清掉，進行中與失敗的保留', async t => {
  const f = await fixture(t); f.journal.putFood({ name: '測試飯', kcalPer100g: 130, source: 'manual' });
  const job = await f.analyze({ model: 'gpt-5.6-terra', text: '飯' });
  assert.equal(job.status, 'done');
  assert.deepEqual(await (await f.request('/api/meals/' + job.mealId, null, { method: 'DELETE' })).json(), { ok: true });
  assert.equal((await f.request('/api/jobs/' + job.id)).status, 404);
  const stuck = f.journal.createJob({ text: '舊' }); f.journal.updateJob(stuck, { status: 'done', mealId: 'gone' });
  const running = f.journal.createJob({ text: '跑', kind: 'relookup', mealId: 'gone' });
  const failed = f.journal.createJob({ text: '錯' }); f.journal.updateJob(failed, { status: 'error', error: 'x' });
  const { jobs } = await (await f.request('/api/jobs')).json();
  assert.deepEqual(jobs.map(j => j.id).sort(), [running, failed].sort());
});
test('背景分析自動存成餐點：LLM 估算不寫入共用食物庫，網路查證仍寫入；朋友日誌隔離（FRIENDS_CACHE 開）', async t => {
  const f = await fixture(t, { chatgptShared: true, friendsCache: true });
  const friend = { Host: 'pc.example.ts.net', Origin: 'https://pc.example.ts.net', 'Tailscale-User-Login': 'friend@example.com' };
  f.calls.reply = body => {
    const content = body.input[0].content;
    if (Array.isArray(content)) return JSON.stringify({ name: '自動餐', items: [{ name: '網路麵', grams: 100 }, { name: '估算湯', grams: 200 }] });
    if (JSON.parse(content).food === '網路麵' && body.tools) return [{ type: 'web_search_call', status: 'completed' }, { type: 'message', content: [{ type: 'output_text',
      text: JSON.stringify({ kcalPer100g: 150, sourceUrl: 'https://example.com/noodle', sourceTitle: '例', notes: '' }),
      annotations: [{ type: 'url_citation', url: 'https://example.com/noodle', title: '例' }] }] }];
    return JSON.stringify({ kcalPer100g: 40, sourceUrl: '', sourceTitle: '', notes: '估' });
  };
  const job = await f.analyze({ model: 'gpt-5.6-terra', text: '麵和湯', fallback: 'web' }, friend);
  assert.equal(job.status, 'done');
  const meal = await (await f.request('/api/meals/' + job.mealId, null, friend)).json();
  assert.deepEqual([meal.day, meal.time], localAt(job.createdAt));
  assert.deepEqual(meal.items.map(i => [i.name, i.source]), [['網路麵', 'web'], ['估算湯', 'llm']]);
  assert.equal((await f.request('/api/meals/' + job.mealId)).status, 404);
  assert.deepEqual(f.journal.foods().map(food => food.name), ['網路麵']);
  // 手動確認（POST /api/meals）維持原行為：LLM 估算也寫入。
  await f.request('/api/meals', { ...job.result, day: '2026-10-02', time: '12:00', photo: '' }, friend);
  assert.deepEqual(f.journal.foods().map(food => food.name).sort(), ['估算湯', '網路麵'].sort());
});
test('FRIENDS_CACHE 預設關閉：朋友的分析與手動保存都不寫共用食物庫（不新增、不加別名）；擁有者照常寫入', async t => {
  const f = await fixture(t, { chatgptShared: true });
  const friend = { Host: 'pc.example.ts.net', Origin: 'https://pc.example.ts.net', 'Tailscale-User-Login': 'friend@example.com' };
  const id = f.journal.putFood({ name: '共用飯', kcalPer100g: 130, source: 'manual' });
  f.calls.reply = body => Array.isArray(body.input[0].content) ? JSON.stringify({ name: '網路餐', items: [{ name: '網路麵', grams: 100 }] })
    : [{ type: 'web_search_call', status: 'completed' }, { type: 'message', content: [{ type: 'output_text',
      text: JSON.stringify({ kcalPer100g: 150, sourceUrl: 'https://example.com/noodle', sourceTitle: '例', notes: '' }),
      annotations: [{ type: 'url_citation', url: 'https://example.com/noodle', title: '例' }] }] }];
  const job = await f.analyze({ model: 'gpt-5.6-terra', text: '麵', fallback: 'web' }, friend);
  assert.equal(job.status, 'done'); assert.equal(job.result.items[0].source, 'web');
  assert.equal((await f.request('/api/meals/' + job.mealId, null, friend)).status, 200);
  const injected = { name: '朋友餐', day: '2026-10-02', time: '12:00', photo: '', items: [{ name: '假熱量', grams: 100, kcalPer100g: 999, source: 'web', cache: true },
    { name: '共用飯', grams: 100, kcalPer100g: 130, source: 'manual', foodId: id, matched: true, recognizedName: '朋友別名' }] };
  assert.equal((await f.request('/api/meals', injected, friend)).status, 200);
  assert.deepEqual(f.journal.foods().map(food => food.name), ['共用飯']); assert.equal(f.journal.findFood(['朋友別名']), null);
  // 擁有者（本機）照常寫入。
  await f.request('/api/meals', injected);
  assert.equal(f.journal.findFood(['假熱量']).kcalPer100g, 999); assert.equal(f.journal.findFood(['朋友別名']).id, id);
  const own = await f.analyze({ model: 'gpt-5.6-terra', text: '麵', fallback: 'web' });
  assert.equal(own.status, 'done'); assert.ok(f.journal.findFood(['網路麵']));
});
test('自動保存失敗時工作記為 error 並保留結果', async t => {
  const f = await fixture(t); f.journal.putFood({ name: '測試飯', kcalPer100g: 130, source: 'manual' });
  f.journal.saveMeal = () => { throw new Error('每餐需要 1～30 項食物。'); };
  const job = await f.analyze({ model: 'gpt-5.6-terra', text: '飯' });
  assert.deepEqual([job.status, job.error, job.mealId, job.result.items[0].name], ['error', '每餐需要 1～30 項食物。', '', '測試飯']);
});
test('伺服器重啟時把執行中的工作標記為錯誤', t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'jobs-test-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const filename = path.join(dir, 'test.sqlite'); let db = createJournal(filename);
  const id = db.createJob({ text: '飯', photo: '' }); const done = db.createJob({ text: '麵', photo: '' });
  db.updateJob(done, { status: 'done', result: { name: '麵', note: '', items: [], warnings: [] } }); db.close();
  db = createJournal(filename);
  assert.deepEqual([db.getJob(id).status, db.getJob(id).error], ['error', '伺服器重新啟動，請重試。']);
  assert.equal(db.getJob(done).status, 'done'); db.close();
});
test('工作每本日誌最多保留最新 20 筆', () => {
  const db = createJournal(':memory:'); const ids = Array.from({ length: 22 }, (_, k) => db.createJob({ text: String(k), photo: '' }));
  assert.deepEqual(db.listJobs().map(j => j.id), ids.slice(2).reverse()); db.close();
});
test('單項 AI 估算：名稱跑完整分析，拆成多項並各自估份量', async t => {
  const f = await fixture(t); f.journal.putFood({name:'測試飯',kcalPer100g:130,source:'manual'});
  const estimate = body => f.request('/api/estimate', {model:'gpt-5.6-terra',fallback:'llm',...body});
  assert.equal((await estimate({name:''})).status,400);
  assert.equal((await estimate({name:'測試飯',model:'gpt-6-astra'})).status,400);
  const replies = [JSON.stringify({name:'測試套餐',items:[{name:'測試飯',grams:300},{name:'蘋果派',grams:80}]}),
    JSON.stringify({kcalPer100g:250,sourceUrl:'',sourceTitle:'',notes:'測試估算'})];
  Object.defineProperty(f.calls,'reply',{get:()=>replies.shift()});
  const r = await (await estimate({name:'測試飯套餐 送蘋果派'})).json();
  assert.equal(f.calls.responses.length,2); assert.equal(f.calls.responses[0].input[0].content[0].text,'測試飯套餐 送蘋果派');
  assert.deepEqual(r.items.map(i=>[i.name,i.grams,i.kcalPer100g,i.matched,i.source]),[['測試飯',300,130,true,'manual'],['蘋果派',80,250,false,'llm']]);
  assert.deepEqual(r.warnings,[]);
});
test('ChatGPT：辨識與估算帶 strict text.format（json_schema）；搜尋不帶，也不送出 schema 欄位', async t => {
  const { RECOGNITION_SCHEMA, ESTIMATE_SCHEMA } = await import('../server/food-analysis.js');
  const f = await fixture(t);
  const nutrition = { kcalPer100g: 250, sourceUrl: '', sourceTitle: '', notes: '測試', servingGrams: null };
  const replies = [JSON.stringify({ name: '測試派', note: '', items: [{ name: '蘋果派', aliases: [], grams: 80, confidence: 'high', portionBasis: 'reference', portionNote: '', labelKcalPer100g: null }] }),
    JSON.stringify(nutrition), JSON.stringify({ ...nutrition, sameAs: null })];
  Object.defineProperty(f.calls, 'reply', { get: () => replies.shift() });
  const r = await (await f.request('/api/estimate', { model: 'gpt-5.6-terra', fallback: 'web', name: '蘋果派' })).json();
  assert.equal(r.items[0].source, 'llm');
  const [recognition, search, estimate] = f.calls.responses;
  assert.deepEqual(recognition.text, { format: { type: 'json_schema', name: 'meal_recognition', strict: true, schema: RECOGNITION_SCHEMA.schema } });
  assert.equal(search.text, undefined); assert.deepEqual(search.tools, [{ type: 'web_search' }]);
  assert.deepEqual(estimate.text, { format: { type: 'json_schema', name: 'food_estimate', strict: true, schema: ESTIMATE_SCHEMA.schema } });
  assert.ok(f.calls.responses.every(b => !('schema' in b)));
});
test('背景重新查詢：只查這一項並改寫已存餐點，保留重量與其他項', async t => {
  const f = await fixture(t, { chatgptShared: true }); f.journal.putFood({name:'滷排骨',kcalPer100g:220,source:'manual'});
  const friend = { Host: 'pc.example.ts.net', Origin: 'https://pc.example.ts.net', 'Tailscale-User-Login': 'friend@example.com' };
  const base = { name: '午餐', day: '2026-10-02', time: '12:00', photo: '', items: [{ id: 'x1', name: '排骨', grams: 150, kcalPer100g: 300, source: 'llm', portionNote: '一塊' },
    { id: 'x2', name: '白飯', grams: 200, kcalPer100g: 130, source: 'manual' }] };
  const meal = await (await f.request('/api/meals', base)).json();
  const relookup = (body, extra) => f.analyze({ model: 'gpt-5.6-terra', fallback: 'llm', mealId: meal.id, itemId: 'x1', ...body }, extra, '/api/jobs/relookup');
  const post = (body, extra) => f.request('/api/jobs/relookup', { model: 'gpt-5.6-terra', fallback: 'llm', mealId: meal.id, itemId: 'x1', name: '滷排骨', ...body }, extra);
  assert.equal((await post({ mealId: 'nope' })).status, 404); assert.equal((await post({ itemId: 'nope' })).status, 404);
  assert.equal((await post({}, friend)).status, 404); assert.equal((await post({ name: '' })).status, 400);
  assert.equal((await post({ model: 'gpt-6-astra' })).status, 400);
  const hit = await relookup({ name: '滷排骨' });
  assert.equal(f.calls.responses.length, 0);
  assert.deepEqual([hit.status, hit.kind, hit.text, hit.mealId, hit.result.item.id], ['done', 'relookup', '滷排骨', meal.id, 'x1']);
  let saved = await (await f.request('/api/meals/' + meal.id)).json();
  assert.deepEqual([saved.name, saved.day, saved.time], ['午餐', '2026-10-02', '12:00']);
  assert.deepEqual(saved.items.map(i => [i.id, i.name, i.grams, i.kcalPer100g, i.source, i.matched, i.portionNote]),
    [['x1', '滷排骨', 150, 220, 'manual', true, '一塊'], ['x2', '白飯', 200, 130, 'manual', false, '']]);
  f.calls.reply = JSON.stringify({kcalPer100g:180,sourceUrl:'',sourceTitle:'',notes:'測試估算',servingGrams:300});
  const est = await relookup({ name: '未知排骨' });
  assert.equal(f.calls.responses.length, 1); assert.equal(est.status, 'done');
  saved = await (await f.request('/api/meals/' + meal.id)).json();
  assert.deepEqual(saved.items.map(i => [i.name, i.grams, i.kcalPer100g, i.source, i.cache]), [['未知排骨', 150, 180, 'llm', false], ['白飯', 200, 130, 'manual', false]]);
  assert.deepEqual(f.journal.foods().map(food => food.name).sort(), ['滷排骨']);
  assert.equal((await (await f.request('/api/jobs')).json()).jobs[0].kind, 'relookup');
  // 查詢期間品項被刪除：工作記為錯誤，不復原該項。
  f.calls.reply = () => { f.journal.saveMeal({ ...f.journal.meal(meal.id), items: f.journal.meal(meal.id).items.filter(i => i.id !== 'x1') });
    return JSON.stringify({kcalPer100g:90,sourceUrl:'',sourceTitle:'',notes:''}); };
  const gone = await relookup({ name: '另一種排骨' });
  assert.deepEqual([gone.status, gone.error], ['error', '品項已被刪除。']);
  assert.deepEqual((await (await f.request('/api/meals/' + meal.id)).json()).items.map(i => i.id), ['x2']);
});
test('真實 JWT 簽章驗證，拒絕錯誤 nonce、audience、issuer 與逾期', async () => {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const sign = (aud = 'client', iss = ISSUER, exp = '1h') => new SignJWT({ nonce: 'nonce' })
    .setProtectedHeader({ alg: 'RS256' }).setSubject('sub').setIssuer(iss).setAudience(aud)
    .setIssuedAt().setExpirationTime(exp).sign(privateKey);
  const token = await sign();
  assert.equal((await verifyIdentity(token, 'client', 'nonce', publicKey)).sub, 'sub');
  await assert.rejects(verifyIdentity(token, 'client', 'wrong', publicKey));
  await assert.rejects(verifyIdentity(await sign('wrong'), 'client', 'nonce', publicKey));
  await assert.rejects(verifyIdentity(await sign('client', 'https://evil.invalid'), 'client', 'nonce', publicKey));
  await assert.rejects(verifyIdentity(await sign('client', ISSUER, Math.floor(Date.now() / 1000) - 60), 'client', 'nonce', publicKey));
  const other = await generateKeyPair('RS256');
  await assert.rejects(verifyIdentity(token, 'client', 'nonce', other.publicKey));
});
test('SSE 處理逐位元組中文與 CRLF', async () => {
  const bytes = new TextEncoder().encode('data: {"type":"test","text":"測試"}\r\n\r\n');
  async function* split() { for (const byte of bytes) yield new Uint8Array([byte]); }
  const events = []; for await (const event of readSSE(split())) events.push(event);
  assert.deepEqual(events,[{type:'test',text:'測試'}]);
});
test('登出清除憑證並保留 host 及帳號註冊', async t => {
  const f = await fixture(t);
  await f.request('/api/logout', {});
  assert.equal(f.account.access_token, undefined); assert.equal(f.account.refresh_token, undefined);
  assert.equal(f.account.client_id, 'oaiapp_test'); assert.equal(f.store.data.hostId, 'test-host');
  assert.equal((await f.request('/api/models')).status, 401);
});

test('Origin null 登入表單必須有正確 Cookie 與 CSRF，正常表單成功導向 OAuth', async t => {
  const f = await fixture(t);
  const headers = { Origin: 'null', 'Sec-Fetch-Site': 'same-origin' };
  assert.equal((await f.request('/auth/chatgpt', {}, { ...headers, 'X-CSRF-Token': 'wrong' })).status, 403);
  assert.equal((await f.request('/auth/chatgpt', {}, { ...headers, cookie: 'local_session=wrong' })).status, 401);
  const response = await f.request('/auth/chatgpt', {}, headers);
  assert.equal(response.status, 303);
  assert.match(response.headers.get('location'), /^https:\/\/auth.openai.com/);
  assert.equal((await f.request('/api/status', null, headers)).status, 403);
});
test('只開放 GPT 主版本 < 6 的模型', async t => {
  for (const slug of ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5']) assert.equal(allowedModel(slug), true, slug);
  for (const slug of ['gpt-6-astra', 'gpt-6', 'gpt-6.1-sol', 'gpt-7', 'o3', '']) assert.equal(allowedModel(slug), false, slug);
  const f = await fixture(t);
  assert.equal((await f.request('/api/analyze', { model: 'gpt-6-astra', text: '飯' })).status, 400);
});
test('Tailscale 遠端：每人獨立日誌，不能管理登入', async t => {
  const f = await fixture(t);
  const remote = login => ({ Host: 'pc.example.ts.net', Origin: 'https://pc.example.ts.net', ...(login ? { 'Tailscale-User-Login': login } : {}) });
  const meal = { name: '朋友午餐', day: '2026-10-02', time: '12:00', photo: '', items: [{ name: '飯', grams: 100, kcalPer100g: 130, source: 'manual' }] };
  assert.equal((await f.request('/api/journal?day=2026-10-02', null, remote())).status, 403);
  assert.equal((await f.request('/api/status', null, { Host: 'evil.ts.net' })).status, 403);
  assert.equal((await f.request('/api/meals', meal, remote('friend@example.com'))).status, 200);
  const friend = await (await f.request('/api/journal?day=2026-10-02', null, remote('Friend@example.com'))).json();
  assert.equal(friend.meals.length, 1);
  const owner = await (await f.request('/api/journal?day=2026-10-02', null, remote('owner@example.com'))).json();
  assert.equal(owner.meals.length, 0);
  assert.equal((await (await f.request('/api/journal?day=2026-10-02')).json()).meals.length, 0);
  const status = await (await f.request('/api/status', null, remote('friend@example.com'))).json();
  assert.equal(status.remote, true); assert.equal(status.user, 'friend@example.com');
  assert.equal(status.accounts.every(a => !a.email), true);
  assert.equal((await f.request('/auth/chatgpt', {}, remote('owner@example.com'))).status, 403);
  assert.equal((await f.request('/api/logout', {}, remote('owner@example.com'))).status, 403);
  const models = await f.request('/api/models', null, remote('friend@example.com'));
  assert.equal(models.status, 200); assert.deepEqual((await models.json()).models, []); // ChatGPT 未開放給朋友
  assert.deepEqual(status.accounts, []); assert.notEqual(status.activeId, 'oaiapp_test');
  const ownerStatus = await (await f.request('/api/status', null, remote('owner@example.com'))).json();
  assert.deepEqual(ownerStatus.accounts.map(a => a.client_id), [ownerStatus.activeId]); assert.notEqual(ownerStatus.activeId, 'oaiapp_test');
});
test('經 Tailscale 轉送卻偽造 Host: 127.0.0.1 不算本機', async t => {
  const f = await fixture(t);
  for (const header of [{ 'Tailscale-User-Login': 'friend@example.com' }, { 'Tailscale-User-Login': 'owner@example.com' },
    { 'X-Forwarded-For': '100.64.0.2' }, { 'X-Forwarded-Host': '127.0.0.1:3000' }, { 'X-Forwarded-Proto': 'https' }])
    for (const path of ['/api/providers', '/api/admin/journals', '/api/status', '/api/logout'])
      assert.equal((await f.request(path, path === '/api/logout' ? {} : null, header)).status, 403, path);
  assert.equal((await f.request('/api/providers')).status, 200);
});
test('遠端改大小寫或加結尾斜線也不能進入本機專用路由', async t => {
  const f = await fixture(t);
  const paths = [['/api/Providers'], ['/api/providers/'], ['/API/LOGOUT', {}], ['/Api/Account'], ['/AUTH/chatgpt'], ['/auth/chatgpt/', {}]];
  for (const login of ['owner@example.com', 'friend@example.com'])
    for (const [path, body] of paths)
      assert.ok([403, 404].includes((await f.request(path, body, { Host: 'pc.example.ts.net', Origin: 'https://pc.example.ts.net', 'Tailscale-User-Login': login })).status), `${login} ${path}`);
  assert.equal((await f.request('/api/Providers')).status, 200);
  assert.equal((await f.request('/api/providers/')).status, 200);
  assert.equal(f.account.access_token !== undefined, true);
});
test('管理員檢視：本機可唯讀瀏覽所有日誌，遠端（含擁有者手機）一律拒絕', async t => {
  const f = await fixture(t);
  const remote = login => ({ Host: 'pc.example.ts.net', Origin: 'https://pc.example.ts.net', 'Tailscale-User-Login': login });
  const meal = { name: '朋友早餐', day: '2026-10-02', time: '08:00', photo: '', items: [{ name: '蛋', grams: 50, kcalPer100g: 150, source: 'manual' }] };
  await f.request('/api/meals', meal, remote('friend@example.com'));
  const status = await (await f.request('/api/status')).json();
  assert.equal(status.admin, true);
  const list = (await (await f.request('/api/admin/journals')).json()).journals;
  assert.deepEqual(list.map(j => [j.login, j.meals]), [['owner@example.com', 0], ['friend@example.com', 1]]);
  const friend = await (await f.request('/api/admin/journals/' + list[1].id)).json();
  assert.equal(friend.meals[0].name, '朋友早餐'); assert.equal(friend.stats.kcalTotal, 75);
  const detail = await (await f.request(`/api/admin/journals/${list[1].id}/meals/${friend.meals[0].id}`)).json();
  assert.equal(detail.items[0].name, '蛋');
  for (const login of ['owner@example.com', 'friend@example.com']) {
    assert.equal((await f.request('/api/admin/journals', null, remote(login))).status, 403);
    assert.equal((await (await f.request('/api/status', null, remote(login))).json()).admin, false);
  }
  assert.equal((await f.request('/api/admin/journals/nope')).status, 404);
});
test('食物庫在 app 內唯讀：沒有新增、匯入路由，朋友讀到共用庫', async t => {
  const f = await fixture(t); f.journal.putFood({ name: '測試飯', kcalPer100g: 130, source: 'web' });
  for (const path of ['/api/foods', '/api/foods/import']) assert.equal((await f.request(path, { name: 'x', kcalPer100g: 1, foods: [] })).status, 404);
  const remote = { Host: 'pc.example.ts.net', Origin: 'https://pc.example.ts.net', 'Tailscale-User-Login': 'friend@example.com' };
  assert.deepEqual((await (await f.request('/api/foods', null, remote)).json()).foods.map(x => x.name), ['測試飯']);
});

// Claude 模擬用戶端：記錄每次 Messages 參數，依 claude.reply 回覆（預設回辨識 JSON）。
function claudeMock() {
  const claude = { calls: [], keys: [], validated: [] };
  // messages.countTokens 模擬金鑰驗證：claude.keyError 設定時丟出（401／網路錯誤等）。
  claude.factory = key => { claude.keys.push(key); return { messages: { countTokens: async params => {
    claude.validated.push(key); claude.validatedModel = params.model; if (claude.keyError) throw claude.keyError; return { input_tokens: 8 };
  } }, beta: { messages: { create: async params => {
    claude.calls.push(params);
    if (claude.error) throw claude.error;
    const text = claude.reply ? claude.reply(params) : JSON.stringify({ name: 'Claude餐', items: [{ name: '測試飯', grams: 100 }] });
    return { stop_reason: 'end_turn', content: [{ type: 'text', text }] };
  } } } }; };
  return claude;
}
const providers = (f, body) => f.request('/api/providers', body);

test('ChatGPT 額度分享：預設只供本機與擁有者；朋友略過 ChatGPT，CHATGPT_SHARED 開啟才可用', async t => {
  const remote = login => ({ Host: 'pc.example.ts.net', Origin: 'https://pc.example.ts.net', 'Tailscale-User-Login': login });
  const ready = async (f, headers) => (await (await f.request('/api/status', null, headers)).json());
  const off = await fixture(t); off.journal.putFood({ name: '測試飯', kcalPer100g: 130, source: 'manual' });
  assert.equal((await (await providers(off)).json()).providers[0].shared, false);
  assert.equal((await ready(off)).providersReady, true);
  assert.equal((await ready(off, remote('owner@example.com'))).providersReady, true);
  const friend = await ready(off, remote('friend@example.com'));
  assert.equal(friend.providersReady, false); assert.match(friend.providersError, /只供擁有者使用/);
  const denied = await off.request('/api/analyze', { model: 'gpt-5.6-terra', text: '飯' }, remote('friend@example.com'));
  assert.equal(denied.status, 401); assert.match((await denied.json()).error, /只供擁有者使用/);
  assert.equal(off.calls.responses.length, 0);
  assert.equal((await off.analyze({ model: 'gpt-5.6-terra', text: '飯' }, remote('owner@example.com'))).status, 'done');
  // 朋友：有 Claude 時略過 ChatGPT（即使 ChatGPT 排第一）。
  const claude = claudeMock(); const mixed = await fixture(t, { anthropicFactory: claude.factory });
  mixed.journal.putFood({ name: '測試飯', kcalPer100g: 130, source: 'manual' });
  await providers(mixed, { providers: [{ id: 'chatgpt', enabled: true }, { id: 'claude', enabled: true }], claudeApiKey: 'sk-ant-test-fake-0000' });
  assert.equal((await ready(mixed, remote('friend@example.com'))).providersReady, true);
  const before = mixed.calls.responses.length;
  const job = await mixed.analyze({ model: 'gpt-5.6-terra', text: '飯' }, remote('friend@example.com'));
  assert.equal(job.status, 'done'); assert.equal(job.result.servedBy.provider, 'claude'); assert.equal(mixed.calls.responses.length, before);
  const on = await fixture(t, { chatgptShared: true }); on.journal.putFood({ name: '測試飯', kcalPer100g: 130, source: 'manual' });
  assert.equal((await (await providers(on)).json()).providers[0].shared, true);
  const shared = await ready(on, remote('friend@example.com'));
  assert.equal(shared.providersReady, true); assert.equal('providersError' in shared, false);
  assert.equal((await on.analyze({ model: 'gpt-5.6-terra', text: '飯' }, remote('friend@example.com'))).result.servedBy.provider, 'chatgpt');
});
const remoteHeaders = { Host: 'pc.example.ts.net', Origin: 'https://pc.example.ts.net', 'Tailscale-User-Login': 'owner@example.com' };

test('AI 服務設定：預設 ChatGPT 優先、Claude 停用；保存順序與金鑰，GET 不洩漏金鑰；遠端一律 403', async t => {
  const claude = claudeMock(); const f = await fixture(t, { anthropicFactory: claude.factory });
  const initial = await (await providers(f)).json();
  assert.deepEqual(initial.providers.map(p => [p.id, p.enabled, p.ready, p.model]), [['chatgpt', true, true, ''], ['claude', false, false, 'claude-haiku-5-5']]);
  assert.deepEqual(initial.providers[0].models, []);
  assert.deepEqual(initial.providers[1].models.map(m => m.slug), ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']);
  assert.equal('keyHint' in initial.providers[1], false);
  const key = 'sk-ant-test-fake-1234';
  const saved = await (await providers(f, { providers: [{ id: 'claude', enabled: true, model: 'claude-sonnet-5-5' }, { id: 'chatgpt', enabled: false }], claudeApiKey: key })).json();
  assert.deepEqual(saved.providers.map(p => [p.id, p.enabled, p.ready, p.model]), [['claude', true, true, 'claude-sonnet-5-5'], ['chatgpt', false, true, '']]);
  assert.equal(saved.providers[0].keyHint, '••••1234'); assert.ok(!Number.isNaN(Date.parse(saved.providers[0].keyAddedAt)));
  assert.deepEqual(claude.validated, [key]); assert.equal(claude.validatedModel, 'claude-sonnet-5-5');
  assert.equal(f.store.data.providers[0].apiKey, key);
  const text = await (await providers(f)).text();
  assert.equal(text.includes(key), false); assert.equal(text.includes('apiKey'), false);
  // 未帶 claudeApiKey 保留金鑰；空字串清除。
  await providers(f, { providers: [{ id: 'chatgpt', enabled: true }, { id: 'claude', enabled: true, model: 'claude-opus-5-5' }] });
  assert.equal(f.store.data.providers[1].apiKey, key);
  const cleared = await (await providers(f, { providers: [{ id: 'chatgpt', enabled: true }, { id: 'claude', enabled: true }], claudeApiKey: '' })).json();
  assert.deepEqual(cleared.providers.map(p => [p.id, p.ready, 'keyHint' in p]), [['chatgpt', true, false], ['claude', false, false]]);
  for (const bad of [{ providers: [{ id: 'gemini', enabled: true }] }, { providers: [{ id: 'claude', enabled: true, model: 'gpt-5.6-sol' }] },
    { providers: [{ id: 'chatgpt', enabled: true }, { id: 'chatgpt', enabled: false }] }, { providers: [{ id: 'chatgpt', enabled: 'yes' }] },
    { providers: [{ id: 'chatgpt', enabled: true }], claudeApiKey: 'has space' }])
    assert.equal((await providers(f, bad)).status, 400);
  assert.equal((await f.request('/api/providers', null, remoteHeaders)).status, 403);
  assert.equal((await f.request('/api/providers', { providers: [] }, remoteHeaders)).status, 403);
});

test('providersReady：只有 Claude 金鑰也能分析；請求的空 model 不影響 Claude', async t => {
  const claude = claudeMock(); const f = await fixture(t, { anthropicFactory: claude.factory });
  f.journal.putFood({ name: '測試飯', kcalPer100g: 130, source: 'manual' });
  delete f.account.access_token; delete f.account.refresh_token;
  assert.equal((await (await f.request('/api/status')).json()).providersReady, false);
  assert.equal((await f.request('/api/analyze', { model: '', text: '飯' })).status, 401);
  await providers(f, { providers: [{ id: 'chatgpt', enabled: true }, { id: 'claude', enabled: true, model: 'claude-opus-5-5' }], claudeApiKey: 'sk-ant-test-fake-0000' });
  assert.equal((await (await f.request('/api/status')).json()).providersReady, true);
  const job = await f.analyze({ model: '', text: '飯' });
  assert.equal(job.status, 'done'); assert.deepEqual(job.result.servedBy, { provider: 'claude', model: 'claude-opus-5-5' });
  assert.equal(f.calls.responses.length, 0); assert.ok(claude.keys.every(k => k === 'sk-ant-test-fake-0000'));
  // ChatGPT 為第一順位但未登入：由備援 Claude 處理，備註加註 Claude 模型。
  assert.match(job.result.items[0].notes, /（由 Claude Opus 5\.5 處理）$/);
  const params = claude.calls[0];
  assert.equal(params.model, 'claude-opus-5-5'); assert.deepEqual(params.thinking, { type: 'adaptive' }); assert.equal(params.output_config.effort, 'medium');
  assert.equal(params.fallbacks, 'default'); assert.deepEqual(params.betas, ['server-side-fallback-2026-07-01']);
  assert.equal(params.messages[0].content[1].text, '飯');
});

test('服務順序：第一個啟用者優先；停用者跳過；ChatGPT 429／400 改用 Claude 並加註；404 不換服務', async t => {
  const claude = claudeMock(); const f = await fixture(t, { anthropicFactory: claude.factory });
  f.journal.putFood({ name: '測試飯', kcalPer100g: 130, source: 'manual' });
  // Claude 停用：ChatGPT 額度錯誤照舊直接失敗。
  await providers(f, { providers: [{ id: 'chatgpt', enabled: true }, { id: 'claude', enabled: false }], claudeApiKey: 'sk-ant-test-fake-0000' });
  f.calls.status = 429;
  assert.match((await f.analyze({ model: 'gpt-5.6-terra', text: '飯' })).error, /HTTP 429/); assert.equal(claude.calls.length, 0);
  // 啟用 Claude 為第二順位：429 換 Claude。
  await providers(f, { providers: [{ id: 'chatgpt', enabled: true }, { id: 'claude', enabled: true, model: 'claude-haiku-5-5' }] });
  const job = await f.analyze({ model: 'gpt-5.6-terra', text: '飯' });
  assert.equal(job.status, 'done'); assert.deepEqual(job.result.servedBy, { provider: 'claude', model: 'claude-haiku-5-5' });
  assert.match(job.result.items[0].notes, /（由 Claude Haiku 5\.5 處理）$/); assert.equal(claude.calls.length, 1);
  assert.equal('fallbacks' in claude.calls[0], false); // Haiku 沒有伺服器端 refusal fallback
  // 400：該服務不接受此要求，換下一個服務；404 不換。
  f.calls.status = 400;
  const rejected = await f.analyze({ model: 'gpt-5.6-terra', text: '飯' });
  assert.equal(rejected.status, 'done'); assert.deepEqual(rejected.result.servedBy, { provider: 'claude', model: 'claude-haiku-5-5' }); assert.equal(claude.calls.length, 2);
  f.calls.status = 404;
  const bad = await f.analyze({ model: 'gpt-5.6-terra', text: '飯' });
  assert.equal(bad.status, 'error'); assert.match(bad.error, /HTTP 404/); assert.equal(claude.calls.length, 2);
  // ChatGPT 正常：由第一順位處理，也加註模型名稱；食物庫裡帶舊標註的備註只保留一個標註。
  f.calls.status = 0; f.journal.putFood({ name: '舊標註飯', kcalPer100g: 130, source: 'manual', notes: '備註（由 Claude Haiku 5.5 處理）' });
  const ok = await (await f.request('/api/estimate', { model: 'gpt-5.6-terra', name: '飯', fallback: 'llm' })).json();
  assert.deepEqual(ok.servedBy, { provider: 'chatgpt', model: 'gpt-5.6-terra' }); assert.match(ok.items[0].notes, /（由 Test model 處理）$/);
  f.calls.reply = JSON.stringify({ name: '測試餐', items: [{ name: '舊標註飯', grams: 100 }] });
  const retag = await (await f.request('/api/estimate', { model: 'gpt-5.6-terra', name: '舊標註飯', fallback: 'llm' })).json();
  assert.equal(retag.items[0].notes, '備註（由 Test model 處理）'); f.calls.reply = undefined;
  // Claude 排第一：只呼叫 Claude；Claude 429 再換 ChatGPT。
  await providers(f, { providers: [{ id: 'claude', enabled: true }, { id: 'chatgpt', enabled: true }] });
  const before = f.calls.responses.length;
  const first = await (await f.request('/api/estimate', { model: 'gpt-5.6-terra', name: '飯', fallback: 'llm' })).json();
  assert.equal(first.servedBy.provider, 'claude'); assert.equal(f.calls.responses.length, before);
  claude.error = Object.assign(new Error('rate limited'), { status: 429 });
  const back = await (await f.request('/api/estimate', { model: 'gpt-5.6-terra', name: '飯', fallback: 'llm' })).json();
  assert.equal(back.servedBy.provider, 'chatgpt'); assert.match(back.items[0].notes, /（由 Test model 處理）$/);
  // 兩者都失敗：回傳最後一個錯誤。
  f.calls.status = 503;
  const failed = await f.request('/api/estimate', { model: 'gpt-5.6-terra', name: '飯', fallback: 'llm' });
  assert.equal(failed.status, 503); assert.match((await failed.json()).error, /OpenAI 要求失敗（HTTP 503/);
});

test('Claude 金鑰：先驗證再保存；無效／網路失敗回 400 不保存；回應與錯誤不含金鑰；清除立即刪除；ChatGPT 帶帳號清單', async t => {
  const claude = claudeMock(); const f = await fixture(t, { anthropicFactory: claude.factory });
  const key = 'sk-ant-test-fake-leak-5678';
  const texts = [];
  const post = async body => { const r = await providers(f, body); const text = await r.text(); texts.push(text); return { status: r.status, body: JSON.parse(text) }; };
  const order = [{ id: 'chatgpt', enabled: true }, { id: 'claude', enabled: true }];
  claude.keyError = Object.assign(new Error(`invalid x-api-key ${key}`), { status: 401 });
  let r = await post({ providers: order, claudeApiKey: key });
  assert.equal(r.status, 400); assert.equal(r.body.error, 'Claude API key 無效，請確認後再試。');
  claude.keyError = Object.assign(new Error(`connect ECONNREFUSED ${key}`), { cause: 'net' });
  r = await post({ providers: order, claudeApiKey: key });
  assert.equal(r.status, 400); assert.equal(r.body.error, '無法驗證 Claude API key，請稍後再試。');
  assert.equal(f.store.data.providers, undefined); // 失敗時連順序都不保存
  claude.keyError = null;
  r = await post({ providers: order, claudeApiKey: ` ${key} ` });
  const entry = r.body.providers.find(p => p.id === 'claude');
  assert.equal(entry.keyHint, '••••5678'); assert.ok(Date.parse(entry.keyAddedAt) <= Date.now());
  assert.equal(f.store.data.providers[1].apiKey, key); assert.equal(f.store.data.providers[1].keyAddedAt, entry.keyAddedAt);
  // ChatGPT 項目帶與 /api/status 相同的安全帳號欄位。
  const chatgpt = r.body.providers.find(p => p.id === 'chatgpt');
  assert.deepEqual(chatgpt.accounts, (await (await f.request('/api/status')).json()).accounts);
  assert.deepEqual(Object.keys(chatgpt.accounts[0]).sort(), ['client_id', 'planEnabled', 'signedIn']); // 無 token 欄位
  assert.equal(chatgpt.activeId, 'oaiapp_test');
  // 未帶金鑰：保留金鑰與加入時間，不再驗證。
  const validations = claude.validated.length;
  r = await post({ providers: [{ id: 'claude', enabled: true, model: 'claude-sonnet-5-5' }, { id: 'chatgpt', enabled: true }] });
  assert.equal(r.body.providers[0].keyAddedAt, entry.keyAddedAt); assert.equal(claude.validated.length, validations);
  // 清除：不驗證、立即刪除，其他設定不變。
  r = await post({ providers: [{ id: 'claude', enabled: true }, { id: 'chatgpt', enabled: true }], claudeApiKey: '' });
  assert.equal(claude.validated.length, validations);
  assert.deepEqual(r.body.providers.map(p => [p.id, p.enabled, p.ready, 'keyHint' in p, 'keyAddedAt' in p]), [['claude', true, false, false, false], ['chatgpt', true, true, false, false]]);
  assert.equal(f.store.data.providers[0].apiKey, ''); assert.equal('keyAddedAt' in f.store.data.providers[0], false);
  texts.push(await (await providers(f)).text(), await (await f.request('/api/status')).text());
  for (const text of texts) assert.equal(text.includes(key), false);
});
