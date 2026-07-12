# OwnTracks → BigQuery

OwnTracksのiOSアプリから、既存のCloud Run `hae-receiver`へHTTPで位置情報を送り、BigQueryの`health.location_events`へ保存する。

```text
OwnTracks iPhone
  └─ HTTPS POST /owntracks (X-OwnTracks-Token)
       └─ Cloud Run service hae-receiver
            ├─ BigQuery health.location_events
            │    └─ location_events_dedup (GEOGRAPHY付き)
            └─ BigQuery health.location_transitions
                 └─ location_transitions_dedup
```

## 1. BigQueryテーブルを作成

`native-ddl.sql`には基本の位置情報テーブル、`location-ddl.sql`にはRegion、候補、意味付け、日次コンテキストが含まれる。既存のヘルスデータを変更せずに再実行できる。

```bash
GCP_PROJECT_ID=your-project-id \
  BQ_DATASET=health \
  scripts/apply-bigquery.sh native

GCP_PROJECT_ID=your-project-id \
  BQ_DATASET=health \
  scripts/apply-bigquery.sh location
```

## 2. OwnTracks用パスワードをSecret Managerに登録

HAE Proのトークンとは別のSecretを使う。生成した値はターミナル出力やGitへ保存しない。

```bash
openssl rand -hex 32 | gcloud secrets create owntracks-auth-password \
  --project="$GCP_PROJECT_ID" \
  --data-file=- \
  --replication-policy=automatic
```

Cloud Runの実行サービスアカウントにSecretの読み取り権限を付与する。

```bash
PROJECT_NUMBER=$(gcloud projects describe "$GCP_PROJECT_ID" --format='value(projectNumber)')
SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"

gcloud secrets add-iam-policy-binding owntracks-auth-password \
  --project="$GCP_PROJECT_ID" \
  --member="serviceAccount:${SA}" \
  --role=roles/secretmanager.secretAccessor
```

HTTP Basic認証のユーザー名はデフォルトで`location`。変更する場合だけ、Cloud Runへ`OWNTRACKS_AUTH_USERNAME`を環境変数として設定する。

## 3. Cloud Runへデプロイ

```bash
cd hae-receiver
GCP_PROJECT_ID="$GCP_PROJECT_ID" \
  GCP_REGION="${GCP_REGION:-asia-northeast1}" \
  BQ_DATASET="${BQ_DATASET:-health}" \
  bash deploy.sh
```

表示されたURLの末尾に`/owntracks`を付けたものがOwnTracksの送信先になる。

## 4. iPhoneのOwnTracks設定

iOSの設定でOwnTracksに以下を許可する。

- 位置情報: 「常に」
- 正確な位置情報: オン
- Appのバックグラウンド更新: オン

OwnTracksアプリでは次を設定する。

- Connection mode: `HTTP`
- URL: `https://<Cloud Run URL>/owntracks`
- Username: `location`
- Password: Secret Managerに登録した値
- HTTP Headers: `X-OwnTracks-Token: <Secret Managerに登録した値>`
- Monitoring mode: `Significant`
- Device ID: `iphone-primary`
- Tracker ID: `ip`
- TLS証明書検証を無効にする設定: オフ

Cloud Runでは`Authorization`ヘッダーがプラットフォーム側で扱われることがあるため、`X-OwnTracks-Token`をHTTP追加ヘッダーとして設定する。OwnTracksのHTTPモードはTLS上で送信し、HTTP endpointが到達不能な場合は送信データを後で再送する。最初は`Significant`モードで開始し、細かい軌跡が必要な時だけ`Move`モードへ変更する。

## 5. 疎通確認

OwnTracks画面の手動Publishボタンを押す。成功時はサーバーが`[]`を返す。

BigQueryでは、必ずパーティション条件を含めて確認する。

```sql
SELECT
  captured_at,
  device_id,
  latitude,
  longitude,
  accuracy_m,
  trigger
FROM `PROJECT_ID.health.location_events_dedup`
WHERE DATE(captured_at) BETWEEN
    DATE_SUB(CURRENT_DATE('Asia/Tokyo'), INTERVAL 1 DAY)
    AND CURRENT_DATE('Asia/Tokyo')
ORDER BY captured_at DESC
LIMIT 10;
```

## 6. Regionの設定とtransition確認

Significant modeでは、同じ場所に留まっている間の位置イベントが少なくなるため、自宅・会社などの重要地点はOwnTracks Regionで入退場も送る。

OwnTracksアプリでRegionを作成する。

- 説明: `自宅`または`会社`
- 半径: 100-150mから開始
- Region同士は重ねない
- 作成後に手動Publishを1回実行する

Regionに入る・出ると、`_type=transition`、`event=enter|leave`、`rid`、`desc`、`tst`を含むイベントがCloud Runへ送られ、`health.location_transitions`へ保存される。

```bash
cd hae-receiver
npm run build
npm run location:admin -- recent-events --days 2 --limit 20
```

座標を表示せずにイベントIDと時刻を確認し、本人が確認した位置を登録する。

## 7. Google Maps候補から場所を登録

未知地点の候補発見はBigQuery内で行い、Google Places APIは明示的なレビュー時だけ呼ぶ。APIキーはSecret Managerの`google-maps-places-api-key`に保存する。キーやAPIレスポンスをGit、ログ、Wikiへ保存しない。

```bash
cd hae-receiver
npm run location:admin -- discover \
  --start-date 2026-07-01 \
  --end-date 2026-07-13

npm run location:admin -- list --status new,needs_review
npm run location:admin -- lookup --candidate-id CANDIDATE_ID
```

`lookup`はGoogle Mapsの候補を表示するが、BigQueryにはPlace IDだけを保存する。ユーザーが候補を確認した後、Google表示名ではなく自分用の名前で登録する。

候補発見だけを毎日実行するCloud Run Jobもデプロイできる。これはBigQuery内のクラスタ化だけを行い、Google Places APIを呼ばない。

```bash
GCP_PROJECT_ID=your-project-id \
  BQ_DATASET=health \
  scripts/deploy-location-place-discovery.sh

gcloud run jobs execute location-place-discovery \
  --project="$GCP_PROJECT_ID" \
  --region="${GCP_REGION:-asia-northeast1}" \
  --wait
```

```bash
npm run location:admin -- confirm \
  --candidate-id CANDIDATE_ID \
  --google-place-id GOOGLE_PLACE_ID \
  --name 会社 \
  --kind office \
  --radius-m 120
```

まだ候補クラスタができない場合は、直近イベントからブートストラップできる。

```bash
npm run location:admin -- register-from-event \
  --event-id EVENT_ID \
  --name 自宅 \
  --kind home \
  --radius-m 100
```

## 8. トラブルシューティング

- `401`: OwnTracksのユーザー名・パスワード、またはSecretの値が一致していない。
- `400`: `_type=location`、緯度・経度、`tst`が含まれていない。
- `503`: Cloud RunのサービスアカウントにSecret Accessor権限がない。
- `500`: BigQueryの`location_events`テーブルをまだ作成していない、またはサービスアカウントにBigQuery権限がない。

Cloud Runログには座標や受信ペイロードを出さない。位置データはBigQueryのアクセス権限と保持期間を別途管理する。

## 9. よく行く場所の知識化

位置イベントの正本は`health.location_events`、Region入退場の正本は
`health.location_transitions`。本人が確認した場所だけを
`health.location_places`へ登録し、`health.location_daily_context`を日報の
意味エビデンスに使う。未確認の頻出地点は
`health.location_place_candidates`または
`sql/queries/location-place-candidates.sql`で候補として見る。

座標・住所はBigQueryに置き、LLM Wikiには場所名、用途、確度、確認日だけを
保存する。候補から「自宅」「職場」などの名前を自動確定しない。
