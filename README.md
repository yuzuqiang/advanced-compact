# Adaptive Compact

DeepSeek Harness（dsh）的自適應上下文壓縮插件。

**版本：0.1.22** · [安裝包](packaging/adaptive-compact/adaptive-compact-0.1.22.tgz) · [設定程式碼](packaging/adaptive-compact/config.js) · [發行完整性清單](packaging/adaptive-compact/release-integrity.json)

[功能](#功能) · [安裝](#安裝) · [設定](#設定) · [驗證](#驗證) · [本地壓力測試](#本地壓力測試) · [資料與發布規則](#資料與發布規則)

## 功能

- 依 token 預算選擇壓縮範圍，保留尾部上下文，使用遲滯控制重複觸發。
- 以結構化摘要及 anchors 保存任務狀態、限制與重要資訊。
- 隨包啟用可逆工具正文去重，保留工具配對、錯誤資訊與原始事件；模型生成的摘要仍可能遺失資訊。
- 壓縮交易支援取消與拒絕提交時的回滾。

[Cordis 補丁](packaging/adaptive-compact/cordis.patch.yml) 停用 `compaction-basic`，載入 `adaptive-compact`。必要程式依賴 `@adaptive-compact/dsh-artifact-store@0.1.0` 已隨包打包，補丁沒有另外啟動該服務。

## 安裝

發行校驗需要 Node.js 24 或以上及 `tar`。以下安裝命令使用 `sha256sum`，並需要已建置的 dsh checkout 與可用依賴。在本項目根目錄執行，並替換示例中的 checkout 路徑：

```bash
plugin_source="$(pwd)/packaging/adaptive-compact/adaptive-compact-0.1.22.tgz"
plugin_digest="$(sha256sum "$plugin_source")"
plugin_dir="$HOME/.cache/adaptive-compact/${plugin_digest%% *}"
mkdir -p "$plugin_dir"
plugin_tgz="$plugin_dir/adaptive-compact-0.1.22.tgz"
cp "$plugin_source" "$plugin_tgz"
cd /path/to/deepseek-harness
pnpm dsh plugin --profile web add "$plugin_tgz" --offline
pnpm dsh plugin --profile headless add "$plugin_tgz" --offline
```

正式版本為 `0.1.22`。[來源候選](packaging/adaptive-compact/source-candidate-0.1.22.tgz) 保留原始位元組，僅用於來源比對。正式包已清理失效文檔與 source map 引用、過時套件說明及兩處驗證錯誤提示，並正規化版本號；壓縮邏輯及隨包設定未改動。逐檔來源差異與正式包 SHA-256 記錄在發行完整性清單。

此清理包與先前 `0.1.22` 的 SHA-256 不同；版本號相同，請以完整性清單區分包內容。上面使用按 SHA-256 區分的安裝路徑，避免 pnpm 沿用同版本、同路徑的舊 tgz 快取。

## 設定

| 設定 | 隨包值 |
| --- | --- |
| `auto` | `true` |
| `thresholdRatio` | `0.25` |
| `retainTokens` | `8192` |
| `hysteresis.releaseRatio` | `0.2` |
| `maxTokens` | `4096` |
| `compactionRetries` / `maxOverflowRetries` | `1` / `1` |
| `summary.dedupeToolPayloads` | `true`；來源設定預設為 `false` |
| `summary.mode` | `structured` |
| `summary.onParseError` | `fallback-prose` |
| `summary.verbatimFileArtifacts` | `false` |
| `budget.maxInputTokens` | `0` |

摘要模型未另行指定時沿用目前 agent 的提供者與模型。profile 自訂補丁可覆寫設定。

解析失敗時，`fallback-prose` 使用帶 anchors 的文字摘要，`retry-once` 再要求一次摘要，`fail` 拒絕摘要並回滾。`compactPrompt`、`compactRendering`、`foldToolRepeats`、`repairShape` 與 `jsonObject` 預設關閉。完整規則見 [config.js](packaging/adaptive-compact/config.js)。

## 驗證

根工作區沒有 npm 依賴。以下公開校驗不需要本地測試資料：

```bash
npm run check:packaging
npm run check:publication
npm run check:harness
```

發行校驗檢查 27 個 payload 的清單、SHA-256、JavaScript 語法、必要依賴、逐檔來源差異及套件操作欄位，拒絕失效文檔與 source map 引用。發布檢查拒絕本地資料檔、本機個人路徑、常見憑證格式及未經審查的壓縮包。測試工具校驗使用 Python 3 標準庫，涵蓋恢復執行與派發紀錄；CI 執行三項檢查。

完整 54 項回歸需 Python 3、已安裝的 dsh 套件，以及本地保存的 `tests/fixtures/` 與 `releases/0.1.22/test-integrity.json`。這些資料不隨 GitHub 倉庫分發。

```bash
npm run test:release -- --profile-dir "$HOME/.dsh/profiles/web"
npm run test:release -- --profile-dir "$HOME/.dsh/profiles/headless"
```

回歸涵蓋預算／摘要、原生協議、正文引用、提交與取消回滾；使用 mock adapter 或保存輸出，禁止網路請求。輸出寫入被忽略的 `results/` 目錄。`npm test` 預設測試 web profile。

## 本地壓力測試

完整 headless profile 的測試包含三組配對情境，分別關閉／啟用自動壓縮，使用 high reasoning 與 4,096-token 摘要上限。需要本地私有 fixture、dsh CLI／tsx、PyYAML，以及 Strata 模型、模板和詞表環境。

路徑由環境變數指定，請在本地設定實際值；也可從被忽略的 `.env.local` 載入：

```bash
export DSH_REPO="/path/to/deepseek-harness"
export STRATA_REPO="/path/to/Strata"
export STRATA_PYTHON="/path/to/Strata/.venv/bin/python"
export STRATA_TOKENIZER_DIR="/path/to/tokenizer"
export STRATA_EXPECTED_MODEL="your-local-model-id"

compact_run="$(pwd)/results/headless-0.1.22-$(date +%Y%m%d-%H%M%S)"
npm run bench:headless -- --run "$compact_run" --offline
npm run bench:headless -- --run "$compact_run"
npm run bench:report -- --run "$compact_run"
```

離線步驟確認原生壓縮；正式派發前核查請求准入。正式步驟會呼叫模型，要求 Strata 的本機服務載入測試指定模型，服務上下文為 131,072 tokens。測試結果與原始證據僅在本地保存。三組固定回憶情境不能代表通用任務品質或任意摘要無損性。

每次新測試使用新目錄；暫存狀態存於該目錄的 `state/`。已凍結的正式測試可加 `--resume` 繼續尚未嘗試的任務，需保留原位置、程式碼、設定及證據；失敗或部分派發的任務不可直接重跑。

## 資料與發布規則

GitHub 僅包含程式碼、公開操作文檔及已審查的發行包。`releases/`、`results/`、`tests/fixtures/`、清理收據、執行紀錄、原始請求／回應、證據 ZIP、環境設定及備份均禁止提交。

`.gitignore` 處理本地資料；發布檢查另外審查 Git index，並在 pre-push 檢查所有待推送提交及其祖先，防止舊歷史重新帶入資料。請在每個本地 checkout 啟用 hook：

```bash
git config core.hooksPath .githooks
```

檢查通過不能保證捕捉所有格式的敏感資訊。新增檔案及壓縮包仍需檢視實際內容；本地個人設定請使用環境變數，勿寫入程式碼或公開文檔。
