import express from 'express';
import { createOAuth, createTransaction, random, RESOURCE } from './oauth.js';
import { attachFoodRoutes, fallbackWorthy } from './food-routes.js';
import { collectResponse } from './food-analysis.js';
import { CLAUDE_MODELS, DEFAULT_CLAUDE_MODEL, claudeInfer, createClaudeClient, validateClaudeKey } from './claude.js';

// 只開放 GPT 主版本 < 6 的模型；無法辨識版本的 slug 一律不開放。
export function allowedModel(slug) {
  const match = /^gpt-(\d+)(?:\.\d+)?(?:-|$)/i.exec(String(slug));
  return !!match && Number(match[1]) < 6;
}

export function createApp({ store, origin, remoteOrigins = [], ownerLogin = '', journalFor = null, listJournals = null,
  oauth = createOAuth(), fetcher = fetch, journal = null, anthropicFactory = createClaudeClient, chatgptShared = false, friendsCache = false, devMode = false }) {
  const app = express();
  // 遠端網址（例如 Tailscale serve 的 https://xxx.ts.net）只能使用日誌，不能管理 ChatGPT 登入。
  const origins = [origin, ...remoteOrigins];
  const remoteHosts = new Set(remoteOrigins.map(o => new URL(o).host));
  const sessions = new Map();
  const pending = new Map();
  const refreshing = new Map();
  const running = new Set();
  let catalog = null;
  let authEpoch = 0;
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    // Step 1：只接受本機同源要求，防止其他網站使用已登入的本機服務。
    // Tailscale serve 保留用戶端送來的 Host，並加上 Tailscale-User-Login、X-Forwarded-*；帶這些標頭的要求一律不算本機，防止偽造 Host: 127.0.0.1。
    const proxied = ['tailscale-user-login', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto'].some(h => h in req.headers);
    const remote = remoteHosts.has(req.headers.host);
    if ((req.headers.host !== new URL(origin).host || proxied) && !remote) return res.status(403).json({ error: '請使用終端機顯示的 127.0.0.1 網址。' });
    req.remote = remote;
    // npm run dev 的 Vite 會送出專案根目錄檔案，開發模式拒絕所有遠端要求。
    if (remote && devMode) return res.status(403).json({ error: '開發模式只限本機使用。' });
    // 遠端使用者由 Tailscale serve 附上的 Tailscale-User-Login 區分，每人一本日誌；本機與擁有者共用主日誌。
    req.journal = journal;
    if (remote) {
      const login = req.headers['tailscale-user-login'];
      if (typeof login !== 'string' || !login) return res.status(403).json({ error: '請透過 Tailscale 連線。' });
      req.user = login;
      if (login.toLowerCase() !== ownerLogin.toLowerCase()) {
        if (!journalFor) return res.status(403).json({ error: '這台電腦未開放其他使用者。' });
        req.journal = journalFor(login.toLowerCase()); req.friend = true;
      }
    }
    // OAuth 回程網址固定為 127.0.0.1，登入、切換、登出只能在電腦上操作。
    // Express 路由不分大小寫且容許結尾斜線，比對前先正規化，避免 /API/Providers/ 繞過。
    const path = req.path.toLowerCase().replace(/\/+$/, '');
    if (remote && (path === '/auth' || path.startsWith('/auth/') || ['/api/account', '/api/logout', '/api/providers'].includes(path)))
      return res.status(403).json({ error: '請在電腦上開啟 127.0.0.1 管理 ChatGPT 登入。' });
    const callback = req.path === '/auth/callback';
    // 首頁 GET 只回傳公開 UI，不依賴瀏覽器是否附帶導覽標頭。
    // API、登入 POST 及其他請求仍必須通過來源與 CSRF 檢查。
    const homeNavigation = req.method === 'GET' && req.path === '/';
    // Origin:null 的原生登入表單延後由 session + CSRF 驗證，不能單靠來源標頭放行。
    const opaqueLogin = req.method === 'POST' && req.path === '/auth/chatgpt' &&
      (!req.headers.origin || req.headers.origin === 'null');
    if (!callback && !homeNavigation && !opaqueLogin && ((req.headers.origin && !origins.includes(req.headers.origin)) ||
      ['cross-site', 'same-site'].includes(req.headers['sec-fetch-site']))) return res.status(403).json({
        error: '拒絕跨來源要求。', version: '2.0.0', path: req.path, method: req.method,
      });
    const cookie = req.headers.cookie?.split('; ').find(x => x.startsWith('local_session='))?.slice(14);
    let session = sessions.get(cookie);
    if (session && session.expiresAt < Date.now()) { sessions.delete(cookie); session = null; }
    if (!session && req.method === 'GET' && req.path === '/') {
      const id = random();
      session = { id, csrf: random(), expiresAt: Date.now() + 24 * 3600_000 };
      if (sessions.size >= 1000) sessions.delete(sessions.keys().next().value); // 上限 1000，淘汰最舊的
      sessions.set(id, session);
      res.cookie('local_session', id, { httpOnly: true, sameSite: 'lax', path: '/', maxAge: 24 * 3600_000, secure: remote });
    }
    req.localSession = session;
    next();
  });
  app.use(express.json({ limit: '8mb' }));
  app.use(express.urlencoded({ extended: false }));
  app.use(['/api', '/auth/chatgpt'], (req, res, next) => {
    if (!req.localSession) return res.status(401).json({ error: '請重新開啟首頁。' });
    if (req.method !== 'GET' && (req.headers['x-csrf-token'] || req.body?.csrf) !== req.localSession.csrf)
      return res.status(403).json({ error: '操作驗證失敗，請重新整理。' });
    next();
  });
  function active() {
    return store.data.accounts.find(a => a.client_id === store.data.activeId);
  }
  function signedIn() {
    const account = active();
    if (!account?.access_token) throw Object.assign(new Error('請先登入 ChatGPT。'), { status: 401 });
    if (!account.scopes?.includes('chatgpt.tokens.use.direct')) throw Object.assign(new Error('已登入，但未授權 ChatGPT plan 使用權；請重新授權。'), { status: 403 });
    return account;
  }
  // AI 服務順序：每次呼叫用第一個啟用且可用的服務，失敗（授權、額度、伺服器、逾時、網路）才換下一個。
  // ChatGPT 的模型沿用各日誌的 settings.model（請求帶來的 model），這裡不保存。
  function providerConfig() {
    const saved = Array.isArray(store.data.providers) ? store.data.providers : [];
    const defaults = [{ id: 'chatgpt', enabled: true }, { id: 'claude', enabled: false, model: DEFAULT_CLAUDE_MODEL, apiKey: '' }];
    const list = defaults.map(d => ({ ...d, ...saved.find(p => p?.id === d.id) }))
      .map(p => p.id === 'claude' && !CLAUDE_MODELS.some(m => m.slug === p.model) ? { ...p, model: DEFAULT_CLAUDE_MODEL } : p);
    return list.sort((a, b) => (saved.findIndex(p => p?.id === a.id) + 1 || 9) - (saved.findIndex(p => p?.id === b.id) + 1 || 9));
  }
  // ChatGPT 額度預設只供擁有者（本機或 OWNER_LOGIN）使用；CHATGPT_SHARED=1 才開放朋友，朋友的服務順序直接略過 ChatGPT。
  const chatgptFor = req => chatgptShared || !req?.friend;
  function providerReady(p, req) {
    if (p.id === 'claude') return !!p.apiKey;
    if (!chatgptFor(req)) return false;
    const account = active();
    return !!account?.access_token && !!account.scopes?.includes('chatgpt.tokens.use.direct');
  }
  const providersReady = req => providerConfig().some(p => p.enabled && providerReady(p, req));
  const providersError = req => chatgptFor(req) ? '尚無可用的 AI 服務：請先登入 ChatGPT，或在設定中加入 Claude API key。'
    : '此伺服器的 ChatGPT 額度只供擁有者使用；請請擁有者設定 Claude 等 API key 服務。';
  function requireProvider(req) {
    if (!providersReady(req)) throw Object.assign(new Error(providersError(req)), { status: 401 });
  }
  // 帳號清單只含與 /api/status 相同的安全欄位（不含 token）；/api/providers 只在本機開放。
  const accountsView = remote => store.data.accounts.map(a => ({ client_id: a.client_id, email: remote ? '' : a.email, name: remote ? '' : a.name,
    signedIn: !!a.access_token, planEnabled: a.scopes?.includes('chatgpt.tokens.use.direct') || false }));
  function providersView() {
    return { providers: providerConfig().map(p => ({ id: p.id, label: p.id === 'claude' ? 'Claude' : 'ChatGPT', enabled: !!p.enabled,
      model: p.id === 'claude' ? p.model : '', models: p.id === 'claude' ? CLAUDE_MODELS : [], ready: providerReady(p),
      ...(p.id === 'claude' && p.apiKey && { keyHint: `••••${p.apiKey.slice(-4)}`, keyAddedAt: p.keyAddedAt || null }),
      ...(p.id === 'chatgpt' && { accounts: accountsView(false), activeId: store.data.activeId, shared: chatgptShared }) })) };
  }
  // 依序列出這次可用的服務；ChatGPT 模型不可用或模型清單取得失敗（可換服務的錯誤）就略過。
  async function providerChain(model, req) {
    const config = providerConfig().filter(p => p.enabled);
    const list = []; let skipped = null;
    for (const p of config.filter(p => providerReady(p, req))) {
      if (p.id === 'claude') {
        list.push({ id: 'claude', model: p.model, label: CLAUDE_MODELS.find(m => m.slug === p.model).display_name, call: claudeInfer(anthropicFactory(p.apiKey), p.model) });
        continue;
      }
      const account = active(); let found;
      try { found = (await models(account)).find(m => m.slug === model); }
      catch (error) { if (!fallbackWorthy(error)) throw error; skipped = error; continue; }
      if (found) list.push({ id: 'chatgpt', model, label: found.display_name || model, call: async ({ schema, ...body }, signal) => {
        // schema（只有辨識與估算傳入）對應 Responses API 的 strict JSON Schema。
        const text = schema && { format: { type: 'json_schema', name: schema.name, strict: true, schema: schema.schema } };
        const response = await api(account, '/responses', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          signal, body: JSON.stringify({ ...body, ...(text && { text }), model, store: false, stream: true }) });
        return collectResponse(response.body);
      } });
    }
    return { list, skipped, primary: config[0]?.id };
  }
  function saveTokens(account, tokens) {
    if (typeof tokens.access_token !== 'string' || !Number.isFinite(tokens.expires_in) || tokens.expires_in <= 0)
      throw new Error('OpenAI 回傳的憑證資料不完整，請重新登入。');
    Object.assign(account, { access_token: tokens.access_token,
      refresh_token: tokens.refresh_token || account.refresh_token,
      id_token: tokens.id_token || account.id_token,
      scopes: typeof tokens.scope === 'string' ? tokens.scope.split(/\s+/) : account.scopes || [],
      expiresAt: Date.now() + tokens.expires_in * 1000 });
    store.save();
  }
  async function ensureToken(account) {
    if (account.expiresAt > Date.now() + 30000) return account.access_token;
    if (!account.refresh_token) throw Object.assign(new Error('登入已過期，請重新授權。'), { status: 401 });
    // Step 2：同一帳號只執行一次 refresh，避免旋轉憑證互相覆寫。
    if (!refreshing.has(account.client_id)) {
      refreshing.set(account.client_id, (async () => {
        try { saveTokens(account, await oauth.refresh(account)); }
        catch (error) {
          if (error.code === 'invalid_grant') {
            delete account.access_token; delete account.refresh_token; delete account.id_token;
            store.save();
          }
          throw error;
        }
      })().finally(() => refreshing.delete(account.client_id)));
    }
    await refreshing.get(account.client_id);
    return account.access_token;
  }
  async function api(account, suffix, options = {}) {
    const token = await ensureToken(account);
    if (!account.scopes?.includes('chatgpt.tokens.use.direct')) throw Object.assign(new Error('ChatGPT plan 授權已失效，請重新授權。'), { status: 403 });
    const response = await fetcher(`${RESOURCE}${suffix}`, { ...options,
      headers: { ...options.headers, Authorization: `Bearer ${token}` } });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      const code = body.error?.code || 'request_failed';
      throw Object.assign(new Error(`OpenAI 要求失敗（HTTP ${response.status} / ${code}）。${response.status === 401 ? '請重新授權。' : '請查看帳號用量或重試。'}`), { status: response.status });
    }
    return response;
  }
  async function models(account) {
    if (catalog?.id === account.client_id && catalog.until > Date.now()) return catalog.models;
    const result = await (await api(account, '/models', { signal: AbortSignal.timeout(30000) })).json();
    if (!Array.isArray(result.models)) throw new Error('模型清單格式不符官方 OAuth 規格。');
    // Sol 排第一，前端以清單第一個當預設模型。
    const list = result.models.filter(m => m.visibility === 'list' && allowedModel(m.slug)).map(m => ({ slug: m.slug, display_name: m.display_name }))
      .sort((a, b) => /-sol$/i.test(b.slug) - /-sol$/i.test(a.slug));
    catalog = { id: account.client_id, until: Date.now() + 60000, models: list };
    return list;
  }
  // 管理員檢視：只在電腦本機（127.0.0.1）開放，唯讀；Tailscale 遠端連線（包含擁有者自己的手機）一律拒絕。
  if (listJournals) {
    const admin = (req, res, next) => req.remote ? res.status(403).json({ error: '管理員檢視只能在電腦上使用。' }) : next();
    const find = id => listJournals().find(j => j.id === id);
    app.get('/api/admin/journals', admin, (req, res) => res.json({ journals: listJournals().map(j => ({ id: j.id, login: j.login, owner: j.owner, ...j.journal.stats() })) }));
    app.get('/api/admin/journals/:id', admin, (req, res) => {
      const j = find(req.params.id);
      if (!j) return res.status(404).json({ error: '找不到這本日誌。' });
      res.json({ id: j.id, login: j.login, owner: j.owner, stats: j.journal.stats(), meals: j.journal.recentMeals(Number(req.query.limit) || 100), foods: j.journal.foods() });
    });
    app.get('/api/admin/journals/:id/meals/:meal', admin, (req, res) => {
      const meal = find(req.params.id)?.journal.meal(req.params.meal);
      res.status(meal ? 200 : 404).json(meal || { error: '找不到餐點。' });
    });
  }
  app.get('/api/status', (req, res) => res.json({ csrf: req.localSession.csrf, remote: req.remote, user: req.user || '', admin: !req.remote && !!listJournals,
    providersReady: providersReady(req), ...(!providersReady(req) && { providersError: providersError(req) }),
    // 遠端不回傳 client ID：只給使用中的帳號（以 'active' 代稱）；ChatGPT 不開放給朋友時不給帳號。
    ...(req.remote ? { activeId: 'active', accounts: chatgptFor(req) ? accountsView(true).filter(a => a.client_id === store.data.activeId).map(a => ({ ...a, client_id: 'active' })) : [] }
      : { activeId: store.data.activeId, accounts: accountsView(false) }) }));
  app.post('/auth/chatgpt', async (req, res) => {
    if (running.size) return res.status(409).json({ error: '請先停止正在產生的回覆。' });
    for (const [key, tx] of pending) if (tx.expiresAt < Date.now()) pending.delete(key);
    const account = req.body.client_id ? store.data.accounts.find(a => a.client_id === req.body.client_id) : null;
    if (req.body.client_id && !account) throw new Error('找不到已保存的帳號。');
    const transaction = createTransaction(account?.client_id, req.localSession.id, `${origin}/auth/callback`);
    transaction.epoch = authEpoch;
    pending.set(transaction.state, transaction);
    res.redirect(303, await oauth.authorization(transaction, store.data.hostId, account));
  });
  app.get('/auth/callback', async (req, res) => {
    try {
      const state = req.query.state;
      const tx = typeof state === 'string' ? pending.get(state) : null;
      // 拒絕錯誤瀏覽器 cookie；不消耗其他瀏覽器的正常交易。
      if (!tx || tx.sessionId !== req.localSession?.id) throw new Error('登入狀態不符，請從首頁重新登入。');
      pending.delete(state);
      if (tx.expiresAt < Date.now()) throw new Error('登入逾時，請重新登入。');
      if (req.query.error) throw new Error('登入或授權已取消，請重試。');
      const clientId = req.query.client_id || tx.clientId;
      if (typeof clientId !== 'string' || !clientId || clientId === 'dynamic_agent_client' ||
        (tx.clientId && tx.clientId !== clientId)) throw new Error('OpenAI 未回傳相符的 client ID。');
      if (typeof req.query.code !== 'string') throw new Error('缺少登入授權碼。');
      const tokens = await oauth.exchange(req.query.code, clientId, tx);
      const identity = await oauth.verify(tokens.id_token, clientId, tx.nonce);
      if (tx.epoch !== authEpoch) throw new Error('此登入已取消，請重新登入。');
      const existing = store.data.accounts.find(a => a.client_id === clientId);
      if (existing && existing.subject !== identity.sub) throw new Error('登入身分與保存的帳號不符。');
      if (tx.clientId && !existing) throw new Error('找不到原始帳號註冊。');
      const account = existing || { client_id: clientId, subject: identity.sub };
      account.email = identity.email || ''; account.name = identity.name || '';
      // 先驗證完整 token，再將帳號設為使用中。
      if (!tokens.access_token || !tokens.expires_in || typeof tokens.scope !== 'string') throw new Error('授權資料不完整。');
      if (!existing) store.data.accounts.push(account);
      saveTokens(account, tokens);
      store.data.activeId = clientId; store.save(); catalog = null;
      res.redirect(303, '/?login=success');
    } catch (error) {
      // 不把 code、token 或上游原始回應放入網址或畫面。
      const message = error.message.startsWith('OpenAI') || error.message.match(/[\u4e00-\u9fff]/) ? error.message : '登入驗證失敗，請重新登入。';
      res.redirect(303, `/?login_error=${encodeURIComponent(message)}`);
    }
  });
  app.post('/api/account', (req, res) => {
    if (running.size) return res.status(409).json({ error: '請先停止正在產生的回覆。' });
    const account = store.data.accounts.find(a => a.client_id === req.body.client_id);
    if (!account?.access_token) return res.status(401).json({ error: '請先重新授權這個帳號。' });
    store.data.activeId = account.client_id; store.save(); catalog = null;
    res.json({ ok: true });
  });
  app.post('/api/logout', async (req, res) => {
    authEpoch++;
    for (const controller of running) controller.abort();
    pending.clear();
    const account = active();
    if (!account) return res.json({ ok: true });
    await refreshing.get(account.client_id)?.catch(() => {});
    let revoked = false;
    for (let attempt = 0; attempt < 2 && !revoked; attempt++) {
      if (attempt) await new Promise(resolve => setTimeout(resolve, 500));
      revoked = await oauth.revoke(account).catch(() => false);
    }
    delete account.access_token; delete account.refresh_token; delete account.id_token;
    store.save(); catalog = null;
    res.json({ ok: true, warning: revoked ? null : '已在本機登出，但未確認遠端撤銷；可至 ChatGPT 設定中中斷此 App 的連線。' });
  });
  app.get('/api/models', async (req, res) => res.json({ models: chatgptFor(req) ? await models(signedIn()) : [] }));
  app.get('/api/providers', (req, res) => res.json(providersView()));
  app.post('/api/providers', async (req, res) => {
    const { providers, claudeApiKey } = req.body;
    const ids = Array.isArray(providers) ? providers.map(p => p?.id) : [];
    let current = providerConfig();
    if (!ids.length || new Set(ids).size !== ids.length || ids.some(id => !current.some(p => p.id === id)) ||
      providers.some(p => typeof p.enabled !== 'boolean' || (p.id === 'claude' && p.model !== undefined && !CLAUDE_MODELS.some(m => m.slug === p.model))))
      return res.status(400).json({ error: 'AI 服務設定不正確。' });
    if (claudeApiKey !== undefined && (typeof claudeApiKey !== 'string' || claudeApiKey.length > 300 || !/^[!-~]*$/.test(claudeApiKey.trim())))
      return res.status(400).json({ error: 'Claude API key 格式不正確。' });
    // 新金鑰先用免費的 Token Counting API 以所選模型驗證，失敗就不保存；空字串直接刪除金鑰。
    const newKey = claudeApiKey?.trim();
    if (newKey) {
      try { await validateClaudeKey(anthropicFactory, newKey, providers.find(p => p.id === 'claude')?.model || current.find(p => p.id === 'claude').model); }
      catch (error) { return res.status(400).json({ error: error.message }); }
      current = providerConfig();
    }
    // 未列出的服務保留原設定並排在最後。
    store.data.providers = [...providers.map(p => p.id), ...current.map(p => p.id).filter(id => !ids.includes(id))].map(id => {
      const old = current.find(p => p.id === id); const next = providers.find(p => p.id === id) || old;
      if (id !== 'claude') return { id, enabled: next.enabled };
      const key = claudeApiKey === undefined ? { apiKey: old.apiKey, keyAddedAt: old.keyAddedAt }
        : newKey ? { apiKey: newKey, keyAddedAt: new Date().toISOString() } : { apiKey: '' };
      return { id, enabled: next.enabled, model: next.model || old.model, ...key };
    });
    store.save();
    res.json(providersView());
  });
  if (journal) attachFoodRoutes(app, { journal, requireProvider, providerChain, running, friendsCache });
  // Vite 或靜態畫面會在 server.js 接上，因此回傳獨立的錯誤 middleware。
  const errors = (error, req, res, next) => {
    if (res.headersSent) return next(error);
    const safe = /[\u4e00-\u9fff]/.test(error.message) ? error.message : '連線失敗，請檢查網路後重試。';
    res.status(error.status || 500).json({ error: safe });
  };
  return { app, errors, pending };
}
