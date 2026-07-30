-- =============================================================================
-- Manual / CI RLS smoke checks for onboarding tenancy
-- Run after migrations with service role to seed fixtures, then as users.
-- =============================================================================

-- Expected helpers:
--   is_platform_admin(), is_customer_member(uuid), is_customer_admin(uuid)

-- Test outline (execute with two auth users A=admin, B=user, C=other customer):
-- 1) platform_admin can select all customers
-- 2) customer_admin A selects only own customer
-- 3) customer_user B selects own customer but cannot update customer_workflow_steps
-- 4) user C cannot select A's customer rows
-- 5) insert source_uploads with foreign customer_id in path fails check constraint / RLS
-- 6) updating customer_id on customer_workflow_steps raises exception

-- Placeholder assertions for documentation; automated coverage lives in
-- scripts/onboarding-rls-tests.ts when env credentials are present.

select
  to_regprocedure('public.is_platform_admin()') is not null as has_platform_admin_fn,
  to_regprocedure('public.is_customer_member(uuid)') is not null as has_member_fn,
  to_regprocedure('public.is_customer_admin(uuid)') is not null as has_admin_fn;
