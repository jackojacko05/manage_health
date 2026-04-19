# HAE Pro Google Drive 出力検証メモ

検証日: 2026-04-19

## 出力形式

| 項目 | 内容 |
|---|---|
| フォーマット | **Google Spreadsheet**（CSV ではない） |
| ファイル名 | `HealthMetrics-YYYY-MM-DD` |
| 頻度 | 1日1ファイル |
| シート名 | ファイル名と同じ（例: `HealthMetrics-2026-04-19`） |
| タイムスタンプ形式 | `YYYY-MM-DD HH:MM:SS`（JST、分単位） |
| テーブル構造 | **ワイドテーブル**（125列、スパース） |

## 列定義（全125列）

| 列番号 | ヘッダー | BQ フィールド名（案） |
|---|---|---|
| 0 | 日付/時間 | `ts` TIMESTAMP |
| 3 | Apple ムーブタイム (min) | `move_time_min` |
| 5 | Appleエクササイズ時間 (min) | `exercise_time_min` |
| 8 | VO2 Max (ml/(kg·min)) | `vo2_max` |
| 9 | アクティブエネルギー (kJ) | `active_energy_kj` |
| 14 | ウォーキング + ランニング距離 (km) | `distance_km` |
| 26 | ステップカウント (count) | `steps` |
| 57 | 体脂肪率 (%) | `body_fat_pct` |
| 58 | 体重 (kg) | `body_mass_kg` |
| 59 | 体重指数 (count) | `bmi` |
| 62 | 呼吸数 (count/min) | `respiratory_rate` |
| 67 | 安静時エネルギー (kJ) | `basal_energy_kj` |
| 68 | 安静時心拍数 (count/min) | `resting_heart_rate` |
| 70 | 心拍変動 (ms) | `hrv_sdnn_ms` |
| 71 | 心拍数 [最小] (count/min) | `hr_min` |
| 72 | 心拍数 [最大] (count/min) | `hr_max` |
| 73 | 心拍数 [平均] (count/min) | `hr_avg` |
| 95 | 登ったフライト数 (count) | `flights_climbed` |
| 96 | 睡眠分析 [Total] (hr) | `sleep_total_hr` |
| 97 | 睡眠分析 [睡眠中] (hr) | `sleep_asleep_hr` |
| 98 | 睡眠分析 [ベッドに入る] (hr) | `sleep_inbed_hr` |
| 99 | 睡眠分析 [コア] (hr) | `sleep_core_hr` |
| 100 | 睡眠分析 [深い] (hr) | `sleep_deep_hr` |
| 101 | 睡眠分析 [REM] (hr) | `sleep_rem_hr` |
| 107 | 血中酸素飽和度 (%) | `spo2_pct` |
| 113 | 身長 (m) | `height_m` |
| 118 | 除脂肪体重 (kg) | `lean_body_mass_kg` |

## サンプル行（2026-04-19 0:48:00）

```
日付/時間: 2026-04-19 0:48:00
アクティブエネルギー (kJ): 1.16
Apple立ち時間 (min): 0.2
ウォーキング + ランニング距離 (km): 0.016
```

## BQ 外部テーブル設計上の注意点

- `format = 'GOOGLE_SHEETS'` で外部テーブル化可能
- ただし **ファイルが日別に分かれる**ため、ワイルドカード URI が使えない
- GCS ワイルドカード方式を使うには HAE を CSV 出力に変更するか、Sheets → GCS 変換ジョブが必要

## 推奨取り込みフロー（案）

```
HAE → Drive Spreadsheet
        ↓
GitHub Actions / Cloud Scheduler (日次 or 都度)
  - Drive API で新規ファイル一覧取得
  - Sheets API でデータ読み取り
  - BQ INSERT (native table)
        ↓
BigQuery: health.raw_metrics (ワイドテーブルそのまま)
+ health.daily_health (daily aggregate VIEW)
+ health.heart_rate (分単位 HR)
+ health.hrv (HRV サンプル)
```

## 全列一覧

```
0: 日付/時間
1: 1秒間努力性呼気量 (L)
2: 6分間歩行テスト距離 (m)
3: Apple ムーブタイム (min)
4: Apple 睡眠時手首温度 (degC)
5: Appleエクササイズ時間 (min)
6: Apple立ち時間 (min)
7: UV曝露 (count)
8: VO2 Max (ml/(kg·min))
9: アクティブエネルギー (kJ)
10: アップルスタンドアワー (count)
11: アルコール消費 (count)
12: インスリン投与 (IU)
13: ウエスト周囲 (cm)
14: ウォーキング + ランニング距離 (km)
15: カフェイン (mg)
16: カリウム (mg)
17: カルシウム (mg)
18: クロム (mcg)
19: コレステロール (mg)
20: サイクリングケイデンス (count/min)
21: サイクリングパワー (W)
22: サイクリング機能的閾値パワー (W)
23: サイクリング距離 (km)
24: サイクリング速度 (km/hr)
25: スイミングストローク数 (count)
26: ステップカウント (count)
27: ストライド長ランニング (m)
28: セレン (mcg)
29: タンパク質 (g)
30: チアミン (mg)
31: ナイアシン (mg)
32: ナトリウム (mg)
33: パンテトン酸 (mg)
34: ビオチン (mcg)
35: ビタミンA (mcg)
36: ビタミンB12 (mcg)
37: ビタミンB6 (mg)
38: ビタミンC (mg)
39: ビタミンD (mcg)
40: ビタミンE (mg)
41: ビタミンK (mcg)
42: プッシュカウント (count)
43: ヘッドフォン音声暴露 (dBASPL)
44: マインドフルネス分数 (min)
45: マグネシウム (mg)
46: マンガン (mg)
47: モリブデン (mcg)
48: ヨウ素 (mcg)
49: ランニングのスピード (km/hr)
50: ランニングの垂直動揺 (cm)
51: ランニングパワー (W)
52: リボフラビン (mg)
53: リン (mg)
54: 一価不飽和脂肪 (g)
55: 亜鉛 (mg)
56: 体温 (degC)
57: 体脂肪率 (%)
58: 体重 (kg)
59: 体重指数 (count)
60: 努力肺活量 (L)
61: 吸入器使用量 (count)
62: 呼吸数 (count/min)
63: 呼吸障害 (count)
64: 基礎体温 (degC)
65: 塩化物 (mg)
66: 多価不飽和脂肪 (g)
67: 安静時エネルギー (kJ)
68: 安静時心拍数 (count/min)
69: 心房細動負荷 (%)
70: 心拍変動 (ms)
71: 心拍数 [最小] (count/min)
72: 心拍数 [最大] (count/min)
73: 心拍数 [平均] (count/min)
74: 心血管回復 (count/min)
75: 性的活動 [未指定] (count)
76: 性的活動 [使用された保護] (count)
77: 性的活動 [使用されていない保護] (count)
78: 手洗い (s)
79: 接地時間を計測中 (ms)
80: 日光下の時間 (min)
81: 最大呼気流速 (L/min)
82: 末梢灌流指数 (%)
83: 歩行の非対称性パーセンテージ (%)
84: 歩行ステップの長さ (cm)
85: 歩行ダブルサポート割合 (%)
86: 歩行心拍数平均 (count/min)
87: 歩行速度 (km/hr)
88: 歯磨き (s)
89: 水 (mL)
90: 水中温度 (degC)
91: 水泳距離 (m)
92: 水深 (m)
93: 炭水化物 (g)
94: 環境音曝露 (dBASPL)
95: 登ったフライト数 (count)
96: 睡眠分析 [Total] (hr)
97: 睡眠分析 [睡眠中] (hr)
98: 睡眠分析 [ベッドに入る] (hr)
99: 睡眠分析 [コア] (hr)
100: 睡眠分析 [深い] (hr)
101: 睡眠分析 [REM] (hr)
102: 睡眠分析 [起きている] (hr)
103: 砂糖 (g)
104: 総脂肪 (g)
105: 葉酸 (mcg)
106: 血中アルコール濃度 (%)
107: 血中酸素飽和度 (%)
108: 血圧 [収縮期] (mmHg)
109: 血圧 [拡張期血圧] (mmHg)
110: 血糖 (mmol/L)
111: 距離 ダウンヒル スノースポーツ (km)
112: 身体的努力 (kcal/hr·kg)
113: 身長 (m)
114: 車椅子の距離 (km)
115: 転倒回数 (count)
116: 鉄分 (mg)
117: 銅 (mg)
118: 除脂肪体重 (kg)
119: 階段速度：上 (m/s)
120: 階段速度：下り (m/s)
121: 電気皮膚活動 (mcS)
122: 食事エネルギー (kJ)
123: 食物繊維 (g)
124: 飽和脂肪酸 (g)
```
