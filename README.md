# besin-ai-jobs

Scheduled AI jobs for Besin App. Current job: a daily product data audit with Gemma.

The audit sends new and changed catalog products to Gemma, which reports data problems:
duplicate or missing ingredient links, ingredient links the label does not mention, implausible
nutrition values and broken ingredient text. Findings are stored in Supabase for review.
**Products are never changed automatically.**

## Setup

1. Run `sql/001-ai-jobs-product-audit.sql` and `sql/002-ai-jobs-daily-start-and-exports.sql` in the
   Supabase SQL Editor.
2. Add the repository secrets `SUPABASE_DB_URL` (Session pooler connection string) and
   `GEMINI_API_KEY`.
3. For the daily start, store a fine-grained GitHub token (Actions: read and write) in Supabase
   Vault as described at the top of `sql/002`.

## Running

Supabase pg_cron starts the **Product audit** workflow every day at 08:30 UTC. It can also be
started from Actions → Product audit → Run workflow:

| Input | Meaning |
|---|---|
| until_done | Start the next run when this one ends, until every product is audited |
| from_id / to_id | Audit only this product id range |
| force | Also re-audit unchanged products in the range |
| limit | Maximum products in one run |
| dry_run | Write nothing to the database |

Actions logs are public, so they show only counts. Findings and fix SQL stay in Supabase.

## Reviewing

Open Supabase → Table Editor → `ai_jobs` → `product_audit_findings` and set `status` to
`approved` or `rejected`. `on_approve` says what approving does.

Actions → **Export approved fixes** writes the SQL for approved findings to
`ai_jobs.product_audit_fix_exports`. Review it and run it in the SQL Editor.

## Development

```bash
npm ci
npm test
```

Copy `.env.example` to `.env` to run locally: `npm run audit -- --dry-run --limit 20`.
