import Anthropic from '@anthropic-ai/sdk';
import { safeUrl } from './journal.js';

// 可選的 Claude 模型；預設 Haiku 5.5（最便宜，辨識與查詢已足夠）。
export const CLAUDE_MODELS = [
  { slug: 'claude-opus-5-5', display_name: 'Claude Opus 5.5' },
  { slug: 'claude-sonnet-5-5', display_name: 'Claude Sonnet 5.5' },
  { slug: 'claude-haiku-5-5', display_name: 'Claude Haiku 5.5' },
];
export const DEFAULT_CLAUDE_MODEL = 'claude-haiku-5-5';
// 安全分類器拒絕時由 API 端改用建議模型重跑（Haiku 沒有伺服器端 fallback）。
const REFUSAL_FALLBACK = new Set(['claude-opus-5-5', 'claude-sonnet-5-5']);
// 動態過濾版 web_search_20260209 只支援 Opus／Sonnet；Haiku 5.5 用基本版。
export const webSearchTool = model => ({ type: REFUSAL_FALLBACK.has(model) ? 'web_search_20260209' : 'web_search_20250305', name: 'web_search' });

export const createClaudeClient = apiKey => new Anthropic({ apiKey, maxRetries: 1 });

// 把 Responses 風格的 infer body 轉成 Messages API；回傳 { text, citations, searched }，與 ChatGPT 路徑相同。
export function claudeInfer(client, model) {
  return async ({ instructions, input, tools, tool_choice, schema }, signal) => {
    const search = (tools || []).some(t => t.type === 'web_search');
    // Opus 5.5 不接受強制 tool_choice，改在系統提示要求搜尋。
    const system = instructions + (search && tool_choice === 'required' ? '\n回答前必須先使用 web_search 工具搜尋。' : '');
    const messages = input.map(m => ({ role: m.role, content: typeof m.content === 'string' ? m.content : m.content.map(part) }));
    const params = { model, max_tokens: 16000, system, thinking: { type: 'adaptive' },
      output_config: { effort: 'medium', ...(schema && { format: { type: 'json_schema', schema: schema.schema } }) },
      ...(search && { tools: [webSearchTool(model)] }),
      ...(REFUSAL_FALLBACK.has(model) && { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' }) };
    const blocks = [];
    for (;;) {
      let response;
      try { response = await client.beta.messages.create({ ...params, messages }, { signal }); }
      catch (error) { throw mapError(error); }
      blocks.push(...response.content);
      // 伺服器端工具迴圈暫停：把助理回合原樣送回即可繼續。
      if (response.stop_reason === 'pause_turn') { messages.push({ role: 'assistant', content: response.content }); continue; }
      if (response.stop_reason === 'refusal') throw new Error('Claude 拒絕處理這個要求，請改寫描述或手動新增。');
      if (response.stop_reason === 'max_tokens') throw new Error('Claude 回應過長未完成，請重試。');
      break;
    }
    // 搜尋前的說明文字不算答案：只取最後一個工具結果之後的文字（引用會把答案拆成多個 text 區塊）。
    const last = blocks.findLastIndex(b => b.type === 'server_tool_use' || b.type === 'web_search_tool_result');
    const texts = blocks.slice(last + 1).filter(b => b.type === 'text');
    const citations = blocks.filter(b => b.type === 'text').flatMap(b => b.citations || [])
      .filter(c => c.type === 'web_search_result_location' && safeUrl(c.url))
      .map(c => ({ url: safeUrl(c.url), title: c.title || c.url }));
    const searched = blocks.some(b => b.type === 'web_search_tool_result' && Array.isArray(b.content));
    return { text: texts.map(b => b.text).join(''), citations, searched };
  };
}

// 用免費的 Token Counting API（所選模型）驗證金鑰：比 Models API 多擋下不能呼叫 Messages 的金鑰（如未綁定工作區）。
// 錯誤訊息自行產生，絕不帶出 SDK 原文或金鑰。
export async function validateClaudeKey(factory, apiKey, model = DEFAULT_CLAUDE_MODEL) {
  try { await factory(apiKey).messages.countTokens({ model, messages: [{ role: 'user', content: 'hi' }] }, { timeout: 15000 }); }
  catch (error) {
    const workspace = error?.status === 400 && /workspace/i.test(error.error?.error?.message || '');
    throw Object.assign(new Error(workspace ? '這把 Claude API key 沒有綁定工作區，請在 Claude Console 的工作區內建立 API key。'
      : [401, 403].includes(error?.status) ? 'Claude API key 無效，請確認後再試。' : '無法驗證 Claude API key，請稍後再試。'), { status: 400 });
  }
}

function part(p) {
  if (p.type === 'input_text') return { type: 'text', text: p.text };
  const image = p.type === 'input_image' && /^data:(image\/[a-z]+);base64,(.+)$/.exec(p.image_url);
  if (!image) throw new Error('Claude 不支援這種輸入格式。');
  return { type: 'image', source: { type: 'base64', media_type: image[1], data: image[2] } };
}

// SDK 錯誤轉成中文訊息並保留 status；中止交給呼叫端（逾時重試依 signal 判斷）。
function mapError(error) {
  if (error instanceof Anthropic.APIUserAbortError) return error;
  if (error instanceof Anthropic.APIConnectionError) return Object.assign(new Error('Claude 連線失敗，請檢查網路後重試。'), { network: true });
  if (typeof error?.status === 'number') {
    // 附上 API 自己的簡短說明（最多 200 字，遮蔽任何像金鑰的字串）。
    const detail = typeof error.error?.error?.message === 'string' ? redactKey(error.error.error.message).slice(0, 200) : '';
    const hint = [401, 403].includes(error.status) ? '請檢查 API key。' : error.status === 400 ? '' : '請查看帳號用量或重試。';
    return Object.assign(new Error(`Claude 要求失敗（HTTP ${error.status}）${detail ? `：${detail}${hint && ` ${hint}`}` : `。${hint || '要求格式不符。'}`}`),
      { status: error.status });
  }
  return error;
}

export const redactKey = text => String(text).replace(/sk-ant-[\w-]*/gi, 'sk-ant-***');
