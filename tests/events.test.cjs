// Run with playwright and @electric-sql/pglite available on NODE_PATH.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright');
const { PGlite } = require('@electric-sql/pglite');
const root = path.resolve(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');
const user = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const testId = '33333333-3333-4333-8333-333333333333';
const tomorrow = new Date(Date.now() + 172800000).toISOString().slice(0, 10);
let assertions = 0;
const check = (actual, expected, message) => { assert.deepEqual(actual, expected, message); assertions++; };

async function main() {
    const db = new PGlite();
    const schema = read('supabase-schema.sql');
    await db.exec(`
        create role anon; create role authenticated;
        create schema auth; create schema storage;
        create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('app.user', true), '')::uuid $$;
        create type public.event_status as enum ('pending', 'approved', 'rejected', 'archived');
        create table public.profiles (id uuid primary key, is_banned boolean not null default false);
        create function public.is_admin() returns boolean language sql stable as $$ select false $$;
        create table storage.objects (bucket_id text, name text unique, owner_id text);
        insert into public.profiles(id) values ('${user}'), ('${other}');
        select set_config('app.user', '${user}', false);
    `);
    for (const table of ['events', 'event_images']) {
        const sql = schema.match(new RegExp(`create table if not exists public\\.${table} \\([\\s\\S]*?\\n\\);`))[0];
        await db.exec(sql);
    }
    await db.exec(schema.slice(schema.indexOf('create or replace function public.enforce_future_event_date()'), schema.indexOf('create table if not exists public.event_images')));
    await db.exec(schema.slice(schema.indexOf('create or replace function public.enforce_event_image_limit()'), schema.indexOf('alter table public.profiles enable row level security')));
    await db.exec('alter table public.event_images enable row level security; alter table storage.objects enable row level security;');
    await db.exec(read('supabase-event-images.sql'));
    await db.exec(`grant usage on schema public, auth, storage to authenticated, anon;
        grant select on public.events, public.event_images, storage.objects to authenticated, anon;`);
    const payload = { title: 'Database event', category: 'Talka', event_date: tomorrow, location: 'Riga', latitude: 56.95,
        longitude: 24.1, description: 'A test event', volunteer_roles: 'Helper (2)', volunteer_role_requirements: [{ name: 'Helper', capacity: 2 }], whitelist_volunteers: true };
    const save = async (id, data, paths) => (await db.query('select public.save_event_with_images($1, $2::jsonb, $3::text[]) as id', [id, JSON.stringify(data), paths])).rows[0].id;
    const load = async (id) => {
        const event = (await db.query('select * from public.events where id = $1', [id])).rows[0];
        // PostgREST serializes SQL dates as YYYY-MM-DD, unlike PGlite's Date object.
        if (event?.event_date instanceof Date) event.event_date = event.event_date.toISOString().slice(0, 10);
        if (event) event.event_images = (await db.query('select storage_path, sort_order from public.event_images where event_id = $1 order by sort_order', [id])).rows;
        return event;
    };
    const paths = Array.from({ length: 6 }, (_, i) => `${user}/${testId}/${i}.jpg`);
    for (const p of paths) await db.query("insert into storage.objects values ('event-images', $1, $2)", [p, user]);
    await db.exec('set role authenticated');
    check(await save(testId, payload, paths.slice(0, 5)), testId, 'create event and five images');
    check((await load(testId)).event_images.length, 5, 'creator reads pending images');
    await save(testId, { ...payload, title: 'Edited event' }, [paths[5], ...paths.slice(1, 5)]);
    check((await load(testId)).event_images[0].storage_path, paths[5], 'replace image while already at five');
    await assert.rejects(save(testId, { ...payload, title: 'Must roll back' }, paths), /five/i); assertions++;
    await assert.rejects(save(testId, payload, [`${user}/missing.jpg`]), /Upload/); assertions++;
    await assert.rejects(save(testId, payload, [paths[0], paths[0]]), /different/); assertions++;
    await assert.rejects(save(testId, { ...payload, event_date: '2000-01-01' }, []), /past date/); assertions++;
    check((await load(testId)).title, 'Edited event', 'failed transaction preserves event fields');
    check((await load(testId)).event_images.length, 5, 'failed transaction preserves images');
    // Force failure after event fields and images have started changing.
    const secondId = '44444444-4444-4444-8444-444444444444';
    await save(secondId, payload, [paths[0]]);
    await assert.rejects(save(testId, { ...payload, title: 'Late failure' }, [paths[0]]), /unique/i); assertions++;
    check((await load(testId)).title, 'Edited event', 'late image failure rolls back event update');
    check((await load(testId)).event_images.length, 5, 'late image failure restores deleted image rows');
    await db.exec(`select set_config('app.user', '${other}', false)`);
    check((await load(testId)).event_images.length, 0, 'other users cannot read pending images');
    await assert.rejects(save(testId, payload, []), /creator/); assertions++;
    await assert.rejects(save('55555555-5555-4555-8555-555555555555', payload, [paths[1]]), /own storage/); assertions++;
    await db.exec(`select set_config('app.user', '${user}', false)`);
    await save(testId, payload, []);
    check((await load(testId)).event_images.length, 0, 'remove all images');
    await db.exec('reset role');
    await db.query('update public.profiles set is_banned = true where id = $1', [user]);
    await assert.rejects(save(testId, payload, []), /active account/); assertions++;
    await db.query('update public.profiles set is_banned = false where id = $1', [user]);
    await db.exec('set role anon');
    await assert.rejects(save(testId, payload, []), /permission/); assertions++;
    await db.exec('reset role');

    const files = new Map();
    const server = http.createServer(async (req, res) => {
        try {
            const url = new URL(req.url, 'http://localhost');
            const chunks = [];
            for await (const chunk of req) chunks.push(chunk);
            const body = Buffer.concat(chunks);
            if (url.pathname === '/__rpc') {
                const args = JSON.parse(body);
                try { res.end(JSON.stringify({ data: await save(args.target_event_id, args.event_data, args.image_paths), error: null })); }
                catch (error) { res.end(JSON.stringify({ data: null, error: { message: error.message, code: error.code } })); }
            } else if (url.pathname === '/__load') {
                res.end(JSON.stringify({ data: await load(url.searchParams.get('id')), error: null }));
            } else if (url.pathname === '/__upload') {
                const name = url.searchParams.get('path'); files.set(name, body);
                await db.query("insert into storage.objects values ('event-images', $1, $2)", [name, user]);
                res.end(JSON.stringify({ error: null }));
            } else if (url.pathname === '/__remove') {
                for (const name of JSON.parse(body)) { files.delete(name); await db.query('delete from storage.objects where name = $1', [name]); }
                res.end(JSON.stringify({ error: null }));
            } else if (url.pathname.startsWith('/__storage/')) {
                res.setHeader('Content-Type', 'image/jpeg'); res.end(files.get(decodeURIComponent(url.pathname.slice(11))));
            } else {
                const name = url.pathname.slice(1) || 'pasakumi.html';
                const file = path.resolve(root, name);
                if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
                let data = fs.readFileSync(file);
                const extension = path.extname(file);
                res.setHeader('Content-Type', ({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' })[extension] || 'application/octet-stream');
                if (extension === '.html') data = data.toString().replace(/<script[\s\S]*?<\/script>/g, '').replace(/<link[^>]*https:[^>]*>/g, '');
                res.end(data);
            }
        } catch (error) { res.writeHead(500).end(error.message); }
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    let browser;
    try {
        browser = await chromium.launch(process.env.BROWSER_PATH ? { executablePath: process.env.BROWSER_PATH } : process.platform === 'win32' ? { channel: 'msedge' } : {});
        const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
        const errors = [];
        page.on('pageerror', (error) => errors.push(error.message));
        await page.addInitScript(({ user }) => {
            window.__events = [];
            window.__uploads = 0;
            window.__rpcCalls = 0;
            const json = (url, body) => fetch(url, { method: 'POST', body: JSON.stringify(body) }).then(r => r.json());
            window.voluntioSupabase = {
                auth: { getUser: async () => ({ data: { user: { id: user } } }) },
                from(table) { return {
                    select() { return this; }, in() { return this; }, eq(key, value) { if (key === 'id') this.id = value; return this; },
                    order: async () => ({ data: window.__events, error: window.__listError || null }),
                    single() { return table === 'profiles' ? Promise.resolve({ data: { full_name: 'Tester' } }) : fetch('/__load?id=' + this.id).then(r => r.json()); }
                }; },
                rpc: async (name, args) => {
                    window.__rpcCalls++;
                    if (window.__failRpc) return { error: { code: 'P0001', message: 'Simulated database failure' } };
                    return json('/__rpc', args);
                },
                storage: { from() { return {
                    getPublicUrl: name => ({ data: { publicUrl: location.origin + '/__storage/' + name } }),
                    upload: async (name, blob) => {
                        window.__uploads++;
                        if (window.__failUpload === window.__uploads) return { error: { message: 'Simulated upload failure' } };
                        return fetch('/__upload?path=' + encodeURIComponent(name), { method: 'POST', body: blob }).then(r => r.json());
                    },
                    remove: names => json('/__remove', names)
                }; } }
            };
        }, { user });
        const boot = async (name) => {
            await page.goto(base + '/' + name);
            await page.addScriptTag({ path: path.join(root, 'site.js') });
            await page.addScriptTag({ path: path.join(root, 'event-images.js') });
        };
        const visible = () => page.locator('.event-card:visible').count();
        await boot('pasakumi.html');
        await page.evaluate(async () => { setupEventFilters(); await renderCustomEvents(); });
        check(await visible(), 3, 'three local examples when empty');
        check(await page.locator('.local-test-label').count(), 3, 'all examples labeled LOCAL TEST');
        check(await page.locator('.event-card a').count(), 0, 'examples have no fake application links');
        check(await page.locator('[data-show-more]').isVisible(), false, 'no more button with three results');
        check(await page.locator('.events-grid').evaluate(grid => getComputedStyle(grid).gridTemplateColumns.split(' ').length), 3, 'three desktop columns');
        check(await page.locator('.event-image').first().evaluate(image => {
            const bounds = image.getBoundingClientRect();
            return Math.abs(bounds.width / bounds.height - 1.5) < 0.01 && getComputedStyle(image).objectFit === 'cover';
        }), true, 'listing pictures retain 3:2 aspect without stretching');
        await page.selectOption('#categoryFilter', 'talka'); check(await visible(), 1, 'filter examples');
        await page.fill('#searchInput', 'missing'); check(await visible(), 0, 'no fallback on zero search matches');
        check(await page.locator('.no-results').isVisible(), true, 'no-results message');
        await page.fill('#searchInput', ''); await page.selectOption('#categoryFilter', '');
        await page.evaluate(async () => {
            window.__events = Array.from({ length: 8 }, (_, i) => ({ id: String(i), title: `Event ${i}`, category: i < 4 ? 'Talka' : 'Cits', description: 'Testing', location: 'Rīga', status: 'approved', event_date: '2030-01-01' }));
            await renderCustomEvents();
        });
        check(await visible(), 3, 'three actual events initially');
        await page.click('[data-show-more]'); check(await visible(), 6, 'show three more');
        await page.click('[data-show-more]'); check(await visible(), 8, 'last partial page');
        check(await page.locator('[data-show-more]').isVisible(), false, 'hide more at end');
        await page.selectOption('#categoryFilter', 'cits'); check(await visible(), 3, 'category resets pagination');
        await page.click('[data-show-more]'); check(await visible(), 4, 'more respects category');
        await page.fill('#searchInput', '  RIGA  '); check(await visible(), 3, 'normalized search resets pagination');
        await page.fill('#searchInput', 'Event 7'); check(await visible(), 1, 'search finds events beyond initial page');
        await page.setViewportSize({ width: 390, height: 844 });
        check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'mobile listing has no overflow');
        await page.setViewportSize({ width: 1280, height: 900 });
        await boot('pasakumi.html');
        await page.evaluate(async () => { window.__listError = { message: 'Offline' }; setupEventFilters(); await renderCustomEvents(); });
        check(await visible(), 0, 'database error does not pretend database is empty');
        check((await page.locator('[data-events-status]').textContent()).includes('Offline'), true, 'database error shown');

        await boot('create-event.html');
        await page.evaluate(() => setupEventForm());
        check(await page.evaluate(() => document.querySelector('#date').value === eventToday()), true, 'date defaults to today in Latvia');
        await page.fill('#date', '2000-01-01');
        check(await page.locator('#date').evaluate(field => field.checkValidity()), false, 'past date rejected by browser');
        await page.fill('#date', tomorrow);
        const png = await page.evaluate(() => {
            const canvas = document.createElement('canvas'); canvas.width = 1800; canvas.height = 600;
            const ctx = canvas.getContext('2d'); ['red', 'lime', 'blue'].forEach((color, i) => { ctx.fillStyle = color; ctx.fillRect(i * 600, 0, 600, 600); });
            return canvas.toDataURL('image/png').split(',')[1];
        });
        const imageFile = { name: 'wide.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') };
        await page.locator('[data-image-input]').setInputFiles({ name: 'invalid.txt', mimeType: 'text/plain', buffer: Buffer.from('not an image') });
        check(await page.locator('.image-preview-item').count(), 0, 'invalid file does not create a preview');
        await page.locator('[data-image-input]').setInputFiles(Array(6).fill(imageFile));
        check(await page.locator('.image-preview-item').count(), 0, 'six-image selection is rejected');
        await page.locator('[data-image-input]').setInputFiles([imageFile]);
        await page.waitForFunction(() => document.querySelectorAll('[data-crop-image]').length === 1 && !document.querySelector('[data-crop-image]').disabled);
        const initialPreview = await page.locator('.image-preview-item img').getAttribute('src');
        await page.click('[data-crop-image]');
        check(await page.locator('button[type="submit"]').isDisabled(), true, 'cannot submit while crop dialog is open');
        await page.locator('[data-crop-x]').fill('100');
        await page.locator('[data-crop-zoom]').fill('2');
        await page.click('[data-crop-apply]');
        const croppedPreview = await page.locator('.image-preview-item img').getAttribute('src');
        check(croppedPreview !== initialPreview, true, 'crop changes actual image bytes');
        check(await page.evaluate(async () => {
            const image = document.querySelector('.image-preview-item img'); await image.decode();
            const canvas = document.createElement('canvas'); canvas.width = 900; canvas.height = 600;
            const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0);
            const pixel = ctx.getImageData(450, 300, 1, 1).data;
            return image.naturalWidth === 900 && image.naturalHeight === 600 && pixel[2] > 240 && pixel[0] < 15;
        }), true, 'crop preserves aspect and chosen blue region');
        await page.click('[data-crop-image]'); await page.locator('[data-crop-x]').fill('0'); await page.click('[data-crop-cancel]');
        check(await page.locator('.image-preview-item img').getAttribute('src'), croppedPreview, 'cancel preserves last crop');
        await page.waitForFunction(() => !document.querySelector('[data-image-input]').disabled);
        await page.locator('[data-image-input]').setInputFiles([imageFile]);
        await page.waitForFunction(() => document.querySelectorAll('[data-crop-image]').length === 2 && !document.querySelector('[data-crop-image]').disabled);
        await page.fill('#title', 'Browser create'); await page.fill('#date', tomorrow); await page.fill('#location', 'Riga');
        await page.fill('[name="role-name"]', 'Helper'); await page.fill('#description', 'Browser description');
        await page.evaluate(() => { const f = document.querySelector('[data-event-form]'); f.elements.latitude.value = '56.95'; f.elements.longitude.value = '24.1'; });
        await page.evaluate(() => { window.__failUpload = 2; });
        await page.click('button[type="submit"]');
        await page.waitForFunction(() => document.querySelector('[data-form-message]').textContent.includes('Simulated upload failure'));
        check(files.size, 0, 'partial upload failure cleans previous upload');
        check(await page.evaluate(() => window.__rpcCalls), 0, 'upload failure never commits event');
        await page.evaluate(() => { window.__failUpload = 0; window.__failRpc = true; });
        await page.click('button[type="submit"]');
        await page.waitForFunction(() => document.querySelector('[data-form-message]').textContent.includes('Simulated database failure'));
        check(files.size, 0, 'database rejection cleans new uploads');
        await page.evaluate(() => { window.__failRpc = false; });
        await page.click('button[type="submit"]');
        await page.waitForURL('**/event.html?id=*');
        const savedId = new URL(page.url()).searchParams.get('id');
        let saved = await load(savedId);
        check(saved.title, 'Browser create', 'form creates database event');
        check(saved.event_images.length, 2, 'form saves two image references');
        check(files.get(saved.event_images[0].storage_path).equals(Buffer.from(croppedPreview.split(',')[1], 'base64')), true, 'database references exact cropped JPEG');
        const oldPaths = saved.event_images.map(image => image.storage_path);

        await boot('create-event.html?edit=' + savedId);
        await page.evaluate(() => setupEventForm());
        await page.waitForFunction(() => document.querySelectorAll('[data-crop-image]').length === 2 && !document.querySelector('button[type="submit"]').disabled);
        check(await page.inputValue('#title'), 'Browser create', 'edit reloads saved fields');
        check(await page.locator('.image-preview-item img').count(), 2, 'edit reloads saved images');
        await page.click('[data-crop-image="0"]'); await page.locator('[data-crop-zoom]').fill('2'); await page.click('[data-crop-apply]');
        await page.click('[data-remove-image="1"]');
        await page.locator('[data-image-input]').setInputFiles([imageFile]);
        await page.waitForFunction(() => document.querySelectorAll('[data-crop-image]').length === 2 && !document.querySelector('[data-crop-image]').disabled);
        await page.fill('#title', 'Browser edited');
        check(await page.locator('[data-event-form]').evaluate(form => [...form.elements].filter(field => field.willValidate && !field.validity.valid).map(field => ({ name: field.name, value: field.value, message: field.validationMessage }))), [], 'edit form loaded valid saved values');
        await page.click('button[type="submit"]'); await page.waitForURL('**/event.html?id=*');
        check(new URL(page.url()).searchParams.get('id'), savedId, 'editing preserves event ID');
        saved = await load(savedId);
        check(saved.title, 'Browser edited', 'edited fields persist');
        check(saved.event_images.length, 2, 'edit saves new upload alongside recropped image');
        check(saved.event_images.some(image => image.storage_path === oldPaths[1]), false, 'removed image stays removed');
        check(saved.event_images[0].storage_path !== oldPaths[0], true, 'recrop uses new uncached storage path');
        check(oldPaths.every(name => !files.has(name)), true, 'old files removed only after commit');

        await boot('create-event.html?edit=' + savedId);
        await page.evaluate(() => setupEventForm());
        await page.waitForFunction(() => document.querySelectorAll('[data-crop-image]').length === 2 && !document.querySelector('button[type="submit"]').disabled);
        const keptPath = (await load(savedId)).event_images[0].storage_path;
        await page.fill('#description', 'Text only edit');
        await page.click('button[type="submit"]'); await page.waitForURL('**/event.html?id=*');
        check((await load(savedId)).event_images[0].storage_path, keptPath, 'text-only edit keeps existing image');
        check(errors, [], 'no uncaught browser errors');
        console.log(`PASS: ${assertions} database and browser checks`);
    } finally {
        if (browser) await browser.close();
        await new Promise(resolve => server.close(resolve));
        await db.close();
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
