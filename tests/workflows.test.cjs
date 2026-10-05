const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const ids = { owner: '11111111-1111-4111-8111-111111111111', member: '22222222-2222-4222-8222-222222222222', outsider: '33333333-3333-4333-8333-333333333333', admin: '44444444-4444-4444-8444-444444444444' };
let count = 0;
const check = (actual, expected, label) => { assert.deepEqual(actual, expected, label); count++; };
const reject = async (call, pattern) => { await assert.rejects(call, pattern); count++; };
async function main() {
    const db = new PGlite();
    let browser;
    try {
        await db.exec(`create role anon; create role authenticated; create schema auth; create schema storage;
            create table auth.users(id uuid primary key, email text, raw_user_meta_data jsonb default '{}', banned_until timestamptz);
            create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('app.user', true), '')::uuid $$;
            create table storage.buckets(id text primary key, name text, public boolean);
            create table storage.objects(bucket_id text, name text, owner_id text);
            create function storage.foldername(text) returns text[] language sql as $$ select string_to_array($1, '/') $$;`);
        await db.exec(read('supabase-schema.sql').replace('create extension if not exists pgcrypto;', ''));
        // Execute the standalone migration too: reruns must be safe.
        await db.exec(read('supabase-event-workflows.sql'));
        await db.exec(`grant usage on schema public, auth, storage to authenticated, anon;
            grant all on all tables in schema public to authenticated;
            grant select on all tables in schema public to anon;
            grant usage, select on all sequences in schema public to authenticated;`);
        for (const [name, id] of Object.entries(ids)) await db.query('insert into auth.users(id,email) values ($1,$2)', [id, name + '@test.invalid']);
        await db.query("update public.profiles set role = 'admin' where id=$1", [ids.admin]);
        const as = async (user, role = 'authenticated') => {
            await db.exec('reset role'); await db.query("select set_config('app.user', $1, false)", [ids[user] || '']); await db.exec('set role ' + role);
        };
        const today = (await db.query('select public.event_today()::text as day')).rows[0].day;
        const yesterday = (await db.query("select (public.event_today()-1)::text as day")).rows[0].day;
        const future = (await db.query("select (public.event_today()+2)::text as day")).rows[0].day;
        const makeEvent = async (date = today) => (await db.query(`insert into public.events(creator_id,title,category,event_date,location,description,volunteer_role_requirements)
            values ($1,'Test event','Talka',$2,'Riga','Testing','[{"name":"Helper","capacity":3}]') returning id`, [ids.owner, date])).rows[0].id;
        await as('owner');
        await reject(makeEvent(yesterday), /datumam/);
        const event = await makeEvent();
        check(Boolean(event), true, 'today accepted');
        await reject(db.query('update public.events set event_date=$1 where id=$2', [yesterday, event]), /datumam/);
        await db.query("update public.events set status='approved' where id=$1", [event]);
        const access = async () => (await db.query('select public.event_chat_access($1) as access', [event])).rows[0].access;
        check((await access()).can_write, true, 'organizer can chat');
        await as('member');
        check((await access()).can_read, false, 'nonparticipant cannot read');
        const application = (await db.query("insert into public.event_applications(event_id,volunteer_id,requested_role,message) values ($1,$2,'Helper','Can I join?') returning id", [event, ids.member])).rows[0].id;
        await reject(db.query("insert into public.event_applications(event_id,volunteer_id,requested_role) values ($1,$2,'Helper')", [event, ids.member]), /unique constraint/);
        check((await access()).reason, 'pending', 'pending member cannot chat');
        const send = () => db.query("insert into public.event_messages(event_id,sender_id,message) values ($1,$2,'Hello team') returning id", [event, ids.member]);
        await reject(send(), /atļauts/);
        await as('owner');
        await db.query("select public.set_event_application_status($1, 'approved')", [application]);
        await as('member'); check((await access()).can_write, true, 'approved member can write');
        await send();
        check((await db.query('select count(*)::int as n from public.event_messages where event_id=$1', [event])).rows[0].n, 1, 'member sees sent message');
        await as('owner');
        await db.query("select public.organizer_set_participant_state($1,$2,'mute')", [event, ids.member]);
        await as('member');
        check(await access(), { can_read: true, can_write: false, reason: 'muted' }, 'muted members can read but not write');
        await reject(send(), /atļauts/);
        check((await db.query('update public.event_participant_moderation set is_muted=false returning event_id')).rows.length, 0, 'member cannot unmute themselves');
        await as('owner');
        await db.query("select public.organizer_set_participant_state($1,$2,'unmute')", [event, ids.member]);
        await as('member'); await send();
        await as('owner');
        await db.query("select public.organizer_set_participant_state($1,$2,'kick')", [event, ids.member]);
        await as('member');
        check((await access()).can_read, false, 'removed participant loses access');
        check((await db.query('select count(*)::int as n from public.event_messages')).rows[0].n, 0, 'removed participant cannot read own old messages');
        await reject(send(), /atļauts/);
        await as('owner');
        await db.query("update public.events set status='archived' where id=$1", [event]);
        await db.exec('reset role');
        check((await db.query('select count(*)::int as n from public.event_messages where event_id=$1', [event])).rows[0].n, 0, 'archive immediately clears event chat');
        await as('owner');
        const deletedEvent = await makeEvent(future);
        const retainedEvent = await makeEvent(future);
        for (const id of [deletedEvent, retainedEvent]) await db.query("insert into public.event_messages(event_id,sender_id,message) values ($1,$2,'Keep event scope')", [id, ids.owner]);
        await db.exec('reset role');
        await db.query('delete from public.events where id=$1', [deletedEvent]);
        check((await db.query('select count(*)::int as n from public.event_messages where event_id=$1', [deletedEvent])).rows[0].n, 0, 'hard deletion cascades to chat');
        check((await db.query('select count(*)::int as n from public.event_messages where event_id=$1', [retainedEvent])).rows[0].n, 1, 'deletion preserves other event chat');
        await as('owner');
        const expired = await makeEvent(future);
        await db.query("insert into public.event_messages(event_id,sender_id,message) values ($1,$2,'Will expire')", [expired, ids.owner]);
        await db.exec('reset role');
        // Simulate a day passing without making an invalid edit through the normal API.
        await db.exec('alter table public.events disable trigger event_date_must_not_be_past');
        await db.query('update public.events set event_date=$1 where id=$2', [yesterday, expired]);
        await db.exec('alter table public.events enable trigger event_date_must_not_be_past');
        check((await db.query('select public.event_chat_access($1) as access', [expired])).rows[0].access.reason, 'ended', 'expired event immediately closes chat access');
        await db.exec('alter table public.event_messages disable trigger validate_event_message');
        await db.query("insert into public.event_messages(event_id,sender_id,message) values ($1,$2,'Existing expired chat')", [expired, ids.owner]);
        await db.exec('alter table public.event_messages enable trigger validate_event_message');
        await db.query("insert into public.audit_logs(actor_id,action,entity_type,created_at) values ($1,'OLD','test',now()-interval '15 days'),($1,'RECENT','test',now()-interval '13 days')", [ids.member]);
        await db.exec("select set_config('app.user','',false); select public.cleanup_event_data();");
        check((await db.query('select count(*)::int as n from public.event_messages where event_id=$1', [expired])).rows[0].n, 0, 'scheduled cleanup removes expired chat');
        check((await db.query('select count(*)::int as n from public.event_messages where event_id=$1', [retainedEvent])).rows[0].n, 1, 'scheduled cleanup preserves active chat');
        check((await db.query("select count(*)::int as n from public.audit_logs where action='OLD'")).rows[0].n, 0, 'logs older than 14 days deleted');
        check((await db.query("select count(*)::int as n from public.audit_logs where action='RECENT'")).rows[0].n, 1, 'recent logs retained');
        await as('member');
        await reject(db.query('select public.admin_clear_user_audit($1)', [ids.owner]), /administrators/);
        await reject(db.query("insert into public.audit_logs(actor_id,action,entity_type) values ($1,'FAKE','test')", [ids.member]), /row-level security/);
        check((await db.query('select count(*)::int as n from public.audit_logs')).rows[0].n, 0, 'nonadmin cannot read audits');
        await reject(db.query('select public.cleanup_event_data()'), /permission/);
        await as('admin');
        const audits = (await db.query('select * from public.audit_logs where actor_id=$1', [ids.member])).rows;
        check(audits.some(log => log.entity_type === 'event_applications' && log.action === 'INSERT'), true, 'application activity recorded');
        check(audits.some(log => log.entity_type === 'event_messages' && log.action === 'INSERT'), true, 'chat activity recorded');
        check(audits.every(log => !JSON.stringify(log.details).includes('Hello team')), true, 'audit metadata avoids message copies');
        await db.query('select public.admin_clear_user_audit($1)', [ids.member]);
        check((await db.query('select count(*)::int as n from public.audit_logs where actor_id=$1', [ids.member])).rows[0].n, 0, 'admin clears selected user audit');
        check((await db.query("select count(*)::int as n from public.audit_logs where action='cleared_user_audit'")).rows[0].n, 1, 'clear action remains accountable');

        browser = await chromium.launch(process.platform === 'win32' ? { channel: 'msedge' } : {});
        const page = await browser.newPage();
        await page.setContent('<div data-form-message></div>');
        await page.evaluate(() => { window.voluntioSupabase = {}; });
        await page.addScriptTag({ path: path.join(root, 'site.js') });
        for (const status of ['pending', 'approved', 'rejected']) {
            const result = await page.evaluate(async status => {
                let inserts = 0;
                window.voluntioSupabase.from = () => ({ select() { return this; }, eq() { return this; }, maybeSingle: async () => ({ data: { status } }), insert() { inserts++; } });
                const result = await submitEventApplication('event', 'user', 'Helper', 'Hi');
                return { result, inserts, message: applicationStatusMessage(result) };
            }, status);
            check(result.result, status, 'existing application status returned'); check(result.inserts, 0, 'duplicate not inserted'); check(result.message.includes('constraint'), false, 'friendly application message');
        }
        check(await page.evaluate(async () => {
            let reads = 0;
            window.voluntioSupabase.from = () => ({ select() { return this; }, eq() { return this; }, maybeSingle: async () => ({ data: ++reads === 1 ? null : { status: 'approved' } }), insert: async () => ({ error: { code: '23505' } }) });
            return submitEventApplication('event', 'user', 'Helper', 'Hi');
        }), 'approved', 'concurrent duplicate gets friendly current status');
        await page.setContent(read('event.html').replace(/<script[\s\S]*?<\/script>/g, '').replace(/<link[^>]+>/g, ''));
        await page.addStyleTag({ path: path.join(root, 'style.css') }); await page.addStyleTag({ path: path.join(root, 'event-page.css') });
        await page.addScriptTag({ path: path.join(root, 'event-chat.js') });
        await page.evaluate(async () => {
            window.__messages = []; window.__sent = 0; window.__refresh = null;
            window.voluntioSupabase.rpc = async () => ({ data: { can_read: true, can_write: true } });
            window.voluntioSupabase.channel = () => ({ on(event, filter, callback) { window.__refresh = callback; return this; }, subscribe() { return this; } });
            window.voluntioSupabase.removeChannel = () => {};
            window.voluntioSupabase.from = () => ({ select() { return this; }, eq() { return this; }, order() { return this; }, limit: async () => ({ data: window.__messages }), insert: async payload => { window.__sent++; window.__messages.push({ ...payload, id: 'message', created_at: new Date().toISOString(), profiles: { full_name: 'Tester' } }); return {}; } });
            await setupEventChat({ id: 'event', creator_id: 'user' }, { id: 'user' });
        });
        await page.fill('[name="message"]', 'Working chat'); await page.click('[data-chat-form] button');
        await page.waitForFunction(() => document.querySelector('[data-chat-list]').textContent.includes('Working chat'));
        check(await page.inputValue('[name="message"]'), '', 'successful send clears composer');
        check(await page.locator('.chat-message time').count(), 1, 'chat displays timestamp');
        await page.evaluate(async () => { window.voluntioSupabase.rpc = async () => ({ data: { can_read: true, can_write: false, reason: 'muted' } }); await window.__refresh(); });
        check(await page.locator('[data-chat-form]').isVisible(), false, 'mute hides composer despite display grid CSS');
        check(await page.locator('.chat-message').count(), 1, 'muted user retains read access');
        await page.evaluate(async () => { window.voluntioSupabase.rpc = async () => ({ data: { can_read: false, can_write: false, reason: 'ended' } }); await window.__refresh(); });
        check(await page.locator('.chat-message').count(), 0, 'ended chat clears visible messages');
        check(await page.locator('[data-chat-notice]').isVisible(), true, 'ended notice visible');

        const organizerPage = await browser.newPage({ viewport: { width: 1280, height: 900 } });
        await organizerPage.setContent(read('event.html').replace(/<script[\s\S]*?<\/script>/g, '').replace(/<link[^>]+>/g, ''));
        await organizerPage.addStyleTag({ path: path.join(root, 'style.css') });
        await organizerPage.addStyleTag({ path: path.join(root, 'event-page.css') });
        await organizerPage.evaluate(({ today }) => {
            window.voluntioSupabase = {
                auth: { getUser: async () => ({ data: { user: { id: 'owner', email: 'owner@test.invalid' } } }) },
                rpc: async name => ({ data: name === 'event_participants' ? [{ id: 'member', full_name: 'Member', requested_role: 'Helper', is_muted: true }] : [{ role_name: 'Helper', capacity: 3, filled: 1 }] }),
                from(table) { return {
                    select() { return this; }, eq() { return this; },
                    single: async () => ({ data: table === 'profiles' ? { full_name: 'Owner' } : { id: 'event', title: 'Test', category: 'Talka', description: 'Test', event_date: today, creator_id: 'owner', profiles: { full_name: 'Owner' }, location: 'Riga', event_images: [], volunteer_role_requirements: [] } }),
                    maybeSingle: async () => ({ data: null }),
                    order: async () => ({ data: [
                        { id: 'one', volunteer_id: 'member', status: 'approved', requested_role: 'Helper', message: 'Can I join?', profiles: { full_name: 'Member' } },
                        { id: 'two', volunteer_id: 'pending', status: 'pending', requested_role: 'Helper', message: '<script>unsafe</script>', profiles: { full_name: 'Pending person' } }
                    ] })
                }; }
            };
            window.setupEventChat = async () => {};
        }, { today });
        await organizerPage.addScriptTag({ path: path.join(root, 'site.js') });
        await organizerPage.evaluate(() => setupEventDetail());
        check(await organizerPage.locator('.organizer-table th').allTextContents(), ['Vārds', 'Loma', 'Statuss', 'Ziņa', 'Darbības'], 'organizer has requested columns');
        check(await organizerPage.locator('.organizer-table tbody tr').count(), 2, 'one valid table row per applicant');
        check(await organizerPage.locator('[data-participant-action="unmute"]').count(), 1, 'muted member offers unmute');
        check(await organizerPage.locator('[data-participant-action="kick"]').count(), 1, 'approved member offers removal');
        check(await organizerPage.locator('[data-application-status="approved"]').count(), 1, 'pending applicant offers approval');
        check(await organizerPage.locator('.application-message').last().textContent(), '<script>unsafe</script>', 'application message is escaped text');
        check((await organizerPage.locator('.organizer-table').textContent()).includes('Nevar rakstīt pasākuma čatā'), true, 'muted state explained');

        const adminPage = await browser.newPage({ viewport: { width: 1280, height: 900 } });
        await adminPage.setContent(read('admin.html').replace(/<script[\s\S]*?<\/script>/g, '').replace(/<link[^>]+>/g, ''));
        await adminPage.addStyleTag({ path: path.join(root, 'style.css') });
        await adminPage.addStyleTag({ path: path.join(root, 'admin.css') });
        await adminPage.evaluate(() => {
            window.__auditUser = null; window.__clearedUser = null; window.__eventError = false;
            const rows = {
                profiles: [{ id: 'owner', full_name: 'Owner', role: 'user' }, { id: 'member', full_name: 'Member', role: 'user' }],
                events: [{ id: 'event', creator_id: 'owner', title: 'Visible event', event_date: '2030-01-01', status: 'approved' }],
                event_applications: [{ id: 'application', volunteer_id: 'member', event_id: 'event', status: 'pending' }], reports: [],
                audit_logs: [{ id: 'audit', action: 'INSERT', entity_type: 'events', entity_id: 'event', created_at: '2026-10-05T12:34:56Z', details: { title: 'Created event' } }]
            };
            window.voluntioSupabase = {
                from(table) { return { select() { return this; }, order() { return this; }, neq() { return this; }, gte() { return this; }, range() { return this; },
                    eq(field, value) { if (field === 'actor_id') window.__auditUser = value; return this; },
                    then(resolve) { return Promise.resolve({ data: window.__eventError && table === 'events' ? null : rows[table], error: window.__eventError && table === 'events' ? { message: 'Test database error' } : null, count: 1 }).then(resolve); }
                }; },
                rpc: async (name, args) => { window.__clearedUser = args.target_user_id; rows.audit_logs = []; return {}; }
            };
        });
        await adminPage.addScriptTag({ path: path.join(root, 'site.js') });
        await adminPage.addScriptTag({ path: path.join(root, 'admin-audit.js') });
        await adminPage.evaluate(async () => { setupAdminAudit(); await setupAdminDashboard({ profile: { role: 'admin' } }); });
        check((await adminPage.locator('[data-admin-events]').textContent()).includes('Visible event'), true, 'admin events render from independent tables');
        check(await adminPage.locator('[data-user-audit-id]').count(), 2, 'each user has Audit Log button');
        check(await adminPage.locator('#audit-log').count(), 0, 'separate audit section removed');
        await adminPage.click('[data-user-audit-id="member"]');
        await adminPage.waitForFunction(() => document.querySelector('[data-user-audit]').textContent.includes('Created event'));
        check(await adminPage.evaluate(() => window.__auditUser), 'member', 'audit query scoped to selected user');
        check((await adminPage.locator('[data-user-audit]').textContent()).includes('2026'), true, 'audit includes date and time');
        adminPage.on('dialog', dialog => dialog.accept());
        await adminPage.click('[data-audit-clear]');
        await adminPage.waitForFunction(() => document.querySelector('[data-audit-status]').textContent.includes('darbību nav'));
        check(await adminPage.evaluate(() => window.__clearedUser), 'member', 'clear targets selected user');
        await adminPage.click('[data-audit-close]');
        await adminPage.evaluate(async () => { window.__eventError = true; await setupAdminDashboard({ profile: { role: 'admin' } }); });
        check((await adminPage.locator('[data-admin-events]').textContent()).includes('Test database error'), true, 'admin query failures are visible');

        const reportPage = await browser.newPage({ viewport: { width: 1280, height: 900 } });
        await reportPage.setContent(read('report.html').replace(/<script[\s\S]*?<\/script>/g, '').replace(/<link[^>]+>/g, ''));
        await reportPage.addStyleTag({ path: path.join(root, 'style.css') }); await reportPage.addStyleTag({ path: path.join(root, 'events.css') });
        check(await reportPage.locator('.events-header').evaluate(element => getComputedStyle(element).textAlign), 'center', 'report header centered');
        check(await reportPage.locator('nav a[href="create-event.html"]').isVisible(), true, 'report navigation includes create event');
        console.log(`PASS: ${count} workflow database/browser checks`);
    } finally { if (browser) await browser.close(); await db.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
