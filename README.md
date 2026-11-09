# stonex-rtk-qc

Stonex Cube-a `.PD`（SQLite）VBS-RTK 觀測品管工具：唯讀讀取控制器專案檔，輸出每筆觀測 QC、點位平均、X1～X6 旗標、隔天重測清單與 RTK 觀測手簿。

- 只用 Python 標準庫（需 Python 3.10 以上）。
- `.PD` 以 `mode=ro&immutable=1` 唯讀開啟，不寫入原檔。
- 真實觀測資料與真實坐標不得進版控；測試一律用合成假資料。

## 用法

```
python -m rtkqc <一或多個 .PD> --out <資料夾> [--known 已知點.csv] [--config 門檻.json] [--id-from auto|name|code]
python -m rtkqc --version
```

- `--id-from`：點號來源。預設 `auto`：NAME 全為數字且 CODE 符合經界點代碼樣式（字母開頭、結尾為數字）時用 CODE，否則用 NAME（逐筆判斷）。
- `--known`：已知點 CSV，欄位 `點號,N,E[,H]`，有無表頭皆可，UTF-8 或 UTF-8-BOM。
- `--config`：JSON 物件，可覆蓋下表的門檻欄位；未知欄位會報錯。
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

重測建議動作依旗標對應，見 `rtkqc/rules.py` 的 `ACTIONS`。

## 測試

```
python -m unittest discover -s tests -v
```

- `tests/make_fixture.py` 產生合成 `.PD`，涵蓋各旗標、點號規則、刪除點、跨檔分組。
- `tests/test_real_sample.py` 只在設定環境變數 `RTKQC_SAMPLE_PD` 時執行，否則 skip。
