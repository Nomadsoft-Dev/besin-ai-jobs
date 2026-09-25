-- Second setup file for besin-ai-jobs. Run once in the Supabase SQL Editor after
-- 001-ai-jobs-product-audit.sql. Running it again is safe.
--
-- 1. ai_jobs.product_audit_fix_exports: the "Export approved fixes" workflow writes the fix
--    SQL here instead of GitHub logs or artifacts, which are public in a public repository.
-- 2. A daily pg_cron job that starts the product audit workflow on GitHub, because GitHub's own
--    schedule runs late or is skipped. The run is started with "until_done", so it keeps
--    starting follow-up runs until every new or changed product is audited.
--
-- The daily start needs a GitHub token in Vault; until it is stored the job only logs an error
-- in cron.job_run_details. To store it:
-- a. GitHub -> Settings -> Developer settings -> Personal access tokens -> Fine-grained tokens
--    -> Generate new token. Resource owner: Nomadsoft-Dev (if the organization requires
--    approval, an owner approves it under the organization's Settings -> Personal access tokens
--    -> Pending requests). Repository access: only besin-ai-jobs. Permissions: Actions -> Read
--    and write. Note its expiry date and renew it before then.
-- b. Run this line alone in the SQL Editor (the token stays out of this file):
--      select vault.create_secret('github_pat_...', 'besin_ai_jobs_github_token');
--    To replace it later:
--      select vault.update_secret(id, 'github_pat_...') from vault.secrets where name = 'besin_ai_jobs_github_token';

-- 1. Fix exports ---------------------------------------------------------------------------

-- One row per "Export approved fixes" run. Copy fix_sql into the SQL Editor, review and run it;
-- manual_list names the approved findings to fix by hand.
create table if not exists ai_jobs.product_audit_fix_exports (
    id bigint generated always as identity primary key,
    created_at timestamptz not null default now(),
    sql_fix_count integer not null,
    skipped_count integer not null,
    manual_count integer not null,
    fix_sql text not null,
    manual_list text not null default ''
);

revoke all on all tables in schema ai_jobs from public, anon, authenticated;

-- 2. Daily start from Supabase -------------------------------------------------------------

create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

-- Asks GitHub to start the workflow. The request is sent in the background; the answer lands
-- in net._http_response (status 204 means GitHub accepted it).
create or replace function ai_jobs.dispatch_product_audit(
    p_owner text default 'Nomadsoft-Dev',
    p_repo text default 'besin-ai-jobs',
    p_ref text default 'master'
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_token text;
begin
    select decrypted_secret into v_token
    from vault.decrypted_secrets
    where name = 'besin_ai_jobs_github_token';
    if v_token is null then
        raise exception 'Vault secret besin_ai_jobs_github_token is missing';
    end if;

    return net.http_post(
        url := format('https://api.github.com/repos/%s/%s/actions/workflows/audit.yml/dispatches', p_owner, p_repo),
        headers := jsonb_build_object(
            'Authorization', 'Bearer ' || v_token,
            'Accept', 'application/vnd.github+json',
            'X-GitHub-Api-Version', '2022-11-28',
            'User-Agent', 'besin-ai-jobs-supabase-cron',
            'Content-Type', 'application/json'
        ),
        body := jsonb_build_object('ref', p_ref, 'inputs', jsonb_build_object('until_done', 'true')),
        timeout_milliseconds := 10000
    );
end;
$$;

revoke all on function ai_jobs.dispatch_product_audit(text, text, text) from public, anon, authenticated;

-- Every day at 08:30 UTC (11:30 Europe/Istanbul), after the Gemini daily quota reset
-- (midnight Pacific time) all year. Running this file again updates the job.
select cron.schedule('besin-product-audit', '30 8 * * *', $$select ai_jobs.dispatch_product_audit()$$);

-- Checks:
--   Start a run now:       select ai_jobs.dispatch_product_audit();
--   GitHub's answer:       select status_code, content, created from net._http_response order by created desc limit 5;
--   Cron history:          select status, return_message, start_time from cron.job_run_details
--                          where jobid = (select jobid from cron.job where jobname = 'besin-product-audit')
--                          order by start_time desc limit 5;
--   Stop the daily start:  select cron.unschedule('besin-product-audit');
