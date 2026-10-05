-- Run after supabase-event-workflows.sql in the hosted Supabase SQL Editor.
-- Supabase Cron setup: https://supabase.com/docs/guides/cron/install
create extension if not exists pg_cron;
-- Remove the old named job first so this whole script can be pasted again.
select cron.unschedule(jobid)
from cron.job
where jobname = 'voluntio-retention';

select cron.schedule('voluntio-retention', '5 * * * *', $$
    select public.cleanup_event_data();
    delete from cron.job_run_details
    where jobid = (select jobid from cron.job where jobname = 'voluntio-retention')
      and end_time < now() - interval '14 days';
$$);
-- Audit entries expire after 14 days. Ended-event chat is purged within an hour;
-- access closes immediately on the next day in Europe/Riga. Cancellation purges immediately.
