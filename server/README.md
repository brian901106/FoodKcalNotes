**English** below · [繁體中文](#繁體中文)

# Server flags: other Tailscale identities

The server identifies each remote request by the `Tailscale-User-Login` header that Tailscale serve adds.

- **Your own devices** (any request whose login equals `OWNER_LOGIN`) and the computer itself share the main journal. **No flag is needed for this.**
- **Any other login** gets its own separate journal file (`friends/meals-<hash>.sqlite`). Meals, settings and plans are kept apart; the food library is the owner's.

This exists so that a **single user** can record from several devices and test, for example with a second Tailscale test account, that journals and the food library do not get mixed up. It is **not** a feature for sharing the app with other people.

| Variable | Default | Effect |
|---|---|---|
| `CHATGPT_SHARED` | off | When `1`, requests from other logins may use the ChatGPT sign-in. When off, the ChatGPT provider is skipped for them and only API-key providers (e.g. Claude) are used. |
| `FRIENDS_CACHE` | off | When `1`, meals saved by other logins may add foods and aliases to the food library. When off, they never write to it. |

**ChatGPT policy.** OpenAI's terms do not allow sharing a ChatGPT account or its usage with other people. The "Sign in with ChatGPT" login is only for your own account, used by you. Leave `CHATGPT_SHARED` off unless every login it applies to is you, for example your own test account. Turning it on for other people is against OpenAI's terms and at your own risk.

The read-only admin view that lists every journal is available only on the computer itself (`127.0.0.1`), never remotely.

Code: `server/server.js` (reads the flags), `server/app.js` (owner check, ChatGPT availability), `server/food-routes.js` and `server/journal.js` (food-library writes).

---

## 繁體中文

# 伺服器旗標：其他 Tailscale 身分

伺服器依 Tailscale serve 附上的 `Tailscale-User-Login` 標頭，辨識每個遠端請求是誰。

- **你自己的裝置**（登入帳號等於 `OWNER_LOGIN` 的請求）和電腦本機共用主日誌，**不需要任何旗標**。
- **其他登入身分**會各自有一本獨立的日誌檔（`friends/meals-<hash>.sqlite`）。餐點、設定、計劃彼此分開；食物庫用的是擁有者那一份。

這個機制是為了讓**同一位使用者**能從多台裝置記錄，並實際測試資料不會混在一起，例如用第二個 Tailscale 測試帳號確認日誌和食物庫是分開的。它**不是**用來把 App 分享給其他人的功能。

| 變數 | 預設 | 作用 |
|---|---|---|
| `CHATGPT_SHARED` | 關閉 | 設為 `1` 時，其他登入身分的請求也能使用 ChatGPT 登入。關閉時，對它們會略過 ChatGPT，只使用 Claude 這類 API key 服務。 |
| `FRIENDS_CACHE` | 關閉 | 設為 `1` 時，其他登入身分存的餐點可以新增食物和同義名到食物庫。關閉時完全不寫入。 |

**ChatGPT 政策。** 依 OpenAI 使用條款，ChatGPT 帳號和額度不可分享給其他人。「Sign in with ChatGPT」登入只供你本人使用自己的帳號。除非這個旗標涵蓋的每個登入身分都是你自己（例如你的測試帳號），否則請保持 `CHATGPT_SHARED` 關閉。為其他人開啟違反 OpenAI 條款，風險自負。

列出所有日誌的唯讀管理員檢視，只能在電腦本機（`127.0.0.1`）開啟，遠端一律無法使用。

程式位置：`server/server.js`（讀取旗標）、`server/app.js`（擁有者判斷、ChatGPT 是否可用）、`server/food-routes.js` 與 `server/journal.js`（食物庫寫入）。
