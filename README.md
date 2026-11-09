# stonex-rtk-qc

Stonex Cube-a `.PD`（SQLite）VBS-RTK 觀測品管工具：唯讀讀取控制器專案檔，輸出每筆觀測 QC、點位平均、X1～X6 旗標、隔天重測清單與 RTK 觀測手簿，並可產出比照 113 年「RTK 圖根測量觀測彙整檔（標準版）」的 .xlsx。v0.3.0 起支援「圖根／現況」兩種作業模式，以及連測已知加密點後把 e-GNSS 坐標轉換成法定坐標（見「已知加密點連測與坐標轉換」）。

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
- 輸入：一或多個 `.PD`、已知點 CSV（選填）、作業模式（現況／界址＝survey、圖根＝control）、已知加密點成果表 CSV（選填）、坐標轉換方法、點號來源、門檻（可調）。
- 結果區有「已知點連測與轉換」摘要卡（轉換方法、共同點數、尺度 ppm、旋轉秒、最大殘差、C1～C3 數）與每日連測警告。
- 下載：彙整檔 `.xlsx`（主要）、`observations.csv`、`points.csv`、`remeasure.csv`、`known_check.csv`（有已知點才有）、`transform.csv`、`transform_pairs.csv`（有轉換才有）、`handbook.html`、`manifest.json`、CTL、全部打包 `.zip`。

### 彙整檔 .xlsx（比照 113 標準版）

| 工作表 | 內容 |
| --- | --- |
| 接收儀資訊表 | 廠牌（Stonex）、型號（Antenna.Type）、編號（Antenna.ID） |
| 主站坐標表 | 每個不同的虛擬基站一列（Base_ID＋位置；同 ID 不同位置加 `(2)`、`(3)`），TWD97 TM2 縱橫坐標與橢球高 |
| 觀測資料彙整表 | 每筆觀測一列，含兩次較差、主站與移動站距離、備註旗標（X1～X6、F1、T1、D1、K1） |
| 點位坐標平均值表 | 每點平均坐標與點位旗標 |
| 相鄰點位檢核表 | 2D 距離 ≤ `neighbor_max_m`（預設 100 m）的點對；「直接量測距離」留空，填入後較差、相對較差比值、檢核結果由 Excel 公式自動計算 |
| 已知點連測與轉換 | 只在提供 `--control` 時產生：作業模式、轉換方法、共同點數、多餘觀測數、參數（含尺度 ppm、旋轉秒）、高程處理、檢核標準；共同點殘差表；共同點兩兩方位角／邊長檢核表 |
| 隔天重測清單 | 同 `remeasure.csv` |
| 已知點檢核 | 只在提供已知點檔時產生，同 `known_check.csv` |

有 `--control` 時，觀測資料彙整表多 N 欄「最近已知加密點」、O 欄「距離(m)」；有轉換時，點位坐標平均值表的坐標是轉換後的法定坐標，表下註記「坐標已由 e-GNSS 以 <方法> 轉換為法定坐標」。觀測資料彙整表 A3 說明列含 F1、T1、D1、K1、E1、C1～C3 說明。

CTL：每點一行，點名右靠 8 字元＋空白＋縱坐標（0.000）＋空白＋橫坐標（0.000），換行 CRLF；有轉換時用轉換後坐標。

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
                [--mode survey|control] [--control 加密點成果表.csv] [--transform auto|shift|helmert|affine|none]
python -m rtkqc --version
```

- `--id-from`：點號來源。預設 `auto`：NAME 全為數字且 CODE 符合經界點代碼樣式（字母開頭、結尾為數字）時用 CODE，否則用 NAME（逐筆判斷）。
- `--known`：已知點 CSV，欄位 `點號,N,E[,H]`，有無表頭皆可，UTF-8 或 UTF-8-BOM。
- `--config`：JSON 物件，可覆蓋下表的門檻欄位；未知欄位會報錯。
- `--mode`：作業模式。`survey`（預設，現況／界址）行為與 v0.2.0 相同、不檢查固定解筆數；`control`（圖根）預設 `min_fixed_epochs` = 180、`min_interval_min` = 60。`--config` 仍可覆蓋。模式記錄在 manifest 與 JSON。
- `--control`、`--transform`：見「已知加密點連測與坐標轉換」。
- `--json <檔>`：輸出判定結果正規 JSON（見下方「JSON 契約」）。`--ctl <檔>`：輸出 CTL。
- 結束碼：`0` 成功；`2` 輸入錯誤（檔案不存在、非 SQLite、缺資料表或欄位、設定錯誤、轉換方法需要的共同點數不足或共同點共線），此時不產生任何輸出檔。
- 同一點分散在多個 `.PD`（例如第二次觀測在隔天）會依點號自動合併。

## 輸出檔（寫入 `--out`，不存在會建立）

| 檔名 | 內容 |
| --- | --- |
| `observations.csv` | 每筆觀測一列：來源檔名、點號、NAME、CODE、N/E/H、時間、epoch 統計、HRMS/VRMS/PDOP、主站資訊、傾斜偏移量、該筆旗標（F1、T1） |
| `points.csv` | 依點號平均：觀測數、平均 N/E/H、兩次較差（2D；3 筆以上取兩兩最大）、高程較差、觀測時間、時間間隔、旗標 |
| `remeasure.csv` | 有任何旗標的點：點號、旗標、建議動作、平均 N/E |
| `known_check.csv` | 只在提供 `--known` 時產生：與已知坐標的 dN、dE、d2D、dH、是否超限（有轉換時用轉換後坐標比對） |
| `transform.csv` | 只在有轉換時產生：共同點的觀測／已知／轉換後坐標、殘差 vN、vE、v2D、旗標（C1） |
| `transform_pairs.csv` | 只在有轉換時產生：共同點兩兩的方位角較差（秒）、已知／轉換後距離、相對較差比值分母、旗標（C2、C3） |
| `handbook.html` | RTK 觀測手簿（單一自含 HTML，可列印 A4 橫式） |
| `manifest.json` | 工具版本、執行時間、命令列參數、使用的門檻、輸入檔名/大小/sha256、筆數與旗標統計 |

`observations.csv` 在有 `--control` 時多「最近已知加密點」「距最近加密點(m)」兩欄；`points.csv` 在有轉換時多「轉換後N」「轉換後E」「轉換後H」三欄。沒給 `--control` 時所有輸出與 v0.2.0 相同（版本字串、手簿的模式／轉換列與旗標說明除外）。

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
| E1 | 該筆觀測的 FIXED epoch 數少於門檻（門檻 > 0 才檢查；圖根模式預設 180） | `min_fixed_epochs` (0；control 模式 180) |
| D1 | 兩次觀測時間間隔不足 | `min_interval_min` (0 = 不檢查) |
| K1 | 平均坐標（有轉換用轉換後坐標）與已知坐標 2D 差達門檻（需 `--known`） | `known_tol_2d` (0.02) |
| C1 | 共同點轉換後，任一坐標分量改正數 \|v\| ≥ 門檻（需 `--control`） | `transform_resid_max` (0.098 m) |
| C2 | 共同點兩兩之間，轉換後與已知坐標反算的方位角較差 ≥ 門檻；掛到相關兩點 | `azimuth_diff_max_sec` (20 秒) |
| C3 | 共同點兩兩之間水平距相對較差 \|d_t − d_k\|/d_k ≥ 1/門檻；掛到相關兩點 | `distance_ratio_min` (20000) |
| （相鄰點位檢核） | 兩點平均坐標 2D 距離不超過此值才列入相鄰點位檢核表 | `neighbor_max_m` (100) |

重測建議動作依旗標對應，見 `rtkqc/rules.py` 的 `ACTIONS`。旗標排序：X1…X6、F1、T1、E1、D1、K1、C1、C2、C3。

## 已知加密點連測與坐標轉換

依據：國土測繪中心「採用虛擬基準站即時動態定位技術辦理加密控制及圖根測量作業手冊」（經研究報告引用）。

- 圖根測量：1 Hz、每測回至少 180 筆固定解、兩測回間隔 60 分鐘以上、平面 < 2 cm、高程 < 5 cm（`--mode control` 的預設門檻）。
- e-GNSS 坐標與法定 TWD97 不一致，要連測已知控制點做轉換：小範圍可用 ≥1 點「坐標分量平移」；精度要求高時用外圍 ≥4 點做 4 或 6 參數平面轉換。
- 轉換後檢核：共同點坐標分量改正數 < 9.8 cm（C1）；共同點間方位角較差 < 20 秒（C2）；水平距相對較差比值 < 1/20000（C3）。

用法：`--control <csv>` 匯入已知加密點成果表（欄位 `點號,N,E[,H]`，解析規則同 `--known`）。觀測點號與加密點號相同者為**共同點**，使用該點的平均坐標當觀測坐標。

`--transform`：

| 值 | 說明 |
| --- | --- |
| `auto`（預設） | 共同點 0 個：不轉換；1 個：shift；≥2 個：helmert |
| `shift` | 坐標分量平移：用全部共同點平均分量差（≥1 點） |
| `helmert` | 4 參數（平移、旋轉、尺度）最小二乘（≥2 點） |
| `affine` | 6 參數最小二乘（≥3 點） |
| `none` | 不轉換 |

指定的方法所需的共同點數不足（例如 `affine` 少於 3 點）、或共同點重合／共線無法求解時，印出錯誤並以結束碼 2 結束，不產生任何輸出檔。

模型：先以共同點觀測坐標的重心 (cn, ce) 中心化（n、e 為中心化坐標），再解正規方程（共同點觀測坐標 → 已知坐標）。

```
shift  : N' = N + tN                       E' = E + tE
helmert: N' = cn + (a·n − b·e) + tN        E' = ce + (b·n + a·e) + tE
affine : N' = cn + (a1·n + a2·e) + tN      E' = ce + (b1·n + b2·e) + tE
```

`tN`、`tE` 是重心處的平移量（法定 − 觀測），所以數值通常只有公尺級以下。helmert 另輸出 `scale_ppm` = (√(a²+b²) − 1) × 10⁶、`rotation_sec` = atan2(b, a) 換算成秒。多餘觀測數：shift 2n−2、helmert 2n−4、affine 2n−6；為 0 時（例如 2 點 helmert、1 點 shift）仍照算，但註記「無多餘觀測，殘差無檢核意義」。

高程：加密點有 H 且共同點觀測有 H 時，`dH` = 平均(H_已知 − H_觀測)，轉換後高程 = 觀測高程 + dH；否則高程不轉換並註記。

轉換套用到所有點位（points 的 `n_t`、`e_t`、`h_t`）；CTL、點位坐標平均值表與 K1 一律使用轉換後坐標，沒有轉換時用原坐標。每筆觀測另找最近的已知加密點（用轉換後坐標），輸出點號與距離。

每日連測檢查：依觀測日（開始時間日期）統計當天是否至少觀測到 1 個加密點；沒有連測的日期列在 JSON 的 `days_without_control`，stderr、manifest 與網頁都會警告。

## JSON 契約（`--json`，JS 與 Python 對拍用）

最外層：`{"version","thresholds","inputs","observations","points","bases","neighbors","remeasure","known_check","mode","transform","control_days","days_without_control"}`。欄位名稱為英文 snake_case；浮點數先依欄位四捨五入（**半數遠離零**，先取 15 位有效數字消除二進位浮點誤差）才輸出，沒有值為 `null`。旗標一律用未四捨五入的值判定。

| 鍵 | 內容 |
| --- | --- |
| `version` | 工具版本 |
| `thresholds` | 實際使用的全部門檻（含 `neighbor_max_m`） |
| `inputs[]` | `name`、`sha256`、`observations`（去重後每個輸入檔的觀測數） |
| `observations[]` | 依 `id`、`start` 排序。`source`、`id`、`name`、`code`、`n`／`e`／`h`（3 位）、`start`、`end`、`epoch_n`、`fixed_n`、`hrms`／`vrms`／`pdop`（4 位）、`sat`、`ep_hrms_max`／`ep_vrms_max`／`ep_pdop_max`（4 位）、`ep_sat_min`、`ep_delay_max`（4 位）、`base_id`、`base_label`（主站點名，見 `bases`）、`base_lat`／`base_lon`（8 位）、`base_alt`（3 位）、`dist_base`（3 位）、`ant_h`（3 位）、`pitch`／`roll`（2 位）、`tilt_off`（4 位）、`flags`（該筆旗標 F1、T1、E1）、`row_flags`（該筆自己的 X2、X3、X4、F1、T1、E1，依旗標排序）、`nearest_control`（最近已知加密點號，無 `--control` 為 null）、`nearest_control_dist`（3 位） |
| `points[]` | 依 `id` 排序。`id`、`count`、`avg_n`／`avg_e`／`avg_h`（3 位）、`d2`／`dh`（4 位）、`first_start`、`last_end`、`interval_min`（2 位）、`flags`（點位旗標，依 X1…X6、F1、T1、E1、D1、K1、C1、C2、C3 排序）、`n_t`／`e_t`／`h_t`（轉換後坐標，3 位；沒有轉換為 null） |
| `bases[]` | 依出現順序（開始時間，同時間依輸入順序）。`label`（主站點名＝Base_ID，同 ID 不同位置加 `(2)`、`(3)`）、`base_id`、`lat`／`lon`（8 位）、`alt`（3 位，原始 Base_Altitude）、`n`／`e`（TWD97 TM2 網格坐標，3 位，已修正框架差）、`h`（3 位，`alt − undulation`）、`grid_shift_n`／`grid_shift_e`（4 位，框架修正量）、`undulation`（3 位，平均大地起伏）、`grid_corrected`（布林）、`count` |
| `neighbors[]` | 依點位排序的 i<j 點對：`id`、`other`、`dist`（3 位，平均坐標 2D 距離，≤ `neighbor_max_m`） |
| `remeasure[]` | 有旗標的點：`id`、`flags[]`、`actions[]`、`avg_n`／`avg_e`（3 位） |
| `known_check[]` | 只在有已知點時有內容：`id`、`dn`／`de`／`d2`／`dh`（4 位）、`over`（布林） |
| `mode` | 作業模式：`survey` 或 `control` |
| `transform` | 沒有轉換為 null；否則 `{method, n_common, redundancy, params, centroid{n,e}（3 位）, dh（4 位，無高程轉換為 null）, common[], pairs[], note}`。`params`：`tN`／`tE`（4 位）；helmert 另有 `a`／`b`（12 位）、`scale_ppm`（3 位）、`rotation_sec`（3 位）；affine 為 `a1`／`a2`／`b1`／`b2`（12 位）。`common[]`：`id`、`n_obs`／`e_obs`／`h_obs`、`n_known`／`e_known`／`h_known`、`n_t`／`e_t`／`h_t`（3 位）、`vn`／`ve`／`v2d`（4 位，已知 − 轉換後）、`flags`（C1）。`pairs[]`（共同點 i<j）：`i`、`j`（點號）、`az_diff_sec`（2 位，取 ±180° 內的絕對值）、`d_known`／`d_t`（3 位）、`ratio_den`（0 位，= d_known / \|d_t − d_known\|，差為 0 時 null）、`flags`（C2、C3）。`note` 為註記文字（無多餘觀測、高程未轉換等，沒有則空字串） |
| `control_days[]` | 有 `--control` 時每個觀測日：`date`、`control_points[]`（當天觀測到的加密點）；沒給為空陣列 |
| `days_without_control[]` | 沒有連測任何加密點的觀測日 |

主站坐標的框架修正：`.PD` 的經緯度（Point.Latitude／Longitude、Base_Latitude／Longitude）是網路 RTCM 轉換前的框架，Point 的 North／East／Height 才是控制器轉換後的 TWD97 網格。對每個主站，取使用該主站的所有觀測：`grid_shift_n = 平均(North − TM2N(Latitude,Longitude))`、`grid_shift_e` 同理、`undulation = 平均(Altitude − Height)`；主站網格坐標 `n = TM2N(基站經緯度) + grid_shift_n`、`e` 同理、`h = Base_Altitude − undulation`。Point 缺少 Latitude／Longitude／Altitude 欄位或值時無法修正，保留未修正值並標 `grid_corrected: false`。

主站判定：Base_ID 相同且基站位置差（近似平面距離）小於 `same_base_tol_m` 視為同一主站。

## 測試

```
python -m unittest discover -s tests -v
node --test web/test/
```

- `tests/make_fixture.py` 產生合成 `.PD`，涵蓋各旗標、點號規則、刪除點、跨檔分組；`control_scenario` 以已知轉換（平移 −0.26／+0.40 m、尺度 +5 ppm、旋轉 +2 秒、高程差 0.35 m）反推觀測坐標，供轉換測試回推參數。
- `tests/test_transform.py` 與 `web/test/transform.test.js`：作業模式、E1、轉換（helmert／affine／shift）、C1～C3、每日連測，JS 與 Python 逐項對拍。
- `tests/test_real_sample.py` 只在設定環境變數 `RTKQC_SAMPLE_PD` 時執行，否則 skip。
