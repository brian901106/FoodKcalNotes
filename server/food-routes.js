import { analyzeMeal, lookupItem } from './food-analysis.js';
import { validPhoto, validDate } from './journal.js';

// 單次模型呼叫逾時（預設 150 秒）就重試一次；再逾時丟出 error.timeout。其他錯誤（額度、授權）不重試。
export async function retryOnTimeout(call, signal, ms = 150000) {
  for (let attempt = 0; ; attempt++) {
    const timeout = AbortSignal.timeout(ms);
    try { return await call(AbortSignal.any([signal, timeout])); } catch (error) {
      if (!timeout.aborted || signal.aborted) throw error;
      if (attempt) throw Object.assign(new Error('timeout'), { timeout: true });
    }
  }
}

// 可換下一個 AI 服務的錯誤：要求不被該服務接受（400，各服務規則不同）、授權/憑證、額度與限流、伺服器錯誤、逾時（已重試）、網路。
// 回傳內容的 JSON 格式錯誤、Claude 拒絕、中止不換。
export function fallbackWorthy(error) {
  if (error?.name === 'AbortError' || error?.name === 'APIUserAbortError') return false;
  if (error?.timeout || error?.network || error instanceof TypeError) return true;
  if (typeof error?.status === 'number') return [400, 401, 403, 429].includes(error.status) || error.status >= 500;
  return /usage_limit|usage_unavailable|rate_limit|insufficient|quota|overloaded|server_error|invalid_request|分析連線中斷/i.test(error?.message || '');
}

export function attachFoodRoutes(app, { requireProvider, providerChain, running, friendsCache = false }) {
  // FRIENDS_CACHE 未開啟時，朋友存的餐點不寫入共用食物庫（不新增食物、不加別名），避免用自填熱量污染共用庫。
  const shareFoods = req => friendsCache || !req.friend;
  // 分析與 AI 估算共用：依服務順序建立可停止的 infer（每次呼叫各自逾時重試，失敗才換下一個服務）；沒有服務能用時回傳 null。
  // model 只給 ChatGPT 使用；res 省略時（背景分析）不隨連線中斷而停止。
  async function inference(req, model, res) {
    const { list, skipped, primary } = await providerChain(model, req);
    if (!list.length) { if (skipped) throw skipped; return null; }
    const controller = new AbortController(); running.add(controller);
    res?.on('close', () => controller.abort());
    let served = null; // 有任何一次由備援服務處理就記備援服務
    const infer = async body => {
      let last = null;
      for (const p of list) {
        try {
          const result = await retryOnTimeout(signal => p.call(body, signal), controller.signal);
          if (!served || served.id === primary) served = p;
          return result;
        } catch (error) {
          if (controller.signal.aborted || !fallbackWorthy(error)) throw error;
          last = error;
        }
      }
      throw last;
    };
    const servedBy = () => served && { provider: served.id, model: served.model };
    // 在每項備註加註實際處理的服務與模型（主要或備援；備註最多 1000 字）；已有舊標註（例如來自食物庫）先移除再加。
    const tag = items => {
      if (!served) return items;
      const note = `（由 ${served.label} 處理）`;
      return items.map(i => ({ ...i, notes: `${(i.notes || '').replace(/（由 [^（）]* 處理）$/, '').slice(0, 1000 - note.length)}${note}` }));
    };
    return { infer, servedBy, tag, signal: controller.signal, abort: () => controller.abort(), done: () => running.delete(controller) };
  }
  app.get('/api/journal', (req, res) => res.json({ meals: req.journal.meals(req.query.day), week: req.journal.week(req.query.day), settings: req.journal.preferences(), since: req.journal.stats().firstDay,
    streak: req.journal.streak(validDate(req.query.today) ? req.query.today : new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10)) }));
  app.get('/api/meals/:id', (req, res) => { const meal = req.journal.meal(req.params.id); res.status(meal ? 200 : 404).json(meal || { error: '找不到餐點。' }); });
  app.post('/api/meals', (req, res) => res.json(req.journal.saveMeal(req.body, { shareFoods: shareFoods(req) })));
  app.delete('/api/meals/:id', (req, res) => { req.journal.deleteMeal(req.params.id); res.json({ ok: true }); });
  app.post('/api/settings', (req, res) => res.json(req.journal.updatePreferences(req.body)));
  app.get('/api/foods', (req, res) => res.json({ foods: req.journal.foods(typeof req.query.q === 'string' ? req.query.q : '') }));
  app.get('/api/export', (req, res) => { res.setHeader('Content-Disposition', 'attachment; filename="meal-journal-backup.json"'); res.json(req.journal.exportData()); });
  // 背景工作：立即回傳工作 id，關掉 app 也繼續跑；進度與結果存在日誌的 jobs 表。work 回傳要寫入的結果（result、mealId）。
  const controllers = new Map();
  function runJob(journal, id, run, work) {
    controllers.set(id, run);
    work()
      .then(done => journal.updateJob(id, { status: 'done', ...done }),
        error => journal.updateJob(id, { status: 'error', result: error.result, error: error.timeout ? '分析逾時，請重試。' : run.signal.aborted ? '分析已停止。'
          : /[一-鿿]/.test(error.message) ? error.message : '連線失敗，請檢查網路後重試。' }))
      .catch(() => {}) // 日誌已關閉（例如伺服器結束）時忽略。
      .finally(() => { controllers.delete(id); run.done(); });
  }
  // 背景分析：成功即自動存成餐點。
  app.post('/api/analyze', async (req, res) => {
    requireProvider(req); const journal = req.journal;
    const { text = '', photo = '', model, fallback = journal.preferences().fallback } = req.body;
    if (typeof text !== 'string' || text.length > 4000 || (!text.trim() && !photo)) return res.status(400).json({ error: '請選一張照片或描述餐點。' });
    validPhoto(photo);
    if (!['web', 'llm'].includes(fallback)) return res.status(400).json({ error: '缺資料處理方式不正確。' });
    const run = await inference(req, model);
    if (!run) return res.status(400).json({ error: '請先在設定中選擇可用模型。' });
    const id = journal.createJob({ text, photo }); const steps = [];
    const emit = ({ label, message }) => { steps.push({ label, message }); journal.updateJob(id, { steps }); };
    runJob(journal, id, run, async () => {
      const analyzed = await analyzeMeal({ text, photo, fallback, at: new Date(journal.getJob(id)?.createdAt ?? Date.now()), journal, infer: run.infer, emit, signal: run.signal });
      const result = { ...analyzed, items: run.tag(analyzed.items), servedBy: run.servedBy() };
      // 自動存成餐點（時間用工作建立時的本機時間），使用者之後再改；未經確認的 AI 估算不寫入共用食物庫。
      const job = journal.getJob(id); if (!job) return {}; // 工作已刪除：不存餐點
      const at = new Date(job.createdAt); const pad = n => String(n).padStart(2, '0');
      try {
        const meal = journal.saveMeal({ name: result.name, items: result.items.map(i => i.source === 'llm' ? { ...i, cache: false } : i), photo,
          day: `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`, time: `${pad(at.getHours())}:${pad(at.getMinutes())}` }, { shareFoods: shareFoods(req) });
        return { result, mealId: meal.id };
      } catch (error) { throw Object.assign(error, { result }); }
    });
    res.json({ id });
  });
  // 已存餐點的單項「重新查詢」：只用新名稱查這一項的熱量，不拆項、不改份量；完成後直接改寫該餐點。
  const RELOOKUP_FIELDS = ['name', 'kcalPer100g', 'source', 'sourceUrl', 'sourceTitle', 'notes', 'matched', 'foodId', 'recognizedName', 'similar', 'aliases', 'confidence'];
  app.post('/api/jobs/relookup', async (req, res) => {
    requireProvider(req); const journal = req.journal;
    const { mealId, itemId, name, model, fallback = journal.preferences().fallback } = req.body;
    if (typeof name !== 'string' || !name.trim() || name.length > 100) return res.status(400).json({ error: '請先填寫食物名稱。' });
    if (!['web', 'llm'].includes(fallback)) return res.status(400).json({ error: '缺資料處理方式不正確。' });
    const old = typeof mealId === 'string' && journal.meal(mealId)?.items.find(i => i.id === itemId);
    if (!old) return res.status(404).json({ error: '找不到餐點或品項。' });
    const run = await inference(req, model);
    if (!run) return res.status(400).json({ error: '請先在設定中選擇可用模型。' });
    const id = journal.createJob({ text: name.trim(), kind: 'relookup', mealId });
    runJob(journal, id, run, async () => {
      const warnings = [];
      const [result] = run.tag([await lookupItem({ item: { id: itemId, name: name.trim(), aliases: [], grams: old.grams, confidence: 'high', portionNote: '', portionBasis: 'reference' },
        fallback, journal, infer: run.infer, emit() {}, signal: run.signal, warnings })]);
      // 查詢期間餐點可能被編輯過：以最新內容為準，只取代這一項。
      const meal = journal.meal(mealId); const current = meal?.items.find(i => i.id === itemId);
      if (!current) throw new Error('品項已被刪除。');
      const item = { ...current, ...Object.fromEntries(RELOOKUP_FIELDS.filter(k => k in result).map(k => [k, result[k]])),
        id: current.id, grams: current.grams, portionNote: current.portionNote, cache: result.source === 'llm' ? false : result.cache };
      journal.saveMeal({ ...meal, items: meal.items.map(i => i.id === itemId ? item : i) }, { shareFoods: shareFoods(req) });
      return { result: { item, warnings, servedBy: run.servedBy() }, mealId };
    });
    res.json({ id });
  });
  app.get('/api/jobs', (req, res) => res.json({ jobs: req.journal.listJobs() }));
  app.get('/api/jobs/:id', (req, res) => { const job = req.journal.getJob(req.params.id); res.status(job ? 200 : 404).json(job || { error: '找不到分析工作。' }); });
  app.delete('/api/jobs/:id', (req, res) => {
    if (!req.journal.deleteJob(req.params.id)) return res.status(404).json({ error: '找不到分析工作。' });
    controllers.get(req.params.id)?.abort(); res.json({ ok: true });
  });
  // 結果頁單項「AI 估算」：把名稱當成首頁文字描述跑完整分析，拆成多項並估份量，回傳取代原項目。
  app.post('/api/estimate', async (req, res) => {
    requireProvider(req);
    const { name, model, fallback = req.journal.preferences().fallback } = req.body;
    if (typeof name !== 'string' || !name.trim() || name.length > 4000) return res.status(400).json({ error: '請先填寫食物名稱。' });
    if (!['web', 'llm'].includes(fallback)) return res.status(400).json({ error: '缺資料處理方式不正確。' });
    const run = await inference(req, model, res);
    if (!run) return res.status(400).json({ error: '請先在設定中選擇可用模型。' });
    try {
      const { items, warnings } = await analyzeMeal({ text: name, photo: '', fallback, journal: req.journal, infer: run.infer, emit() {}, signal: run.signal });
      res.json({ items: run.tag(items), warnings, servedBy: run.servedBy() });
    } catch (error) {
      if (error.timeout) error = new Error('估算逾時，請重試或手動填寫。');
      throw error;
    } finally { run.done(); }
  });
}
