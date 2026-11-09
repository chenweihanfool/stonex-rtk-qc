# stonex-rtk-qc

Stonex Cube-a `.PD`（SQLite）VBS-RTK 觀測品管工具：唯讀讀取控制器專案檔，輸出每筆觀測 QC、點位平均、X1～X6 旗標、隔天重測清單與 RTK 觀測手簿，並可產出比照 113 年「RTK 圖根測量觀測彙整檔（標準版）」的 .xlsx。

兩種用法，判定結果一致：

- **單檔 HTML（建議）**：雙擊 `rtkqc.html`、把 `.PD` 拖進去就能看結果並下載彙整檔。免安裝、離線可用。
- **Python CLI**（參考實作）：`python -m rtkqc`，只用標準庫（需 Python 3.10 以上）。

CLI 以 `mode=ro&immutable=1` 唯讀開啟 `.PD`，不寫入原檔。真實觀測資料與真實坐標不得進版控；測試一律用合成假資料。

## 單檔 HTML

- 線上使用：<https://chenweihanfool.github.io/stonex-rtk-qc/>
- 單檔下載：<https://chenweihanfool.github.io/stonex-rtk-qc/rtkqc.html>（約 1 MB，自含、無外部資源）
- **離線使用**：把 `rtkqc.html` 存到電腦，雙擊用瀏覽器（Chrome／Edge／Firefox）開啟即可，不需網路、不需安裝。
- **更新方式**：頁面載入後會背景檢查線上是否有新版（只讀 `version.json`），有的話頁首出現提示條，點「下載新版」後用新檔取代舊檔即可；離線或檢查失敗時靜默略過，不影響使用。頁首「版本歷程」可看每版變更。
- **資料不外傳**：所有計算都在本機瀏覽器完成；`.PD` 只在記憶體中讀取，不寫回、不上傳。頁面設有 Content-Security-Policy，除了檢查 `version.json` 之外不會發出任何網路請求。門檻設定只存在你瀏覽器的 localStorage。
- 輸入：一或多個 `.PD`、已知點 CSV（選填）、點號來源、門檻（可調）。
- 下載：彙整檔 `.xlsx`（主要）、`observations.csv`、`points.csv`、`remeasure.csv`、`known_check.csv`（有已知點才有）、`handbook.html`、`manifest.json`、CTL、全部打包 `.zip`。

### 彙整檔 .xlsx（比照 113 標準版）

| 工作表 | 內容 |
| --- | --- |
| 接收儀資訊表 | 廠牌（Stonex）、型號（Antenna.Type）、編號（Antenna.ID） |
| 主站坐標表 | 每個不同的虛擬基站一列（Base_ID＋位置；同 ID 不同位置加 `(2)`、`(3)`），TWD97 TM2 縱橫坐標與橢球高 |
| 觀測資料彙整表 | 每筆觀測一列，含兩次較差、主站與移動站距離、備註旗標（X1～X6、F1、T1、D1、K1） |
| 點位坐標平均值表 | 每點平均坐標與點位旗標 |
| 相鄰點位檢核表 | 2D 距離 ≤ `neighbor_max_m`（預設 100 m）的點對；「直接量測距離」留空，填入後較差、相對較差比值、檢核結果由 Excel 公式自動計算 |
| 隔天重測清單 | 同 `remeasure.csv` |
| 已知點檢核 | 只在提供已知點檔時產生，同 `known_check.csv` |

CTL：每點一行，點名右靠 8 字元＋空白＋縱坐標（0.000）＋空白＋橫坐標（0.000），換行 CRLF。

### 建置與測試

```
python tools/build_html.py        # 重建 docs/index.html、docs/rtkqc.html、docs/version.json
python -m unittest discover -s tests
node --test web/test/             # 只用 Node 內建模組；JS 核心與 Python --json／CSV／CTL 逐項對拍
```

- 原始檔在 `web/src/`（`rtkqc-core.js` 判定核心、`xlsx.js` 自寫 OOXML／ZIP 寫入器、`app.js` UI、`index.template.html`、`styles.css`）；`vendor/sql.js-1.10.3/` 為內嵌的 sql.js（MIT）。
- 改了 `web/src/`、`CHANGELOG.md` 或版本號後，必須重跑 `python tools/build_html.py` 並把 `docs/` 一起 commit；`tests/test_build.py` 會檢查 `docs/` 與重建結果位元組相同。
- 版本號以 `rtkqc/__init__.py` 為準，`web/src/rtkqc-core.js` 的 `VERSION` 與 `CHANGELOG.md` 最新一節必須一致，建置時會檢查。
- 環境變數 `RTKQC_SAMPLE_PD` 指向真實 `.PD` 時，Node 測試會對該樣本做 JS／Python 對拍（未設定則 skip）。

## 用法

```
python -m rtkqc <一或多個 .PD> --out <資料夾> [--known 已知點.csv] [--config 門檻.json] [--id-from auto|name|code] [--json 檔] [--ctl 檔]
python -m rtkqc --version
```

- `--id-from`：點號來源。預設 `auto`：NAME 全為數字且 CODE 符合經界點代碼樣式（字母開頭、結尾為數字）時用 CODE，否則用 NAME（逐筆判斷）。
- `--known`：已知點 CSV，欄位 `點號,N,E[,H]`，有無表頭皆可，UTF-8 或 UTF-8-BOM。
- `--config`：JSON 物件，可覆蓋下表的門檻欄位；未知欄位會報錯。
- `--json <檔>`：輸出判定結果正規 JSON（見下方「JSON 契約」）。`--ctl <檔>`：輸出 CTL。
- 結束碼：`0` 成功；`2` 輸入錯誤（檔案不存在、非 SQLite、缺資料表或欄位、設定錯誤），此時不產生任何輸出檔。
- 同一點分散在多個 `.PD`（例如第二次觀測在隔天）會依點號自動合併。

## 輸出檔（寫入 `--out`，不存在會建立）

| 檔名 | 內容 |
| --- | --- |
| `observations.csv` | 每筆觀測一列：來源檔名、點號、NAME、CODE、N/E/H、時間、epoch 統計、HRMS/VRMS/PDOP、主站資訊、傾斜偏移量、該筆旗標（F1、T1） |
| `points.csv` | 依點號平均：觀測數、平均 N/E/H、兩次較差（2D；3 筆以上取兩兩最大）、高程較差、觀測時間、時間間隔、旗標 |
| `remeasure.csv` | 有任何旗標的點：點號、旗標、建議動作、平均 N/E |
| `known_check.csv` | 只在提供 `--known` 時產生：與已知坐標的 dN、dE、d2D、dH、是否超限 |
| `handbook.html` | RTK 觀測手簿（單一自含 HTML，可列印 A4 橫式） |
| `manifest.json` | 工具版本、執行時間、命令列參數、使用的門檻、輸入檔名/大小/sha256、筆數與旗標統計 |

CSV 一律 UTF-8-BOM，表頭為中文，Excel 可直接開啟。

## 旗標與門檻

| 旗標 | 意義 | 門檻欄位（預設） |
| --- | --- | --- |
| X1 | 兩次觀測採相同主站（Base_ID 相同且基站位置差 < 門檻） | `same_base_tol_m` (0.01 m) |
| X2 | 任一筆固定解平面誤差 HRMS 未小於 2cm | `hrms_max` (0.02) |
| X3 | 任一筆固定解高程誤差 VRMS 未小於 5cm | `vrms_max` (0.05) |
| X4 | 任一筆 PDOP 未小於 10 | `pdop_max` (10) |
| X5 | 兩次較差（2D）未小於 2cm | `diff_2d_max` (0.02) |
| X6 | 僅有一個觀測值 | — |
| F1 | 任一 epoch 的 Pos_State 不是 FIXED | — |
| T1 | 天線傾斜偏移量（天線高 × tan(max(|Pitch|,|Roll|))）達門檻 | `tilt_offset_max` (0.01) |
| D1 | 兩次觀測時間間隔不足 | `min_interval_min` (0 = 不檢查) |
| K1 | 平均坐標與已知坐標 2D 差達門檻（需 `--known`） | `known_tol_2d` (0.02) |
| （相鄰點位檢核） | 兩點平均坐標 2D 距離不超過此值才列入相鄰點位檢核表 | `neighbor_max_m` (100) |

重測建議動作依旗標對應，見 `rtkqc/rules.py` 的 `ACTIONS`。

## JSON 契約（`--json`，JS 與 Python 對拍用）

最外層：`{"version","thresholds","inputs","observations","points","bases","neighbors","remeasure","known_check"}`。欄位名稱為英文 snake_case；浮點數先依欄位四捨五入（**半數遠離零**，先取 15 位有效數字消除二進位浮點誤差）才輸出，沒有值為 `null`。旗標一律用未四捨五入的值判定。

| 鍵 | 內容 |
| --- | --- |
| `version` | 工具版本 |
| `thresholds` | 實際使用的全部門檻（含 `neighbor_max_m`） |
| `inputs[]` | `name`、`sha256`、`observations`（去重後每個輸入檔的觀測數） |
| `observations[]` | 依 `id`、`start` 排序。`source`、`id`、`name`、`code`、`n`／`e`／`h`（3 位）、`start`、`end`、`epoch_n`、`fixed_n`、`hrms`／`vrms`／`pdop`（4 位）、`sat`、`ep_hrms_max`／`ep_vrms_max`／`ep_pdop_max`（4 位）、`ep_sat_min`、`ep_delay_max`（4 位）、`base_id`、`base_label`（主站點名，見 `bases`）、`base_lat`／`base_lon`（8 位）、`base_alt`（3 位）、`dist_base`（3 位）、`ant_h`（3 位）、`pitch`／`roll`（2 位）、`tilt_off`（4 位）、`flags`（該筆旗標 F1、T1）、`row_flags`（該筆自己的 X2、X3、X4、F1、T1，依 X1…X6、F1、T1、D1、K1 排序） |
| `points[]` | 依 `id` 排序。`id`、`count`、`avg_n`／`avg_e`／`avg_h`（3 位）、`d2`／`dh`（4 位）、`first_start`、`last_end`、`interval_min`（2 位）、`flags`（點位旗標，依 X1…X6、F1、T1、D1、K1 排序） |
| `bases[]` | 依出現順序（開始時間，同時間依輸入順序）。`label`（主站點名＝Base_ID，同 ID 不同位置加 `(2)`、`(3)`）、`base_id`、`lat`／`lon`（8 位）、`alt`（3 位，原始 Base_Altitude）、`n`／`e`（TWD97 TM2 網格坐標，3 位，已修正框架差）、`h`（3 位，`alt − undulation`）、`grid_shift_n`／`grid_shift_e`（4 位，框架修正量）、`undulation`（3 位，平均大地起伏）、`grid_corrected`（布林）、`count` |
| `neighbors[]` | 依點位排序的 i<j 點對：`id`、`other`、`dist`（3 位，平均坐標 2D 距離，≤ `neighbor_max_m`） |
| `remeasure[]` | 有旗標的點：`id`、`flags[]`、`actions[]`、`avg_n`／`avg_e`（3 位） |
| `known_check[]` | 只在有已知點時有內容：`id`、`dn`／`de`／`d2`／`dh`（4 位）、`over`（布林） |

主站坐標的框架修正：`.PD` 的經緯度（Point.Latitude／Longitude、Base_Latitude／Longitude）是網路 RTCM 轉換前的框架，Point 的 North／East／Height 才是控制器轉換後的 TWD97 網格。對每個主站，取使用該主站的所有觀測：`grid_shift_n = 平均(North − TM2N(Latitude,Longitude))`、`grid_shift_e` 同理、`undulation = 平均(Altitude − Height)`；主站網格坐標 `n = TM2N(基站經緯度) + grid_shift_n`、`e` 同理、`h = Base_Altitude − undulation`。Point 缺少 Latitude／Longitude／Altitude 欄位或值時無法修正，保留未修正值並標 `grid_corrected: false`。

主站判定：Base_ID 相同且基站位置差（近似平面距離）小於 `same_base_tol_m` 視為同一主站。

## 測試

```
python -m unittest discover -s tests -v
node --test web/test/
```

- `tests/make_fixture.py` 產生合成 `.PD`，涵蓋各旗標、點號規則、刪除點、跨檔分組。
- `tests/test_real_sample.py` 只在設定環境變數 `RTKQC_SAMPLE_PD` 時執行，否則 skip。
