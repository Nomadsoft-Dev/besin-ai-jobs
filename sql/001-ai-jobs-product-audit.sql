-- AI product audit storage for besin-ai-jobs.
--
-- Run once in the Supabase SQL Editor. The ai_jobs schema is not exposed through the
-- Data API, so app users cannot read or write it; the audit job connects with the
-- database connection string and the admin reviews findings in the Table Editor
-- (schema selector -> ai_jobs).

create schema if not exists ai_jobs;
revoke all on schema ai_jobs from public, anon, authenticated;

-- One row per audited product. data_hash covers every field the model saw, so a product
-- is audited again only after its data changes.
create table if not exists ai_jobs.product_audit_state (
    product_id integer primary key references public.products (id) on delete cascade,
    data_hash text not null,
    model text not null,
    finding_count integer not null default 0,
    audited_at timestamptz not null default now()
);

-- One row per issue. fingerprint (product, issue type, involved ingredient ids and a hash of
-- the data the issue is about) keeps a re-found issue on its existing row, so a rejected
-- finding stays rejected until that data changes.
-- Columns are ordered for review in the Table Editor: the decision and everything needed to
-- make it come first, technical columns last.
create table if not exists ai_jobs.product_audit_findings (
    id bigint generated always as identity primary key,
    status text not null default 'open' check (status in ('open', 'approved', 'rejected', 'applied', 'resolved')),
    product_id integer not null references public.products (id) on delete cascade,
    product_name text not null default '',
    brand_name text not null default '',
    issue_type text not null check (issue_type in (
        'duplicate_ingredient', 'missing_ingredient', 'extra_ingredient',
        'nutrition_inconsistent', 'nutrition_implausible', 'bad_text', 'other'
    )),
    severity text not null check (severity in ('high', 'medium', 'low')),
    evidence text not null,
    suggestion text not null,
    on_approve text not null default '',
    product_data text not null default '',
    admin_note text,
    ingredient_ids integer[] not null default '{}',
    fingerprint text not null unique,
    data_hash text not null,
    model text not null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    reviewed_at timestamptz
);

-- For a table created by an earlier version of this file (these columns are added at the end).
alter table ai_jobs.product_audit_findings
    add column if not exists product_name text not null default '',
    add column if not exists brand_name text not null default '',
    add column if not exists on_approve text not null default '',
    add column if not exists product_data text not null default '';

comment on column ai_jobs.product_audit_findings.status is 'open: inceleme bekliyor · approved: düzeltilecek · rejected: yanlış alarm · applied: düzeltme SQL''i çalıştı · resolved: sorun artık yok';
comment on column ai_jobs.product_audit_findings.on_approve is 'Onaylarsan ne olur: SQL ile mi düzelir, elle mi';
comment on column ai_jobs.product_audit_findings.product_data is 'Bulgunun ilgili olduğu ürün verisi (içindekiler, bağlı bileşenler veya besin değerleri)';

create index if not exists product_audit_findings_status_idx
    on ai_jobs.product_audit_findings (status, created_at desc);
create index if not exists product_audit_findings_product_idx
    on ai_jobs.product_audit_findings (product_id);

-- Stamp reviewed_at when the admin changes the status in the Table Editor.
create or replace function ai_jobs.stamp_product_audit_review()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
    new.updated_at := now();
    if new.status is distinct from old.status and new.status in ('approved', 'rejected') then
        new.reviewed_at := now();
    end if;
    return new;
end;
$$;

drop trigger if exists stamp_product_audit_review on ai_jobs.product_audit_findings;
create trigger stamp_product_audit_review
    before update on ai_jobs.product_audit_findings
    for each row execute function ai_jobs.stamp_product_audit_review();

revoke all on all tables in schema ai_jobs from public, anon, authenticated;
revoke all on all functions in schema ai_jobs from public, anon, authenticated;
