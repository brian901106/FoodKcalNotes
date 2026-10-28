# 設計決策紀錄（ADR）

架構決策紀錄（Architecture Decision Record，ADR）記下一個重要設計決定的背景、考慮過的選項、最後的選擇與代價，讓之後的人知道「為什麼這樣做」，以及什麼情況下該重新檢討。

## 實作前決策

| 編號 | 標題 | 狀態 |
| --- | --- | --- |
| [0001](0001-kcal-computed-by-program.md) | 熱量不讓 AI 給，由程式計算 | 已採用 |
| [0002](0002-citation-verification.md) | 出處網址驗證，防止編造引用 | 已採用 |
| [0003](0003-exclusive-words.md) | 互斥詞硬規則 | 已採用 |
| [0004](0004-food-library-caching.md) | 快取策略：什麼可以存進本機食物庫 | 已採用 |
| [0005](0005-tiered-ai-calls.md) | 省 token 的分層呼叫設計 | 已採用 |
| [0006](0006-no-rag-or-llm-wiki.md) | 不採用 RAG／LLM wiki | 已決定：不採用 |

## 實作後細化決策

| 編號 | 標題 | 狀態 |
| --- | --- | --- |
| [0007](0007-structured-output-search-step.md) | 辨識與估算用 JSON Schema 結構化輸出，搜尋步驟維持自由文字 JSON | 已採用 |

所有決定都依同一個判斷原則：**準確優先，其次省 token；兩者衝突時，選準確。**
