# 0007 辨識與估算用 JSON Schema 結構化輸出，搜尋步驟維持自由文字 JSON

- 狀態：已採用

## 背景

作此決策，是因為有人指出改用結構化輸出會讓搜尋引用消失，使 [0002](0002-citation-verification.md) 的引用核對失效：Claude 官方文件寫明結構化輸出與 Citations 不相容，社群也回報 OpenAI 在結構化輸出下 `url_citation` 會變空。因此先實測，再決定哪些步驟可以改用。

原本每一步 AI 呼叫都在提示詞中寫明「只回傳 JSON」與欄位格式，再由程式解析與驗證：

- `server/food-analysis.js` 的 `parseJSON()` 去掉 Markdown 程式碼框後解析，失敗就回報「模型未回傳完整的食物資料」。
- `analyzeMeal()` 檢查名稱與克數，`server/journal.js` 的 `validateFood()`／`validateItems()` 檢查每 100g 熱量 0～1000、克數 0～5000。

供應商提供的 JSON Schema 結構化輸出（Claude 的 `output_config.format`、OpenAI Responses API 的 `text.format`）可保證回傳符合 schema，減少解析失敗。問題是：哪些步驟能改用它，而不破壞 [0002](0002-citation-verification.md) 的引用核對？

## 實測

| 組合 | 結果 |
| --- | --- |
| Claude Haiku 5.5，`output_config.format` json_schema，**不帶工具** | 回傳合法 JSON，符合 schema。 |
| Claude Haiku 5.5，**帶 `web_search` 工具** ＋ json_schema | HTTP 200、JSON 合法，`sourceUrl` 也出現在 `web_search_tool_result` 的網址中；但最終文字**沒有任何 `web_search_result_location` 引用**。 |
| ChatGPT（OpenAI Responses API `text.format` json_schema strict），辨識與估算 | 實際執行成功：一餐 5 個品項的辨識與 4 次估算皆由 ChatGPT 完成（`servedBy.provider` 為 `chatgpt`），未改由備援服務處理。 |

第二項的後果：搜尋步驟若用 schema，`server/claude.js` 的 `claudeInfer()` 收集不到引用，0002 的核對會把**每一筆網路結果都降級為「LLM 估算」**。

## 考慮過的選項

**A. 所有步驟都改用結構化輸出**
- 優點：格式保證，程式端可少處理解析失敗。
- 缺點：搜尋步驟失去引用，網路來源全數降級，違反準確優先。

**B. 只在不搜尋的步驟使用（辨識、LLM 估算）（採用）**
- 優點：這兩步本來就不需要引用，可得到格式保證；搜尋步驟保有引用。
- 缺點：兩家供應商各有一套參數對應；strict schema 要求所有欄位必填，估算那次的相近候選比對說明要改成「填欄位」的寫法。

**C. 全部維持自由文字 JSON＋解析＋程式驗證**
- 優點：兩家供應商走同一套程式。
- 缺點：辨識與估算得不到格式保證。

## 決定

採用 B：

- 辨識（`analyzeMeal()`）與 LLM 估算（`lookupItem()` 的估算呼叫）傳入 JSON Schema。
- 搜尋步驟（帶 `web_search`）維持自由文字 JSON 指示，文字不變，**必須保留引用**。
- `parseJSON()` 保留作安全網：拒絕或 `max_tokens` 仍可能讓輸出不完整。
- JSON Schema 不支援數值範圍與陣列長度，所以程式端驗證全部保留：最多 15 項（提示詞也保留「最多 15 項」）、克數 0～5000 g、每 100g 熱量 0～1000、包裝標示熱量 0～1000。

## 做法

- `infer(body)` 可多帶 `schema: { name, schema }`，送出前從 body 移除：
  - ChatGPT（`server/app.js`）：對應成 `text: { format: { type: 'json_schema', name, strict: true, schema } }`。
  - Claude（`server/claude.js`）：對應成 `output_config: { effort, format: { type: 'json_schema', schema } }`，與既有的 effort 合併。
- Schema 定義在 `server/food-analysis.js` 的 `RECOGNITION_SCHEMA`、`ESTIMATE_SCHEMA`：每層 object 都 `additionalProperties: false`、所有欄位列入 `required`，可空欄位用 `anyOf` 加 `null`。
- 辨識提示詞：`labelKcalPer100g` 改為每項必填，看不到清楚的營養標示時填 null。
- 估算提示詞：附相近候選時改為「若相同，sameAs 填該項 id，其餘欄位填 null 或空字串」；沒附候選時要求 sameAs 填 null。`sameAs()` 判斷不變。
- 測試（`tests/claude.test.js`、`tests/app.test.js`，皆用 mock）：兩條路徑只有辨識與估算帶 schema、搜尋不帶；schema 符合 strict 規則。

## 取捨

- 估算那次在模型判斷「同一種」時也要回傳完整欄位（多幾個 null），換來格式保證。
- 搜尋步驟仍可能偶爾回傳不完整 JSON，使用者需重試；換來的是網路來源仍可核對。

## 注意

- 若日後 OpenAI 端點不再接受 `text.format` 而回 HTTP 400，`fallbackWorthy()` 會把 400 視為可換服務，請求會**無聲改由 Claude 處理**；檢查方式是看結果的 `servedBy.provider` 或每項備註的服務標註。

## 何時重新評估

- 供應商在 schema 輸出時也一併回傳引用（例如 Claude 帶 `web_search` 工具時仍有 `web_search_result_location`）→ 可考慮搜尋步驟也改用。
- ChatGPT 開始拒絕 `text.format` → 該路徑改回不帶 schema。
