import test from 'node:test';
import assert from 'node:assert/strict';
import { claudeInfer, validateClaudeKey } from '../server/claude.js';
import { analyzeMeal, lookupItem, RECOGNITION_SCHEMA, ESTIMATE_SCHEMA } from '../server/food-analysis.js';
import { fallbackWorthy } from '../server/food-routes.js';
import { createJournal } from '../server/journal.js';

const client = replies => {
  const calls = [];
  return { calls, beta: { messages: { create: async (params, options) => { calls.push({ params: structuredClone(params), options }); return replies.shift(); } } } };
};

test('Claude：搜尋引用轉成 citations、pause_turn 續跑、強制搜尋改寫進系統提示，結果標記為 web', async () => {
  const answer = JSON.stringify({ kcalPer100g: 135, sourceUrl: 'https://example.org/rice/', sourceTitle: '例', notes: '' });
  const fake = client([
    { stop_reason: 'pause_turn', content: [{ type: 'text', text: '我先搜尋。' }, { type: 'server_tool_use', id: 's1', name: 'web_search', input: { query: '白飯 熱量' } }] },
    { stop_reason: 'end_turn', content: [
      { type: 'web_search_tool_result', tool_use_id: 's1', content: [{ type: 'web_search_result', url: 'https://example.org/rice', title: '食品資料' }] },
      { type: 'text', text: answer.slice(0, 20), citations: [{ type: 'web_search_result_location', url: 'https://example.org/rice?utm_source=x', title: '食品資料', cited_text: '135' }] },
      { type: 'text', text: answer.slice(20), citations: null }] }]);
  const db = createJournal(':memory:');
  const item = { id: 'i1', name: '白飯', aliases: [], grams: 200, confidence: 'high', portionNote: '', portionBasis: 'reference' };
  const result = await lookupItem({ item, fallback: 'web', journal: db, infer: body => claudeInfer(fake, 'claude-opus-5-5')(body), emit() {}, warnings: [] });
  assert.deepEqual([result.source, result.sourceUrl, result.sourceTitle, result.kcalPer100g], ['web', 'https://example.org/rice', '食品資料', 135]);
  const [first, second] = fake.calls;
  assert.deepEqual(first.params.tools, [{ type: 'web_search_20260209', name: 'web_search' }]); assert.equal('tool_choice' in first.params, false);
  assert.match(first.params.system, /必須先使用 web_search/);
  assert.equal(second.params.messages.at(-1).role, 'assistant'); assert.equal(second.params.messages.at(-1).content[1].type, 'server_tool_use');
  db.close();
});

test('Claude：圖片轉 base64 區塊；搜尋錯誤不算已搜尋；refusal、max_tokens 為錯誤；SDK 錯誤保留 status', async () => {
  const fake = client([{ stop_reason: 'end_turn', content: [{ type: 'web_search_tool_result', content: { type: 'web_search_tool_result_error', error_code: 'unavailable' } }, { type: 'text', text: '{}' }] }]);
  const out = await claudeInfer(fake, 'claude-sonnet-5-5')({ instructions: 'x', tools: [{ type: 'web_search' }], tool_choice: 'auto',
    input: [{ role: 'user', content: [{ type: 'input_text', text: '看圖' }, { type: 'input_image', image_url: 'data:image/png;base64,AAAA', detail: 'auto' }] }] });
  assert.deepEqual(out, { text: '{}', citations: [], searched: false });
  assert.deepEqual(fake.calls[0].params.messages[0].content[1], { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } });
  assert.doesNotMatch(fake.calls[0].params.system, /必須先使用/);
  const body = { instructions: 'x', input: [{ role: 'user', content: 'y' }] };
  await assert.rejects(claudeInfer(client([{ stop_reason: 'refusal', content: [] }]), 'claude-opus-5-5')(body), /拒絕/);
  await assert.rejects(claudeInfer(client([{ stop_reason: 'max_tokens', content: [] }]), 'claude-opus-5-5')(body), /過長/);
  const failing = status => ({ beta: { messages: { create: async () => { throw Object.assign(new Error('x'), { status }); } } } });
  for (const [status, worthy] of [[401, true], [403, true], [429, true], [529, true], [500, true], [400, true], [404, false]]) {
    const error = await claudeInfer(failing(status), 'claude-opus-5-5')(body).catch(e => e);
    assert.equal(error.status, status); assert.match(error.message, /Claude 要求失敗/); assert.equal(fallbackWorthy(error), worthy, String(status));
  }
});

test('fallbackWorthy：逾時、網路、額度訊息可換；中止與 JSON 錯誤不換', () => {
  assert.equal(fallbackWorthy({ timeout: true }), true);
  assert.equal(fallbackWorthy(new TypeError('fetch failed')), true);
  assert.equal(fallbackWorthy(new Error('模型分析未完成（usage_limit_reached），請檢查額度或重試。')), true);
  assert.equal(fallbackWorthy(new DOMException('Aborted', 'AbortError')), false);
  assert.equal(fallbackWorthy(new Error('模型未回傳完整的食物資料，請重試或改用手動新增。')), false);
  assert.equal(fallbackWorthy(new Error('Claude 拒絕處理這個要求，請改寫描述或手動新增。')), false);
  assert.equal(fallbackWorthy(new Error('模型分析未完成（invalid_request_error），請重試。')), true);
});

test('Claude：錯誤附上 API 的簡短說明（截斷、遮蔽金鑰）', async () => {
  const body = { instructions: 'x', input: [{ role: 'user', content: 'y' }] };
  const failing = (status, message) => ({ beta: { messages: { create: async () => { throw Object.assign(new Error('x'), { status, error: { type: 'error', error: { type: 'invalid_request_error', message } } }); } } } });
  const error = await claudeInfer(failing(400, `This API key is not scoped to a workspace, key sk-ant-test-SECRET_x-1 ${'z'.repeat(300)}`), 'claude-haiku-5-5')(body).catch(e => e);
  assert.match(error.message, /^Claude 要求失敗（HTTP 400）：This API key is not scoped to a workspace, key sk-ant-\*\*\* z+$/);
  assert.equal(error.message.includes('SECRET'), false); assert.ok(error.message.length < 240); assert.equal(fallbackWorthy(error), true);
  assert.match((await claudeInfer(failing(401, 'invalid x-api-key'), 'claude-haiku-5-5')(body).catch(e => e)).message, /：invalid x-api-key 請檢查 API key。$/);
});

test('Claude：Haiku 辨識請求（文字＋JPEG）只送合法參數，圖片轉成 base64 image 區塊', async () => {
  const fake = client([{ stop_reason: 'end_turn', content: [{ type: 'text', text: '{"items":[]}' }] }]);
  await claudeInfer(fake, 'claude-haiku-5-5')({ instructions: '辨識', input: [{ role: 'user', content: [{ type: 'input_text', text: '一份便當' },
    { type: 'input_image', image_url: 'data:image/jpeg;base64,/9j/AAAA', detail: 'auto' }] }] });
  const { params } = fake.calls[0];
  assert.deepEqual(Object.keys(params).sort(), ['max_tokens', 'messages', 'model', 'output_config', 'system', 'thinking']);
  assert.deepEqual([params.model, params.system, params.thinking, params.output_config], ['claude-haiku-5-5', '辨識', { type: 'adaptive' }, { effort: 'medium' }]);
  assert.deepEqual(params.messages, [{ role: 'user', content: [{ type: 'text', text: '一份便當' },
    { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: '/9j/AAAA' } }] }]);
});

test('Claude：web search 依模型選版本；Opus／Sonnet 帶 fallbacks，Haiku 用基本版且不帶 fallbacks', async () => {
  const body = { instructions: 'x', input: [{ role: 'user', content: 'y' }], tools: [{ type: 'web_search' }] };
  for (const [model, type, fallback] of [['claude-opus-5-5', 'web_search_20260209', true], ['claude-sonnet-5-5', 'web_search_20260209', true], ['claude-haiku-5-5', 'web_search_20250305', false]]) {
    const fake = client([{ stop_reason: 'end_turn', content: [{ type: 'text', text: '{}' }] }]);
    await claudeInfer(fake, model)(body);
    const { params } = fake.calls[0];
    assert.deepEqual(params.tools, [{ type, name: 'web_search' }], model);
    assert.equal(params.fallbacks, fallback ? 'default' : undefined, model);
    assert.deepEqual(params.betas, fallback ? ['server-side-fallback-2026-07-01'] : undefined, model);
    assert.deepEqual(params.thinking, { type: 'adaptive' }); assert.equal(params.output_config.effort, 'medium');
  }
});

test('validateClaudeKey：以所選模型 countTokens 驗證；401/403 無效、未綁定工作區另行說明、其他為無法驗證；錯誤不含金鑰', async () => {
  const key = 'sk-ant-test-fake-leak-9999';
  let model;
  const factory = error => k => ({ messages: { countTokens: async params => { model = params.model; if (error) throw Object.assign(new Error(`bad key ${k}`), error); return { input_tokens: 8 }; } } });
  await validateClaudeKey(factory(null), key, 'claude-opus-5-5'); assert.equal(model, 'claude-opus-5-5');
  const workspace = { status: 400, error: { error: { message: `This API key is not scoped to a workspace (${key})` } } };
  for (const [error, message] of [[{ status: 401 }, /無效/], [{ status: 403 }, /無效/], [{ status: 429 }, /無法驗證/], [{ cause: 'ECONNRESET' }, /無法驗證/],
    [workspace, /沒有綁定工作區/], [{ status: 400 }, /無法驗證/]]) {
    const thrown = await validateClaudeKey(factory(error), key).catch(e => e);
    assert.match(thrown.message, message); assert.equal(thrown.status, 400);
    assert.equal(JSON.stringify({ m: thrown.message, s: thrown.stack, c: thrown.cause }).includes(key), false);
  }
});

// strict 規則：每個 object 都 additionalProperties:false 且所有欄位必填；不含 API 不支援的數值／長度限制。
function assertStrict(node, at = 'root') {
  if (Array.isArray(node)) return node.forEach((n, i) => assertStrict(n, `${at}[${i}]`));
  if (!node || typeof node !== 'object') return;
  for (const k of ['minimum', 'maximum', 'multipleOf', 'minLength', 'maxLength', 'minItems', 'maxItems']) assert.equal(k in node, false, `${at}.${k}`);
  if (node.type === 'object') {
    assert.equal(node.additionalProperties, false, at);
    assert.deepEqual([...node.required].sort(), Object.keys(node.properties).sort(), at);
  }
  for (const [k, v] of Object.entries(node)) if (typeof v === 'object') assertStrict(v, `${at}.${k}`);
}

test('結構化輸出 schema 符合 strict 規則', () => {
  for (const { name, schema } of [RECOGNITION_SCHEMA, ESTIMATE_SCHEMA]) { assert.match(name, /^[a-z_]+$/); assert.equal(schema.type, 'object'); assertStrict(schema, name); }
  assert.deepEqual(Object.keys(RECOGNITION_SCHEMA.schema.properties.items.items.properties),
    ['name', 'aliases', 'grams', 'confidence', 'portionBasis', 'portionNote', 'labelKcalPer100g']);
  assert.deepEqual(Object.keys(ESTIMATE_SCHEMA.schema.properties), ['kcalPer100g', 'sourceUrl', 'sourceTitle', 'notes', 'servingGrams', 'sameAs']);
});

test('Claude：辨識與估算帶 output_config.format（json_schema）與 effort；搜尋不帶', async () => {
  const text = data => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(data) }] });
  const nutrition = { kcalPer100g: 130, sourceUrl: '', sourceTitle: '', notes: '', servingGrams: null };
  const fake = client([
    text({ name: '午餐', note: '', items: [{ name: '白飯', aliases: [], grams: 200, confidence: 'high', portionBasis: 'reference', portionNote: '', labelKcalPer100g: null }] }),
    text(nutrition), text({ ...nutrition, sameAs: null })]);
  const db = createJournal(':memory:');
  const result = await analyzeMeal({ text: '白飯', photo: '', fallback: 'web', journal: db, emit() {}, infer: claudeInfer(fake, 'claude-opus-5-5') });
  assert.equal(result.items[0].source, 'llm');
  const [recognition, search, estimate] = fake.calls.map(c => c.params);
  assert.deepEqual(recognition.output_config, { effort: 'medium', format: { type: 'json_schema', schema: RECOGNITION_SCHEMA.schema } });
  assert.deepEqual(search.output_config, { effort: 'medium' }); assert.ok(search.tools);
  assert.deepEqual(estimate.output_config, { effort: 'medium', format: { type: 'json_schema', schema: ESTIMATE_SCHEMA.schema } });
  for (const p of fake.calls) assert.equal('schema' in p.params, false);
  db.close();
});
