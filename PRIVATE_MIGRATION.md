# Private extension migration boundary

`manage_health`はZenn記事から参照される公開coreとして残す。個人の位置情報、
Google Places、Asken、Fatigueは、公開repoから参照されないprivate側へ移す。
移行対象は[private-extension-manifest.json](private-extension-manifest.json)に固定し、
この文書は実際のprivate repo作成・Cloud Run切替が完了するまでのprepare仕様である。

## Public contract to preserve

- `POST /` のHealth Auto Export Pro receiver contract
- `GCP_PROJECT_ID`、`BQ_DATASET`、`BQ_LOCATION`などのgeneric env names
- `raw_metrics`、`heart_rate`、`hrv`、`sleep_*`、`workouts`のgeneric schemas
- Bronze/Silver/Gold、bounded query、Supabase read facade
- Zenn記事のrepo URLと公開 visibility

## Private boundary

- OwnTracks `/owntracks` auth、parser、location tables
- Google Places admin/discoveryと個人場所辞書
- Asken meal records、Fatigue calculation、個人位置context
- 実project、service URL、secret、raw health/location exports

## Cutover sequence

1. private target repo/dataset/service ownerをprepareで確定する。
2. OwnTracksとPlacesをprivate serviceへ抽出し、synthetic fixtureだけでテストする。
3. 新revisionのhealth/location書き込み先、IAM、bounded queriesをread-onlyで検査する。
4. OwnTracks client endpointをpreviewし、承認後に切り替える。
5. public repoからprivate routeとlocation SQLを別PRで除去し、`--strict`を通す。
6. 旧route・旧revision・旧tablesは安定確認まで保持し、最後に個別承認で整理する。

現時点ではこのsequenceの1以前であり、public receiverや本番Cloud Runは変更していない。
