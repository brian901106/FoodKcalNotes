**English** | [繁體中文](README.md)

# 飲食日誌 · FoodKcalNotes

A meal and calorie journal that runs on your own computer (PWA; Express + `node:sqlite` + React/Vite), designed around common Taiwanese foods and portion sizes. Snap a photo or type a description on your phone; AI identifies the foods and portions, calories come first from your local food library and verifiable sources, and the final numbers are computed by code. The guiding principle is **accuracy first, fewer model calls second**.

The app's interface is in Traditional Chinese (Taiwan) and it is tuned for Taiwanese foods.

For architecture details (system, recognition pipeline, database), see [`docs/architecture.html`](docs/architecture.html).

> **License:** This project is open source under the [MIT License](LICENSE). You are free to use, modify, and redistribute it, including for commercial purposes. **If you create derivative works or redistribute it, please keep the original copyright notice and the full MIT license text.** Nutrition data in `data/` is licensed by its respective sources; please credit them as described in [`data/ATTRIBUTION.md`](data/ATTRIBUTION.md).

## Highlights

<p align="center"><img src="docs/img/highlights.svg" alt="Highlights overview" width="100%"></p>

- **Gets more accurate and cheaper the more you use it**: Web lookups and package nutrition labels are saved to your local food library automatically when you save a meal (existing entries with the same name are never overwritten; items whose name or calories you edited are not saved). The next time you log the same food it hits the library directly with no model call. When the AI judges two names to be the same food, it automatically learns the new name; you can also teach it with 「其實是同一種」("It's actually the same thing").
- **The framework is free and open source; just bring your own AI**: The app is free and MIT-licensed. Sign in with your own ChatGPT account via OAuth (no OpenAI API key needed), or enter your own Claude API key. Both can be configured at once and are used in order with automatic fallback. AI usage counts against your own plan or account.
- **Streaks and weight-loss goals**<br>`TDEE = (10 × 體重kg + 6.25 × 身高cm − 5 × 年齡 + 5〔男〕／−161〔女〕) × 活動係數`<br>(weight kg, height cm, age, +5 male / −161 female, activity factor.) Set a daily calorie target and a weight-loss plan (weekly loss and estimated goal date based on the Mifflin-St Jeor equation). Counting back from today, each day that has entries and stays within the target extends your streak, shown with a flame icon on the home screen.
- **Portion estimates with a basis**: Weight is estimated from the proportions of common objects in the photo (chopsticks, rice bowls, phones), and your fist size is derived from your height, so text like 「飯一拳頭」("a fist of rice") can be converted too.
- **Package labels are more accurate**: When a nutrition label in the photo is clearly legible, values are converted straight from the label with no extra lookup.
- **Close the app right after the photo**: Analysis runs in the background and is saved as a meal automatically when done; you can edit it later. After renaming an item, 「以新名稱重新查詢」("Look up again with new name") re-queries just that item.
- **Tells pan-fried from deep-fried**: The prompt explicitly asks the model to name the visible cooking method and amount of oil (pan-fried chicken leg, fried chicken cutlet, glossy stir-fried greens, blanched, thickened sauce), and lookups must match the cooking state. Code additionally blocks mutually exclusive terms such as fried ≠ steamed, raw ≠ cooked, and unsweetened ≠ sweetened, so tea eggs, braised eggs, and boiled eggs are never mixed up. The exclusive-term list is `EXCLUSIVE` in `server/journal.js`; edit it as needed.
- **Built-in Taiwanese data**: Ships with 137 entries from the TFDA (Taiwan Food and Drug Administration) food nutrient database and 22 from the HPA (Health Promotion Administration) 「熱量知多少」 calorie guide, so breakfast and street foods like egg crepes (蛋餅), xiaolongbao (小籠包), and oyster omelets (蚵仔煎) work out of the box. You can also import your own data with `npm run import-foods` (same format as data/*.json). Built-in data lives in `data/*.json`.
- **Every item is traceable to a source**: Each item is labeled with its source (nutrition label / local food library / web data / LLM estimate). Web data comes with citations you can click to verify, and a citation only counts if its URL actually appears in the search results.

## Design rationale (research)

- **Portion size is the biggest source of error, so grams can be corrected anytime and code recomputes calories instantly**: Studies show that, given the correct weight of each ingredient, a multimodal LLM's calorie error dropped from about 51% to as low as 29% ([Bhatambarekar, Virginia Tech master's thesis, 2025](https://vtechworks.lib.vt.edu/items/b67c2a61-f283-41ba-9602-9798306b9529)); ChatGPT-5's calorie MAPE was 30.5% from the photo alone and 13.9% with detailed ingredient information ([Nutrients, 2025](https://pmc.ncbi.nlm.nih.gov/articles/PMC12655113/)). In this app the grams are still estimated by the AI, but kcal per 100 g comes from verifiable data, so correcting the grams recomputes calories immediately without calling the AI again.
- **Meal time is added to the prompt**: Adding contextual information such as time and location to the prompt reduced mean portion error by about 53 g across models ([arXiv:2507.07048, 2025](https://arxiv.org/abs/2507.07048)); this app adds only the time of day and does not use location.
- **ChatGPT by default, Claude as an optional fallback**: On multi-food Nutrition5k meals, per-item gram error (PMAE) was 38.7% for GPT-5.5 versus about 51–53% for Claude Opus 4.8 and Fable 5 ([arXiv:2607.16514, 2026](https://arxiv.org/abs/2607.16514)); in another study every model underestimated grams by 12–37%, with Haiku 5.5 at about −37% ([arXiv:2610.26538, 2026](https://arxiv.org/abs/2610.26538)). The order can be changed in settings.
- **No monocular depth or 3D reconstruction**: Depth information from a single photo brought no improvement in the study above ([arXiv:2607.16514, 2026](https://arxiv.org/abs/2607.16514)). In MetaFood 2025 single-image volume estimation, the best 3D-reconstruction method had a MAPE of 0.21 versus 0.34 for GPT-5.2 estimating directly ([arXiv:2602.13041, 2026](https://arxiv.org/abs/2602.13041)). 3D reconstruction is more accurate but requires building a whole separate reconstruction pipeline, so this app estimates weight from the proportions of reference objects in the photo instead.
- **Past photos are not sent to the model as examples**: Multimodal in-context learning relies mainly on text, and images have almost no effect ([CVPR 2024 Workshop](https://arxiv.org/abs/2404.15736)); adding the 5 most similar database meals to the prompt only changed calorie MAE from 120.38 to 120.21 ([SnappyMeal, 2025](https://arxiv.org/abs/2511.03907)).

Figures are the original papers' results on their own datasets; actual results vary with how you use the app.

Architecture decision records (in Chinese) are in [`docs/decisions/`](docs/decisions/).

## Features

<p align="center">
  <img src="docs/img/screen-home.png" width="200" alt="Home: today's meals, total calories, week strip, and streak">
  <img src="docs/img/screen-result.png" width="200" alt="Result page: items, source tags, weight, and kcal per 100 g">
  <img src="docs/img/screen-plan.png" width="200" alt="Settings: daily target and weight-loss plan">
</p>
<p align="center">
  <img src="docs/img/screen-foods.png" width="200" alt="Local food library">
  <img src="docs/img/screen-home-dark.png" width="200" alt="Home (dark theme)">
</p>
<p align="center"><sub>Home · Result page · Daily target and weight-loss plan · Local food library · Dark theme (all demo data)</sub></p>

- **Logging**: Take a photo, pick one from your gallery, or type text (e.g. 「一碗滷肉飯，飯約150克」, "a bowl of braised pork rice, about 150 g of rice"). You can log a meal manually without setting up any AI.
- **Background analysis**: Runs in the background after you submit, so you can close the app; when done it is **saved as a meal automatically** (timestamped at submission) and can be edited later.
- **Calorie sources**: Package nutrition label → local food library → web search (verifiable citations required) → LLM estimate, with the source shown on every item. Calories = weight × kcal per 100 g ÷ 100, computed by code, never by the model.
- **Result page**: Edit name, weight, kcal per 100 g, and date/time. 「以新名稱重新查詢」re-queries a single item in the background; items with 0 kcal can use 「AI 估算」("AI estimate"); 「其實是同一種」saves the recognized name as a synonym of a local food.
- **Home**: Each day's meals and total calories, with week-by-week navigation. Streak 🔥 = the number of consecutive days, counting back from today, that "have entries and whose daily total does not exceed the target".
- **Weight-loss plan**: Basic info → activity level → estimated weekly loss and goal date from your daily target. Method: 1. daily expenditure TDEE = BMR (Mifflin-St Jeor) × activity factor; 2. weekly loss = (TDEE − daily target) × 7 ÷ 7,700 kcal, from which the goal date is projected (you are warned if the target is below the recommended minimum intake).
- **AI services**: ChatGPT sign-in and a Claude API key can both be configured; they are used in order with automatic fallback.
- **Mobile use**: Open the app from your own phone via Tailscale serve, sharing the same journal as your computer.
- Light/dark theme and JSON backup export.

## Architecture overview

The architecture document ([`docs/architecture.html`](docs/architecture.html)) and the highlight/diagram images are in Chinese.

### System architecture

<p align="center"><img src="docs/img/architecture.svg" alt="System architecture diagram" width="100%"></p>

The server listens only on 127.0.0.1; phones and other devices connect back to the same computer through Tailscale serve, sharing the same journal and server-side credentials.

### Recognition and calorie pipeline

<p align="center"><img src="docs/img/recognition.svg" alt="Recognition and calorie pipeline diagram" width="100%"></p>

Orange steps call a model; everything else is handled by code. Items matched by a nutrition label or the food library need no further model calls (saving tokens). On save, unedited "web data" and "nutrition label" results are cached into the food library automatically; LLM estimates from background auto-saves and items edited by the user are not cached.

## Quick start

Requires **Node.js 24 or later** (uses `node:sqlite`).

**Windows**: Double-click `start.bat` in the project root. The first run does `npm ci`, then builds the UI, sets up Tailscale serve (if installed), starts the service, and opens **http://127.0.0.1:3000**. If it is already running, it just opens the page. Close the window or press `Ctrl+C` to stop.

**macOS/Linux**:

```sh
npm ci && npm run build && npm start
```

Then open http://127.0.0.1:3000. The port defaults to 3000 and can be overridden with the `PORT` environment variable.

> Credential protection: On Windows, credentials are encrypted with AES-256-GCM and the master key is protected by Windows DPAPI. macOS/Linux have no DPAPI, so `credentials.json` is stored in **plain text**, protected only by 0700 folder and 0600 file permissions.

## AI services

Configure them on your computer under 設定 → AI 服務 (Settings → AI services). You can use just one or enable both.

ChatGPT sign-in credentials and the Claude API key are stored only in `credentials.json` on your computer (encrypted on Windows; see "Credential protection" above) and are never sent to the browser or other devices. Through Tailscale serve, your devices (phone, tablet, other computers) all connect back to this computer and use the same server-side credentials. ChatGPT sign-in is for your own account only; per OpenAI's terms of use, do not share your account or quota. Claude API usage is billed to the account that owns the API key.

- **ChatGPT (optional)**: Click Continue with ChatGPT to sign in and authorize, then choose a recognition model (photos require a model with image input). It uses your ChatGPT plan's quota; no OpenAI API key is needed. Signing in, switching, and signing out **can only be done on the computer** at `http://127.0.0.1:3000`, because the authorization redirect URL is fixed to localhost.
- **Claude API**: In the [Claude Console](https://console.anthropic.com/), create an API key **inside a Workspace** and paste it into settings. Before saving, it is validated with the free Token Counting API (for the selected model) and is not saved if invalid; keys not tied to a workspace are rejected with an explanation. Only the last four characters are shown. Choose Haiku 5.5 (default, cheapest), Sonnet 5.5, or Opus 5.5.
- **Order and fallback**: Each call uses the first enabled, available service in the list. On expired authorization, quota or rate limits, server errors, timeouts (after 1 retry), network errors, or requests the service rejects (HTTP 400), it automatically moves to the next one. Every AI-processed item notes which service and model actually handled it (e.g. 「（由 Claude Haiku 5.5 處理）」, "(processed by Claude Haiku 5.5)").
- **Cost**: ChatGPT consumes your plan's quota; the Claude API is billed by Anthropic based on usage (per token, with web search billed separately), so set a spending limit in the Console. Each meal makes exactly 1 recognition call, and items matched in the local food library make no further model calls.

## Using from your phone (Tailscale)

The service listens only on 127.0.0.1. To use it from your own phone, [Tailscale](https://tailscale.com/download) serve forwards `https://<電腦名稱>.<tailnet>.ts.net:8443` (`<電腦名稱>` = your computer's name) to local port 3000, reachable only within your tailnet. The computer must be on and running the service. Without Tailscale, you can still use it locally. **Do not** expose it publicly through another reverse proxy instead: the server trusts the identity headers Tailscale attaches, and behind other proxies those headers could be forged.

1. Install Tailscale on your computer and phone and sign in with the same account.
2. Run `tailscale serve --https=8443 --bg 3000` (`start.bat` on Windows does this automatically).
3. Create `start.local.bat` in the project root (already in `.gitignore`; on macOS/Linux, set environment variables instead):

   ```bat
   set "REMOTE_ORIGINS=https://<電腦名稱>.<tailnet>.ts.net:8443"
   set "OWNER_LOGIN=<你的 Tailscale 登入帳號>"
   rem 選填：Tailscale 不在預設位置時
   rem set "TAILSCALE=C:\Program Files\Tailscale\tailscale.exe"
   ```

   `REMOTE_ORIGINS` is the URL you open on your phone; `OWNER_LOGIN` is your Tailscale login (`<你的 Tailscale 登入帳號>`), so your phone and computer use the same journal. (The `rem` comment means: optional, if Tailscale is not in its default location.)
4. Open the ts.net URL on your phone and choose "Add to Home Screen" in the browser.

ChatGPT sign-in and AI service settings can only be changed on the computer; on your phone you can log, view, and edit meals.

## Data & food library

- **Local food library**: Stored in the journal database; read-only in the app, with no UI to add, edit, or delete entries.
- **Automatic caching**: When a meal is saved, unedited "web data" and "nutrition label" results are written to the food library automatically, without overwriting existing entries of the same name. LLM estimates from background auto-saves are never written; however, results from 「AI 估算」 on the result page that you confirm and save are written. Items whose name or calories you edited are not written. Each meal stores a snapshot of its values at save time, so later library updates never change past meals.
- **Bundled data**: `data/tfda-common.json` (TFDA food nutrient dataset, 137 entries) and `data/hpa-2018-dishes.json` (HPA 「熱量知多少」 2018, 22 entries). See [`data/ATTRIBUTION.md`](data/ATTRIBUTION.md) for sources and licenses.
- **Maintainer import**:

  ```sh
  node scripts/import-foods.mjs data/tfda-common.json data/hpa-2018-dishes.json [--dry-run]
  ```

  Or use `npm run import-foods -- data/xxx.json [--dry-run]`. With `--dry-run` it only reports how many entries would be added, skipped, or are invalid, without writing. Before a real import, the database is backed up automatically (`meals-backup-時間.sqlite` in the same folder, where 時間 is a timestamp); entries whose name or alias already exists are skipped, not overwritten. Brand data (e.g. restaurant chain nutrition labels) is not distributed with the project; you can compile it yourself in the same format and import it, checking the source's terms of use yourself. Never treat "kcal per serving" as "kcal per 100 g"; use different names for different brands, cooking methods, and raw/cooked states.

### Data location and backups

```text
~/.my-chatgpt-local/            （Windows：%USERPROFILE%\.my-chatgpt-local；可用 MEAL_JOURNAL_DATA_DIR 改位置）
  credentials.json              ChatGPT 登入憑證、Claude API key
  master.key                    加密主金鑰（僅 Windows，DPAPI 保護）
  meals.sqlite                  日誌：餐點、照片、設定、背景工作、本機食物庫
```

On Windows the folder is `%USERPROFILE%\.my-chatgpt-local`, and it can be relocated with `MEAL_JOURNAL_DATA_DIR`. `credentials.json` holds the ChatGPT sign-in credentials and Claude API key; `master.key` is the encryption master key (Windows only, DPAPI-protected); `meals.sqlite` is the journal: meals, photos, settings, background jobs, and the local food library.

- 設定 → 匯出日誌與食物備份 (Settings → Export journal and food backup) downloads a JSON file (credentials not included). For a full backup, stop the service and copy the `.sqlite` file (along with `-wal` and `-shm`).
- If credentials can't be decrypted on Windows after switching computers or user accounts: delete `credentials.json` and `master.key`, then sign in / set the API key again. The journal is unaffected.

## Privacy

- Photos and descriptions are sent to **OpenAI or Anthropic** for recognition, depending on the services you configure; web search uses only the food name and description. All other data stays on your computer.
- Credentials are kept only on the backend, never in the browser; they are encrypted on Windows and stored as 0600 plain text on macOS/Linux. All writes require an HttpOnly session and a CSRF token.
- Requests forwarded through Tailscale (carrying `Tailscale-User-Login` or `X-Forwarded-*` headers) are always treated as remote; a forged `Host: 127.0.0.1` will not make them count as local.
- Local connections need no login: other programs or other OS users on the same computer can also reach `127.0.0.1:3000` with your full permissions.
- `start.local.bat`, the database, and credentials are never committed to git.

## Development

```sh
npm test          # 模擬 OAuth 與模型，不耗額度
npm run build
npm run dev
```

`npm test` mocks OAuth and the models, so it uses no quota. Development mode (`npm run dev`) rejects all remote (Tailscale) requests and is local-only.

Server flags for testing with other Tailscale identities (`CHATGPT_SHARED`, `FRIENDS_CACHE`) are documented in [`server/README.md`](server/README.md).

## Disclaimer

ChatGPT sign-in is optional and is implemented according to OpenAI's "Sign in with ChatGPT" documentation for open-source apps (https://developers.openai.com/siwc/token-sharing-open-source). It is only for users on their own computer with their own account; you must follow OpenAI's terms of use and must not share your account. This project is not affiliated with or endorsed by OpenAI or Anthropic. This tool does not provide medical or nutrition advice. Calories are estimates; a photo cannot accurately determine portion size, hidden oil, or the full recipe, so please check the result page.

## Maintenance status

This is a personal project. There is no guarantee of ongoing maintenance, and issues may not get replies or PRs be merged. Feel free to fork it and adapt it to your own needs.

## License

The code is licensed under the [MIT License](LICENSE). Data in `data/` is licensed by its respective sources; see [`data/ATTRIBUTION.md`](data/ATTRIBUTION.md).
