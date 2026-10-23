// Tests the single pasteable SQL file with a local PostgreSQL engine and browser.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8').replace(/\r\n/g, '\n');
const owner = '11111111-1111-4111-8111-111111111111';
const admin = '22222222-2222-4222-8222-222222222222';
const stranger = '33333333-3333-4333-8333-333333333333';
let checks = 0;
const check = (actual, expected, label) => { assert.deepEqual(actual, expected, label); checks++; };
const rejects = async (promise, pattern) => { await assert.rejects(promise, pattern); checks++; };

async function main() {
    const db = new PGlite();
    let browser;
    let queue = Promise.resolve();
    const asUser = (id, operation) => {
        const task = queue.then(async () => {
            await db.query("select set_config('app.user', $1, false)", [id]);
            await db.exec('set role authenticated');
            try { return await operation(); }
            finally { await db.exec('reset role'); await db.exec("select set_config('app.user', '', false)"); }
        });
        queue = task.catch(() => {});
        return task;
    };
    try {
        await db.exec(`create role anon; create role authenticated; create schema auth; create schema storage; create schema cron;
            create table auth.users(id uuid primary key, email text, raw_user_meta_data jsonb default '{}', banned_until timestamptz);
            create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('app.user', true), '')::uuid $$;
            create table storage.buckets(id text primary key, name text, public boolean);
            create table storage.objects(bucket_id text, name text, owner_id text);
            create function storage.foldername(text) returns text[] language sql as $$ select string_to_array($1, '/') $$;
            create table cron.job(jobid bigint generated always as identity primary key, jobname text unique, schedule text, command text, active boolean default true);
            create table cron.job_run_details(jobid bigint, end_time timestamptz);
            create function cron.unschedule(bigint) returns boolean language sql as $$ delete from cron.job where jobid=$1 returning true $$;
            create function cron.schedule(text,text,text) returns bigint language sql as $$
                insert into cron.job(jobname,schedule,command) values($1,$2,$3) on conflict(jobname) do update set schedule=excluded.schedule,command=excluded.command returning jobid $$;`);
        // Cron's real scheduler and extension installation require hosted Supabase.
        // Stub only those parts; execute every application statement as written.
        const sql = read('supabase-all.sql').replace(/^create extension if not exists (pgcrypto|pg_cron);$/gm, '');
        await db.exec(sql);
        await db.exec(sql);
        check((await db.query("select count(*)::int as n from cron.job where jobname='voluntio-retention'")).rows[0].n, 1, 'full SQL runs twice with one cleanup job');
        await db.exec(`grant usage on schema public,auth,storage to authenticated;
            grant select,insert,update,delete on all tables in schema public to authenticated;`);
        for (const [id, name] of [[owner, 'Owner'], [admin, 'Admin'], [stranger, 'Other']]) await db.query('insert into auth.users(id,email) values($1,$2)', [id, name + '@test.invalid']);
        await db.query("update public.profiles set role='admin' where id=$1", [admin]);
        const dates = (await db.query(`select public.event_today()::text as today,
            (public.event_today()-1)::text as yesterday,(public.event_today()+2)::text as future,
            (public.event_today()+interval '10 years')::date::text as maximum,
            (public.event_today()+interval '10 years'+interval '1 day')::date::text as too_far`)).rows[0];
        const makeEvent = (date = dates.future) => asUser(owner, async () => (await db.query(`insert into public.events(creator_id,title,category,event_date,location,description,volunteer_role_requirements)
            values($1,'Review test event','Talka',$2,'Riga','Event description','[{"name":"Helper","capacity":3}]') returning id`, [owner, date])).rows[0].id);
        const review = (id, decision, reason = null, actor = admin) => asUser(actor, () => db.query('select public.admin_review_event($1,$2,$3)', [id, decision, reason]));
        const notifications = actor => asUser(actor, async () => (await db.query('select * from public.notifications order by created_at desc,id desc')).rows);
        check(Boolean(await makeEvent(dates.today)), true, 'today accepted');
        check(Boolean(await makeEvent(dates.maximum)), true, 'exactly ten years accepted');
        for (const invalid of [dates.yesterday, dates.too_far, '22222-11-11', '3111-12-12', '275760-03-05']) await rejects(makeEvent(invalid), /datumam|10 gadus/);
        const event = await makeEvent();
        await rejects(asUser(owner, () => db.query('update public.events set event_date=$1 where id=$2', [dates.too_far, event])), /10 gadus/);
        await rejects(review(event, 'rejected', '   '), /iemeslu/);
        check((await db.query('select status from public.events where id=$1', [event])).rows[0].status, 'pending', 'invalid rejection does not change event');
        check((await notifications(owner)).length, 0, 'invalid rejection creates no notification');
        await rejects(review(event, 'rejected', 'A reason', owner), /administrators/);
        await rejects(asUser(owner, () => db.query("update public.events set status='approved' where id=$1", [event])), /administrators/);
        const reason = 'Please clarify the location.\nInclude the meeting time. <script>example</script>';
        await review(event, 'rejected', reason);
        const notice = (await notifications(owner))[0];
        check(notice.body, reason, 'exact rejection reason delivered to owner');
        check(notice.event_id, event, 'notification links to rejected event');
        check((await notifications(stranger)).length, 0, 'another user cannot read notifications');
        await rejects(asUser(stranger, () => db.query('select public.mark_notification_read($1)', [notice.id])), /not found/);
        await rejects(asUser(owner, () => db.query("insert into public.notifications(recipient_id,title,body) values($1,'Fake','Fake')", [stranger])), /row-level security/);
        await asUser(owner, () => db.query('select public.mark_notification_read($1)', [notice.id]));
        check(Boolean((await notifications(owner))[0].read_at), true, 'reading persists read state');
        await rejects(review(event, 'rejected', 'Second rejection'), /jau ir pārskatīts/);
        check((await notifications(owner)).length, 1, 'repeated review does not duplicate notification');
        const approved = await makeEvent(); await review(approved, 'approved');
        check((await notifications(owner)).some(item => item.title.includes('apstiprināts')), true, 'approval also notifies owner');
        // A notification failure must roll back the rejection itself.
        const rollbackEvent = await makeEvent();
        await db.exec(`create function public.test_notice_failure() returns trigger language plpgsql as $$ begin raise exception 'Simulated notification failure'; end $$;
            create trigger test_notice_failure before insert on public.notifications for each row execute function public.test_notice_failure();`);
        await rejects(review(rollbackEvent, 'rejected', 'Valid reason'), /Simulated/);
        check((await db.query('select status from public.events where id=$1', [rollbackEvent])).rows[0].status, 'pending', 'notification failure rolls back review');
        await db.exec('drop trigger test_notice_failure on public.notifications; drop function public.test_notice_failure()');
        const expired = await makeEvent(), todayPending = await makeEvent(dates.today), futurePending = await makeEvent();
        const legacy = await makeEvent();
        await db.exec('alter table public.events disable trigger event_date_must_not_be_past');
        await db.query('update public.events set event_date=$1 where id=any($2::uuid[])', [dates.yesterday, [expired, event, approved]]);
        await db.query("update public.events set event_date='22222-11-11' where id=$1", [legacy]);
        await db.exec('alter table public.events enable trigger event_date_must_not_be_past');
        await rejects(review(legacy, 'approved'), /10 gadus/);
        // Run exactly the command stored for the hourly job.
        await db.exec((await db.query("select command from cron.job where jobname='voluntio-retention'")).rows[0].command);
        for (const id of [expired, event]) check((await db.query('select count(*)::int as n from public.events where id=$1', [id])).rows[0].n, 0, 'expired unapproved event deleted');
        for (const id of [approved, todayPending, futurePending]) check((await db.query('select count(*)::int as n from public.events where id=$1', [id])).rows[0].n, 1, 'approved history and current/future requests retained');
        const retainedNotice = (await notifications(owner)).find(item => item.id === notice.id);
        check(retainedNotice.body, reason, 'reason survives deleted rejected event');
        check(retainedNotice.event_id, null, 'deleted event link is cleared');

        await db.exec('delete from public.notifications');
        const uiEvent = await makeEvent();
        browser = await chromium.launch(process.platform === 'win32' ? { channel: 'msedge' } : {});
        const errors = [];
        const adminPage = await browser.newPage({ viewport: { width: 1280, height: 900 } });
        const userPage = await browser.newPage({ viewport: { width: 1280, height: 900 } });
        for (const page of [adminPage, userPage]) page.on('pageerror', error => errors.push(error.message));
        const boot = async (page, file) => {
            await page.setContent(read(file).replace(/<script[\s\S]*?<\/script>/g, '').replace(/<link[^>]+>/g, ''));
            await page.addStyleTag({ path: path.join(root, 'style.css') });
            await page.evaluate(() => { window.voluntioSupabase = {}; });
            await page.addScriptTag({ path: path.join(root, 'site.js') });
        };
        await boot(adminPage, 'admin.html');
        await adminPage.addStyleTag({ path: path.join(root, 'admin.css') });
        await adminPage.exposeFunction('__pending', () => asUser(admin, async () => ({ data: (await db.query("select id,title,creator_id,event_date::text from public.events where status='pending' and event_date >= public.event_today() order by created_at desc")).rows })));
        await adminPage.exposeFunction('__review', async args => {
            try { await review(args.target_event_id, args.decision, args.rejection_reason); return {}; }
            catch (error) { return { error: { message: error.message } }; }
        });
        await adminPage.evaluate(async ({ admin }) => {
            window.voluntioSupabase.from = () => ({ select() { return this; }, eq() { return this; }, gte() { return this; }, order: () => window.__pending() });
            window.voluntioSupabase.rpc = async (name, args) => window.__failReview ? { error: { message: 'Simulated network error' } } : window.__review(args);
            setupAdminDashboard = async () => {};
            await setupAdminRequests({ id: admin, profile: { role: 'admin' } });
        }, { admin });
        check(await adminPage.locator(`[data-event-id="${legacy}"][data-event-action="approved"]`).isDisabled(), true, 'existing invalid future request cannot be approved in UI');
        await boot(userPage, 'pasakumi.html');
        await userPage.exposeFunction('__notifications', query => asUser(owner, async () => {
            if (query.count) return { count: (await db.query('select count(*)::int as n from public.notifications where recipient_id=$1 and read_at is null', [owner])).rows[0].n };
            return { data: (await db.query('select * from public.notifications where recipient_id=$1 order by created_at desc,id desc limit $2', [owner, query.limit || 21])).rows };
        }));
        await userPage.exposeFunction('__read', async args => {
            try { await asUser(owner, () => db.query('select public.mark_notification_read($1)', [args.notification_id])); return {}; }
            catch (error) { return { error: { message: error.message } }; }
        });
        await userPage.evaluate(({ owner }) => {
            window.voluntioSupabase.from = () => ({
                select(fields, options) { this.count = Boolean(options?.head); return this; }, eq() { return this; }, order() { return this; }, is() { return this; }, limit(value) { this.limitValue = value; return this; },
                then(resolve, reject) { return window.__notifications({ count: this.count, limit: this.limitValue }).then(resolve, reject); }
            });
            window.voluntioSupabase.rpc = (name, args) => window.__read(args);
            updateAuthLinks({ id: owner, email: 'owner@test.invalid', profile: { full_name: 'Owner', role: 'user' } }); setupNavigation();
        }, { owner });
        await userPage.click('[data-notification-toggle]');
        await userPage.waitForFunction(() => document.querySelector('[data-notification-status]').textContent.includes('vēl nav'));
        check(await userPage.evaluate(() => document.querySelector('main').getBoundingClientRect().top >= document.querySelector('.navbar').getBoundingClientRect().bottom), true, 'desktop notification navigation does not cover page content');
        check(await userPage.locator('[data-notification-count]').isVisible(), false, 'empty dropdown has no unread badge');
        await userPage.click('[data-notification-toggle]');
        await adminPage.click(`[data-event-id="${uiEvent}"][data-event-action="rejected"]`);
        check(await adminPage.locator('.event-review-dialog').evaluate(dialog => dialog.matches(':modal')), true, 'rejection modal opens above admin page');
        await adminPage.click('[data-event-rejection-form] button[type="submit"]');
        check(await adminPage.locator('.event-review-dialog').isVisible(), true, 'empty reason cannot be submitted');
        await adminPage.fill('#event-rejection-reason', reason);
        await adminPage.evaluate(() => { window.__failReview = true; });
        await adminPage.click('[data-event-rejection-form] button[type="submit"]');
        await adminPage.waitForFunction(() => document.querySelector('[data-rejection-status]').textContent.includes('Simulated'));
        check(await adminPage.inputValue('#event-rejection-reason'), reason, 'failed save preserves typed reason');
        await adminPage.evaluate(() => { window.__failReview = false; });
        await adminPage.click('[data-event-rejection-form] button[type="submit"]');
        await adminPage.waitForFunction(() => !document.querySelector('.event-review-dialog'));
        await userPage.click('[data-notification-toggle]');
        await userPage.waitForFunction(() => document.querySelectorAll('[data-notification-id]').length === 1);
        check(await userPage.locator('[data-notification-count]').textContent(), '1', 'user sees unread notification badge');
        check(await userPage.locator('.notification-item span').textContent(), reason, 'reason is escaped text in dropdown');
        await userPage.click('[data-notification-id]');
        check(await userPage.locator('.notification-detail-dialog').evaluate(dialog => dialog.matches(':modal')), true, 'clicking notification opens reason dialog');
        check(await userPage.locator('.notification-body').textContent(), reason, 'full reason displayed safely');
        await userPage.waitForFunction(() => document.querySelector('[data-notification-count]').hidden);
        check(Boolean((await notifications(owner))[0].read_at), true, 'opening notification persists read status in database');
        await userPage.click('[data-notification-close]');
        await userPage.setViewportSize({ width: 390, height: 844 });
        await userPage.click('[data-menu-toggle]');
        check(await userPage.locator('[data-notification-toggle]').isVisible(), true, 'notification button visible beside logout in mobile menu');
        check(await userPage.evaluate(() => {
            const logout = document.querySelector('.logout-button').getBoundingClientRect();
            const bell = document.querySelector('[data-notification-toggle]').getBoundingClientRect();
            return bell.left >= logout.right && Math.abs((bell.top + bell.height / 2) - (logout.top + logout.height / 2)) < 2;
        }), true, 'mobile bell sits directly to the right of logout');
        await userPage.click('[data-notification-toggle]');
        const bounds = await userPage.locator('#notification-dropdown').boundingBox();
        check(bounds.x >= 0 && bounds.x + bounds.width <= 391, true, `mobile dropdown fits viewport: ${JSON.stringify(bounds)}`);
        await userPage.keyboard.press('Escape');
        check(await userPage.locator('#notification-dropdown').isVisible(), false, 'Escape closes dropdown');
        check(await userPage.evaluate(() => eventDateLimit('2024-02-29')), '2034-02-28', 'date limit handles leap days');
        for (const invalid of [dates.too_far, '22222-11-11', '3111-12-12', '275760-03-05']) check(await userPage.evaluate(value => validEventDate(value), invalid), false, 'browser helper rejects invalid future dates');
        check(await userPage.evaluate(value => validEventDate(value), dates.maximum), true, 'browser helper accepts ten-year boundary');
        await userPage.evaluate(() => setupNotifications(null));
        check(await userPage.locator('[data-notification-toggle]').count(), 0, 'guest navigation has no private notifications');
        const createPage = await browser.newPage();
        await createPage.route('http://127.0.0.1/**', route => route.fulfill({ contentType: 'text/html', body: '' }));
        await createPage.goto('http://127.0.0.1/create-event.html');
        await boot(createPage, 'create-event.html');
        await createPage.addScriptTag({ path: path.join(root, 'event-images.js') });
        await createPage.evaluate(() => setupEventForm());
        check(await createPage.inputValue('#date'), dates.today, 'actual form defaults to today');
        check(await createPage.locator('#date').getAttribute('max'), dates.maximum, 'actual form has ten-year maximum');
        for (const date of [dates.too_far, '22222-11-11', '275760-03-05']) {
            await createPage.fill('#date', date);
            check(await createPage.locator('#date').evaluate(input => input.checkValidity()), false, 'actual date input rejects out-of-range dates');
        }
        await createPage.fill('#date', dates.maximum);
        check(await createPage.locator('#date').evaluate(input => input.checkValidity()), true, 'actual date input accepts exact ten-year boundary');
        await createPage.exposeFunction('__saveEvent', async args => {
            try {
                return await asUser(owner, async () => ({ data: (await db.query('select public.save_event_with_images($1,$2::jsonb,$3::text[],$4::text[]) as id', [args.target_event_id, JSON.stringify(args.event_data), args.image_paths, args.original_image_paths])).rows[0].id }));
            } catch (error) { return { error: { message: error.message, code: error.code } }; }
        });
        await createPage.exposeFunction('__loadEvent', id => asUser(owner, async () => ({ data: { ...(await db.query('select *,event_date::text as event_date from public.events where id=$1', [id])).rows[0], event_images: [] } })));
        const wireForm = async () => createPage.evaluate(({ owner }) => {
            getCurrentUser = async () => ({ id: owner });
            window.__saveCalls = 0;
            window.voluntioSupabase.storage = { from: () => ({}) };
            window.voluntioSupabase.rpc = (name, args) => { window.__saveCalls++; return window.__saveEvent(args); };
            window.voluntioSupabase.from = () => ({ select() { return this; }, eq(key, value) { this.id = value; return this; }, single() { return window.__loadEvent(this.id); } });
        }, { owner });
        await wireForm();
        await createPage.fill('#title', 'Ten year form test'); await createPage.fill('#location', 'Riga');
        await createPage.fill('#description', 'An event created by the actual form.'); await createPage.fill('[name="role-name"]', 'Helper');
        await createPage.evaluate(() => { const form = document.querySelector('[data-event-form]'); form.elements.latitude.value = '56.95'; form.elements.longitude.value = '24.1'; });
        await createPage.click('button[type="submit"]');
        await createPage.waitForURL('**/event.html?id=*');
        const formId = new URL(createPage.url()).searchParams.get('id');
        check((await db.query('select event_date::text from public.events where id=$1', [formId])).rows[0].event_date, dates.maximum, 'actual form saves ten-year boundary to database');
        await createPage.goto('http://127.0.0.1/create-event.html?edit=' + formId);
        await boot(createPage, 'create-event.html');
        await createPage.addScriptTag({ path: path.join(root, 'event-images.js') });
        await wireForm(); await createPage.evaluate(() => setupEventForm());
        await createPage.waitForFunction(() => !document.querySelector('button[type="submit"]').disabled);
        await createPage.fill('#date', dates.too_far);
        await createPage.evaluate(() => document.querySelector('[data-event-form]').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true })));
        await createPage.waitForFunction(() => document.querySelector('[data-form-message]').textContent.includes('10 gadiem'));
        check(await createPage.evaluate(() => window.__saveCalls), 0, 'edit handler rejects beyond ten years even when native validation is bypassed');
        await createPage.fill('#date', dates.future); await createPage.click('button[type="submit"]');
        await createPage.waitForURL('**/event.html?id=*');
        check(new URL(createPage.url()).searchParams.get('id'), formId, 'date edit keeps event identity');
        check((await db.query('select event_date::text from public.events where id=$1', [formId])).rows[0].event_date, dates.future, 'valid date edit persists to database');
        await db.exec(sql);
        check((await db.query('select count(*)::int as n from public.notifications where event_id=$1', [uiEvent])).rows[0].n, 1, 'pasting full SQL again preserves existing notifications');
        check((await db.query("select count(*)::int as n from cron.job where jobname='voluntio-retention'")).rows[0].n, 1, 'pasting full SQL again does not duplicate cleanup job');
        check(errors, [], 'no uncaught browser errors');
        console.log(`PASS: ${checks} full-SQL, review, notification, date and cleanup checks`);
    } finally { if (browser) await browser.close(); await queue; await db.close(); }
}
main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
