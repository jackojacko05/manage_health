-- ⚠️ HISTORICAL — see README.md.
--
-- Live REVOKE/re-GRANT pasted into Supabase SQL Editor to close the
-- anon-read hole on the existing project. The current
-- `sql/supabase-fdw.sql` already grants SELECT only to `authenticated`,
-- so this script is unnecessary on a fresh setup.
--
-- anon から読み取りを剥がす（publishable 鍵だけでは読めなくする）
REVOKE SELECT ON public.heart_rate_recent  FROM anon;
REVOKE SELECT ON public.hrv_recent         FROM anon;
REVOKE SELECT ON public.raw_metrics_recent FROM anon;
REVOKE SELECT ON public.workouts_recent    FROM anon;

-- 念のため: bq_health スキーマ自体も anon から塞ぐ
REVOKE USAGE ON SCHEMA bq_health FROM anon, authenticated, public;
GRANT  USAGE ON SCHEMA bq_health TO authenticated;

-- 確認: authenticated だけに SELECT 残ってるはず
SELECT grantee, privilege_type, table_schema, table_name
FROM information_schema.role_table_grants
WHERE table_schema = 'public'
  AND table_name IN ('heart_rate_recent','hrv_recent','raw_metrics_recent','workouts_recent')
ORDER BY table_name, grantee;
