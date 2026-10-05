# Event list and image editor checks

The browser tests use the actual HTML, CSS and JavaScript with a local Supabase adapter. Database tests run the production image migration and constraints in PGlite (PostgreSQL). They do not write to the hosted Supabase project.

Install test-only dependencies outside the repository and run from the repository root (PowerShell):

```powershell
$eventTestDeps = Join-Path $env:TEMP 'voluntio-test-deps'
npm.cmd install --prefix $eventTestDeps --no-audit --no-fund --ignore-scripts playwright @electric-sql/pglite
$env:NODE_PATH = Join-Path $eventTestDeps 'node_modules'
node tests/events.test.cjs
node tests/workflows.test.cjs
```

Windows uses installed Microsoft Edge. Other platforms use Playwright Chromium; set `BROWSER_PATH` to use an existing Chromium browser.

Checks cover local examples, filtering, pagination, mobile overflow, crop pixels and cancellation, create/edit/reload, retained and removed images, upload failures, SQL rollback, five-image replacement, and database authorization.

Workflow checks also cover duplicate applications (including simultaneous attempts), organizer tables, chat send/read/mute/remove permissions, expired and archived chat, past dates, admin event loading, per-user audit viewing/clearing, and 14-day retention. The full schema runs in the local database; hosted Realtime delivery and the Cron scheduler itself require a deployed smoke test.

## Database deployment

For any Supabase project, paste `supabase-all.sql` into its SQL Editor and run the whole file. It includes the schema, event image migration, workflow migration and optional Cron setup in dependency order.

The component files remain in the repository for the local test harness and for reference. If you run migrations separately, use this order:

1. `supabase-event-images.sql` (if not already applied).
2. `supabase-event-workflows.sql` (chat permissions, moderation fix, activity logging, date validation and cleanup).
3. `supabase-maintenance.sql` (enable Cron and install automatic cleanup).

New installations should use `supabase-all.sql`.

The maintenance job runs hourly. It deletes audit entries older than 14 days and messages belonging to expired or archived events. Archiving an event also deletes its chat immediately; hard deletion cascades. Chat access ends as soon as the event date is past in Europe/Riga. The migration cleans existing expired data on application. This is a rolling two-week history, not a wipe of recent activity every other week.

Verify the scheduled job with `select jobname, schedule, active from cron.job where jobname = 'voluntio-retention';`. [Supabase Cron setup](https://supabase.com/docs/guides/cron/install) documents the required extension. The scheduler's own history is limited to 14 days too.

The migration lets creators read their pending images and adds `save_event_with_images`. The form uploads cropped JPEGs, then this function atomically saves the event and ordered image references. Edits are sent back for approval. Replaced files are cleaned up after the transaction succeeds.

After deployment, verify one create/edit cycle with a signed-in owner against your hosted project. These local tests cannot establish that a remote migration has been applied or that the deployed Storage service is configured correctly.

Also verify a pending volunteer sees the waiting message, an approved volunteer can chat, mute prevents sending while preserving reading, and cancellation clears the event's chat. Open an admin user's list, inspect a volunteer's Audit Log, and check the Cron run history after the next scheduled run. Historical actions from before audit triggers were installed cannot be reconstructed.
