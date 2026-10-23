const supabaseClient = window.voluntioSupabase;

function eventToday() {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Riga', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
    const part = (type) => parts.find((item) => item.type === type).value;
    return `${part('year')}-${part('month')}-${part('day')}`;
}

function eventNowInRiga() {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Riga', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date());
    return `${parts.find((item) => item.type === 'hour').value}:${parts.find((item) => item.type === 'minute').value}`;
}

function eventIsFinished(event) {
    if (event?.event_started_at) {
        return Date.now() >= new Date(event.event_started_at).getTime() + Number(event.volunteer_hours || 0) * 60 * 60 * 1000;
    }
    const today = eventToday();
    return event?.event_date < today || (event?.event_date === today && String(event.event_end_time || '23:59').slice(0, 5) <= eventNowInRiga());
}

function eventDateLimit(today = eventToday()) {
    const date = new Date(`${today}T12:00:00Z`);
    const month = date.getUTCMonth();
    date.setUTCFullYear(date.getUTCFullYear() + 10);
    if (date.getUTCMonth() !== month) date.setUTCDate(0);
    return date.toISOString().slice(0, 10);
}

function validEventDate(value, today = eventToday()) {
    return /^\d{4}-\d{2}-\d{2}$/.test(value) && value >= today && value <= eventDateLimit(today);
}

function applicationStatusMessage(status) {
    return status === 'approved' ? 'Tu jau esi pievienojies šim pasākumam. Tavs pieteikums ir apstiprināts.'
        : status === 'rejected' ? 'Tavs iepriekšējais pieteikums ir noraidīts vai dalība pārtraukta. Sazinies ar organizatoru.'
        : 'Tu jau esi pieteicies šim pasākumam un gaidi organizatora atbildi.';
}

function applicationStatusLabel(status) {
    return ({ pending: 'Gaida atbildi', approved: 'Apstiprināts', rejected: 'Noraidīts' })[status] || status;
}

async function submitEventApplication(eventId, userId, role, message) {
    const existing = () => supabaseClient.from('event_applications').select('status').eq('event_id', eventId).eq('volunteer_id', userId).maybeSingle();
    const before = await existing();
    if (before.error) throw before.error;
    if (before.data) return before.data.status;
    const { error } = await supabaseClient.from('event_applications').insert({ event_id: eventId, volunteer_id: userId, requested_role: role, message });
    if (error?.code === '23505') {
        const after = await existing();
        return after.data?.status || 'pending';
    }
    if (error) throw error;
    return 'pending';
}

async function sendApplicationFromForm(form, eventId, userId) {
    if (form.dataset.submitting === 'true') return;
    form.dataset.submitting = 'true';
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    try {
        const status = await submitEventApplication(eventId, userId, form.elements.requestedRole.value, form.elements.message.value.trim());
        showFormMessage(applicationStatusMessage(status));
    } catch (error) {
        showFormMessage(`Pieteikumu neizdevās nosūtīt: ${error.message}`, true);
        button.disabled = false;
    } finally { form.dataset.submitting = 'false'; }
}

async function getCurrentUser() {
    const { data: { user } } = await supabaseClient.auth.getUser();
    if (!user) {
        return null;
    }

    let { data: profile, error: profileError } = await supabaseClient
        .from('profiles')
        .select('id, full_name, role, is_banned, banned_until, avatar_path')
        .eq('id', user.id)
        .single();

    // Keep existing deployments usable until the avatar migration is applied.
    if (profileError) {
        const fallback = await supabaseClient
            .from('profiles')
            .select('id, full_name, role, is_banned, banned_until')
            .eq('id', user.id)
            .single();
        if (fallback.error) return { ...user, profile: null };
        profile = fallback.data;
    }

    if (isBanActive(profile)) {
        sessionStorage.setItem('voluntio-ban-notice', JSON.stringify({ bannedUntil: profile.banned_until || null }));
        await supabaseClient.auth.signOut();
        return null;
    }

    return { ...user, profile };
}

function isBanActive(profile) {
    if (!profile?.is_banned) return false;
    if (!profile.banned_until || profile.banned_until === 'infinity') return true;
    const expiry = new Date(profile.banned_until).getTime();
    return Number.isNaN(expiry) || expiry > Date.now();
}

function showStoredBanNotice() {
    const rawNotice = sessionStorage.getItem('voluntio-ban-notice');
    if (!rawNotice) return;
    sessionStorage.removeItem('voluntio-ban-notice');
    let notice;
    try { notice = JSON.parse(rawNotice); } catch { return; }
    const dialog = document.createElement('dialog');
    dialog.className = 'account-blocked-dialog';
    const until = !notice.bannedUntil || notice.bannedUntil === 'infinity'
        ? 'Bloķēšanas termiņš nav noteikts.'
        : `Bloķēšana beigsies ${new Date(notice.bannedUntil).toLocaleString('lv-LV', { timeZone: 'Europe/Riga' })}.`;
    dialog.innerHTML = `<h2>Piekļuve vietnei bloķēta</h2><p>Tavam kontam pašlaik nav atļauts piekļūt Voluntio vietnei.</p><p>${until}</p><button type="button" class="auth-submit" data-blocked-close>Aizvērt</button>`;
    document.body.append(dialog);
    dialog.showModal();
    dialog.querySelector('[data-blocked-close]').addEventListener('click', () => dialog.close());
    dialog.addEventListener('close', () => dialog.remove(), { once: true });
}

function initialsForName(name) {
    return String(name || 'Voluntio').split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join('').toUpperCase() || 'V';
}

function profileAvatarUrl(profile) {
    if (!profile?.avatar_path) return '';
    return supabaseClient.storage.from('profile-avatars').getPublicUrl(profile.avatar_path).data.publicUrl;
}

function profileAvatarMarkup(profile, className = 'person-avatar', label = '') {
    const name = profile?.full_name || label || 'Voluntio lietotājs';
    const imageUrl = profileAvatarUrl(profile);
    return `<span class="${className}" aria-label="${escapeHtml(name)}"><span class="person-avatar-initials" aria-hidden="true">${escapeHtml(initialsForName(name))}</span>${imageUrl ? `<img class="person-avatar-image" src="${escapeHtml(imageUrl)}" alt="" onerror="this.hidden=true">` : ''}</span>`;
}

function showFormMessage(message, isError = false) {
    const messageElement = document.querySelector('[data-form-message]');
    if (!messageElement) {
        window.alert(message);
        return;
    }
    messageElement.textContent = message;
    messageElement.classList.toggle('form-error', isError);
}

async function guardPage(currentUser) {
    const requiresAuth = document.body.dataset.authRequired === 'true';
    const requiresAdmin = document.body.dataset.roleRequired === 'admin';

    if (requiresAuth && !currentUser) {
        window.location.href = 'login.html';
        return false;
    }

    if (requiresAdmin && (!currentUser || currentUser.profile?.role !== 'admin')) {
        window.location.href = 'index.html';
        return false;
    }

    return true;
}

function updateAuthLinks(currentUser) {
    const authButtons = document.querySelector('.auth-buttons');
    const navbar = authButtons?.closest('.navbar');
    const isAdmin = currentUser?.profile?.role === 'admin';
    const guestOnlyCta = document.querySelector('[data-guest-only-cta]');
    if (guestOnlyCta) guestOnlyCta.hidden = Boolean(currentUser);
    document.querySelectorAll('.hero-text-link').forEach((link) => { link.hidden = Boolean(currentUser); });

    document.querySelectorAll('a[href="admin.html"]').forEach((link) => {
        link.closest('li')?.classList.toggle('hidden-nav-item', !isAdmin);
    });

    navbar?.classList.toggle('has-auth-user', Boolean(currentUser));
    navbar?.querySelector('[data-notification-nav]')?.notificationCleanup?.();

    if (!authButtons || !currentUser) {
        setupNotifications(null);
        return;
    }

    const displayName = currentUser.profile?.full_name || currentUser.email.split('@')[0];
    authButtons.innerHTML = `
        <a class="user-profile" href="profile.html" aria-label="Atvērt profilu">${profileAvatarMarkup(currentUser.profile, 'user-avatar', displayName)}<span class="user-greeting">Sveiks, ${escapeHtml(displayName)}</span></a>
        ${isAdmin ? '<a class="btn-login admin-shortcut" href="admin.html" aria-label="Atvērt admin paneli" title="Admin panelis">🔧</a>' : ''}
        <button class="btn-login logout-button" type="button">Iziet</button>
    `;

    authButtons.querySelector('.logout-button').addEventListener('click', async () => {
        await supabaseClient.auth.signOut();
        window.location.href = 'index.html';
    });
    setupNotifications(currentUser);
}

async function setupHomeSummary() {
    const countElement = document.querySelector('[data-home-week-count]');
    if (!countElement) return;
    const memberElement = document.querySelector('[data-home-member-count]');
    const { data, error } = await supabaseClient.rpc('community_stats');
    const stats = data?.[0];
    countElement.textContent = error ? '—' : String(stats?.upcoming_events || 0);
    if (memberElement) memberElement.textContent = error ? '—' : String(stats?.members || 0);
}

function createAvatarPreview(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            const image = new Image();
            image.onload = () => {
                const canvas = document.createElement('canvas');
                canvas.width = 512;
                canvas.height = 512;
                const context = canvas.getContext('2d');
                const scale = Math.max(canvas.width / image.width, canvas.height / image.height);
                const width = image.width * scale;
                const height = image.height * scale;
                context.drawImage(image, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height);
                resolve(canvas.toDataURL('image/jpeg', 0.86));
            };
            image.onerror = reject;
            image.src = reader.result;
        };
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
}

function setupEventForm() {
    const form = document.querySelector('[data-event-form]');
    const input = document.querySelector('[data-image-input]');
    const preview = document.querySelector('[data-image-preview]');
    const editId = new URLSearchParams(window.location.search).get('edit');

    if (!form || !input || !preview) {
        return;
    }

    const eventId = editId || crypto.randomUUID();
    const submit = form.querySelector('button[type="submit"]');
    let loading = Boolean(editId);
    let saving = false;
    let originalPaths = [];
    const updateSubmit = () => { submit.disabled = loading || saving || imageEditor.isBusy(); };
    const imageEditor = createEventImageEditor(input, preview, updateSubmit);
    imageEditor.setLocked(loading);
    updateSubmit();

    const dateField = form.elements.date;
    const localToday = eventToday();
    dateField.min = localToday;
    dateField.max = eventDateLimit(localToday);
    if (!editId) {
        dateField.value = localToday;
        dateField.classList.add('date-suggested');
    }
    dateField.addEventListener('input', () => {
        dateField.classList.remove('date-suggested');
        dateField.min = eventToday();
        dateField.max = eventDateLimit(dateField.min);
        dateField.setCustomValidity(dateField.value && !validEventDate(dateField.value, dateField.min) ? 'Izvēlies datumu no šodienas līdz 10 gadiem nākotnē.' : '');
    });

    const roleBuilder = form.querySelector('[data-role-builder]');
    const rolesField = form.elements.roles;

    const syncRoles = () => {
        rolesField.value = [...roleBuilder.querySelectorAll('.role-row')].map((row) => {
            const name = row.querySelector('[name="role-name"]').value.trim();
            const count = Math.max(0, Number(row.querySelector('[name="role-count"]').value) || 0);
            return name ? `${name} (${count})` : '';
        }).filter(Boolean).join(', ');
    };
    const collectRoles = () => [...roleBuilder.querySelectorAll('.role-row')].map((row) => ({
        name: row.querySelector('[name="role-name"]').value.trim(),
        capacity: Number(row.querySelector('[name="role-count"]').value)
    }));
    if (editId) {
        supabaseClient.from('events').select('title, category, event_date, event_start_time, event_end_time, location, latitude, longitude, volunteer_roles, volunteer_role_requirements, volunteer_hours, description, whitelist_volunteers, event_images(storage_path, original_storage_path, sort_order)').eq('id', editId).single().then(({ data, error }) => {
            if (error || !data) throw error || new Error('Pasākums nav atrasts.');
            form.elements.title.value = data.title;
            form.elements.category.value = data.category;
            form.elements.date.value = data.event_date;
            form.elements.startTime.value = String(data.event_start_time || '09:00').slice(0, 5);
            form.elements.endTime.value = String(data.event_end_time || '10:00').slice(0, 5);
            form.elements.location.value = data.location;
            form.elements.latitude.value = data.latitude ?? '';
            form.elements.longitude.value = data.longitude ?? '';
            form.elements.description.value = data.description;
            form.elements.whitelist.checked = data.whitelist_volunteers;
            const roles = Array.isArray(data.volunteer_role_requirements) && data.volunteer_role_requirements.length
                ? data.volunteer_role_requirements
                : parseLegacyRoles(data.volunteer_roles);
            if (roles.length) {
                roleBuilder.innerHTML = roles.map((role, index) => `<div class="role-row"><input name="role-name" type="text" placeholder="Piemēram, talcinieks" aria-label="Brīvprātīgā loma" value="${escapeHtml(role.name)}" required><input name="role-count" type="number" min="1" max="999" value="${Number(role.capacity) || 1}" aria-label="Nepieciešamais skaits" required><button class="table-button table-button-danger" type="button" data-remove-role ${roles.length === 1 ? 'disabled' : ''}>Noņemt</button></div>`).join('');
                syncRoles();
            }
            const button = form.querySelector('button[type="submit"]');
            if (button) button.textContent = 'Saglabāt izmaiņas';
            imageEditor.load(data.event_images || []);
            originalPaths = (data.event_images || []).flatMap((image) => [image.storage_path, image.original_storage_path || image.storage_path]);
            form.dispatchEvent(new Event('voluntio:event-loaded'));
            loading = false;
            imageEditor.setLocked(false);
            updateSubmit();
        }).catch((error) => showFormMessage(`Pasākumu neizdevās ielādēt: ${error.message}. Pārlādē lapu.`, true));
    }
    roleBuilder.addEventListener('input', syncRoles);
    roleBuilder.addEventListener('click', (event) => {
        const remove = event.target.closest('[data-remove-role]');
        if (!remove) return;
        remove.closest('.role-row').remove();
        roleBuilder.querySelectorAll('[data-remove-role]').forEach((button) => { button.disabled = roleBuilder.children.length === 1; });
        syncRoles();
    });
    form.querySelector('[data-add-role]').addEventListener('click', () => {
        const row = roleBuilder.querySelector('.role-row').cloneNode(true);
        row.querySelector('[name="role-name"]').value = '';
        row.querySelector('[name="role-count"]').value = '1';
        row.querySelector('[data-remove-role]').disabled = false;
        roleBuilder.append(row);
        roleBuilder.querySelectorAll('[data-remove-role]').forEach((button) => { button.disabled = false; });
        row.querySelector('[name="role-name"]').focus();
    });

    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        if (loading || saving || imageEditor.isBusy()) return;
        saving = true;
        imageEditor.setLocked(true);
        updateSubmit();
        try {
            const currentUser = await getCurrentUser();
            if (!currentUser) {
                window.location.href = 'login.html';
                return;
            }
            const title = form.elements.title.value.trim();
            const roleRequirements = collectRoles();
            if (title.length < 3 || title.length > 120) {
                showFormMessage('Pasākuma nosaukumam jābūt 3–120 rakstzīmes garam.', true);
                form.elements.title.focus();
                return;
            }
            dateField.min = eventToday();
            dateField.max = eventDateLimit(dateField.min);
            if (!validEventDate(dateField.value, dateField.min)) {
                showFormMessage('Pasākuma datumam jābūt no šodienas līdz 10 gadiem nākotnē.', true);
                dateField.focus();
                return;
            }
            const latitude = Number(form.elements.latitude.value);
            const longitude = Number(form.elements.longitude.value);
            const location = form.elements.location.value.trim();
            const description = form.elements.description.value.trim();
            const startTime = form.elements.startTime.value;
            const endTime = form.elements.endTime.value;
            const timeToMinutes = (value) => {
                const [hours, minutes] = value.split(':').map(Number);
                return hours * 60 + minutes;
            };
            const durationMinutes = timeToMinutes(endTime) - timeToMinutes(startTime);
            if (!form.elements.latitude.value.trim() || !form.elements.longitude.value.trim() ||
                !Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
                showFormMessage('Izvēlies vietu no kartes vai meklēšanas rezultātiem, lai saglabātu pasākumu.', true);
                document.querySelector('[data-location-map]')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
                return;
            }
            if (!location || !description) {
                showFormMessage('Aizpildi pasākuma vietu un aprakstu, lai turpinātu.', true);
                return;
            }
            if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(startTime) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(endTime) || durationMinutes <= 0) {
                showFormMessage('Norādi sākuma un beigu laiku no 00:00 līdz 23:00. Beigu laikam jābūt vēlākam par sākuma laiku.', true);
                form.elements.startTime.focus();
                return;
            }
            if (!roleRequirements.length || roleRequirements.some((role) => !role.name || !Number.isInteger(role.capacity) || role.capacity < 1)) {
                showFormMessage('Pievieno vismaz vienu lomu un norādi vajadzīgo cilvēku skaitu.', true);
                roleBuilder.querySelector('[name="role-name"]')?.focus();
                return;
            }

            syncRoles();
            const eventPayload = {
                title,
                category: form.elements.category.value,
                event_date: form.elements.date.value,
                event_start_time: startTime,
                event_end_time: endTime,
                location,
                latitude,
                longitude,
                volunteer_roles: form.elements.roles.value.trim(),
                volunteer_role_requirements: roleRequirements,
                description,
                whitelist_volunteers: form.elements.whitelist.checked,
                volunteer_hours: Number((durationMinutes / 60).toFixed(2)),
                status: 'pending'
            };
            showFormMessage('Saglabā pasākumu un attēlus...');
            const savedId = await saveEventWithImages(supabaseClient, currentUser.id, eventId, eventPayload, imageEditor.getImages(), originalPaths);
            showFormMessage(editId ? 'Pasākums un attēli atjaunināti.' : 'Pasākums un attēli saglabāti un nosūtīti apstiprināšanai.');
            window.location.href = `event.html?id=${encodeURIComponent(savedId)}`;
        } catch (error) {
            showFormMessage(`Neizdevās saglabāt pasākumu: ${error.message}`, true);
        } finally {
            saving = false;
            imageEditor.setLocked(false);
            updateSubmit();
        }
    });
}

function setupLocationPicker() {
    const input = document.querySelector('[data-location-search]');
    const mapElement = document.querySelector('[data-location-map]');
    const results = document.querySelector('[data-location-results]');
    if (!input || !mapElement || !results) return;
    if (!window.L) {
        mapElement.innerHTML = '<p class="map-unavailable">Karti neizdevās ielādēt. Pārlādē lapu un mēģini vēlreiz.</p>';
        return;
    }

    const tileUrl = window.VOLUNTIO_MAP_TILE_URL || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
    const tileOptions = {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors',
        maxZoom: 19,
        referrerPolicy: 'strict-origin-when-cross-origin'
    };
    let map;
    try {
        map = window.L.map(mapElement, { scrollWheelZoom: true }).setView([56.9496, 24.1052], 7);
        const tiles = window.L.tileLayer(tileUrl, tileOptions).addTo(map);
        let tileFailureShown = false;
        tiles.on('tileerror', () => {
            if (tileFailureShown) return;
            tileFailureShown = true;
            results.innerHTML = '<p>Kartes flīzes pašlaik nav pieejamas. Vari turpināt, meklējot vietu vai atzīmējot punktu kartē vēlāk.</p>';
        });
        // The map sits in a CSS grid. Wait for that grid to be painted before
        // measuring it, otherwise Leaflet can initialise with a 0px pane.
        window.requestAnimationFrame(() => map.invalidateSize());
        window.setTimeout(() => map.invalidateSize(), 180);
        if (window.ResizeObserver) new ResizeObserver(() => map.invalidateSize({ animate: false })).observe(mapElement);
    } catch {
        mapElement.innerHTML = '<p class="map-unavailable">Karti neizdevās ielādēt. Pārlādē lapu un mēģini vēlreiz.</p>';
        return;
    }
    let marker;
    let timer;
    const selectPlace = (place) => {
        const latitude = Number(place.lat);
        const longitude = Number(place.lon);
        input.value = place.display_name;
        input.form.elements.latitude.value = latitude;
        input.form.elements.longitude.value = longitude;
        if (marker) marker.remove();
        marker = window.L.marker([latitude, longitude]).addTo(map);
        map.setView([latitude, longitude], 15);
        results.innerHTML = `<p class="location-selected">Izvēlēta vieta: <strong>${escapeHtml(place.display_name)}</strong></p>`;
    };
    const restorePlace = () => {
        if (input.form.elements.latitude.value && input.form.elements.longitude.value) {
            selectPlace({ lat: input.form.elements.latitude.value, lon: input.form.elements.longitude.value, display_name: input.value });
        }
    };
    input.form.addEventListener('voluntio:event-loaded', restorePlace);
    restorePlace();
    const search = async () => {
        const query = input.value.trim();
        if (query.length < 3) return;
        results.innerHTML = '<p>Meklē vietas...</p>';
        try {
            const response = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&countrycodes=lv&q=${encodeURIComponent(query)}`);
            const places = await response.json();
            results.innerHTML = places.length ? places.map((place, index) => `<button type="button" class="location-result" data-location-result="${index}">${escapeHtml(place.display_name)}</button>`).join('') : '<p>Vietas netika atrastas. Precizē meklējumu vai ievadi adresi manuāli.</p>';
            results.querySelectorAll('[data-location-result]').forEach((button) => button.addEventListener('click', () => selectPlace(places[Number(button.dataset.locationResult)])));
        } catch {
            results.innerHTML = '<p>Vietu meklēšana pašlaik nav pieejama. Vari ievadīt adresi manuāli.</p>';
        }
    };
    input.addEventListener('input', () => { window.clearTimeout(timer); timer = window.setTimeout(search, 350); });
    map.on('click', async ({ latlng }) => {
        input.form.elements.latitude.value = latlng.lat;
        input.form.elements.longitude.value = latlng.lng;
        if (marker) marker.remove();
        marker = window.L.marker(latlng).addTo(map);
        try {
            const response = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${latlng.lat}&lon=${latlng.lng}`);
            const place = await response.json();
            input.value = place.display_name || `${latlng.lat.toFixed(5)}, ${latlng.lng.toFixed(5)}`;
        } catch { input.value = `${latlng.lat.toFixed(5)}, ${latlng.lng.toFixed(5)}`; }
        results.innerHTML = '<p class="location-selected">Vieta izvēlēta kartē.</p>';
    });
}

function setupEventMap(event) {
    const mapElement = document.querySelector('[data-event-map]');
    const address = document.querySelector('[data-event-map-address]');
    if (!mapElement) return;
    if (address) address.textContent = event.location;
    const latitude = Number(event.latitude);
    const longitude = Number(event.longitude);
    if (event.latitude === null || event.longitude === null || !Number.isFinite(latitude) || !Number.isFinite(longitude)) {
        mapElement.innerHTML = '<p class="map-unavailable">Precīza kartes atzīme šim agrāk izveidotajam pasākumam vēl nav pievienota.</p>';
        return;
    }
    if (!window.L) {
        mapElement.innerHTML = '<p class="map-unavailable">Karti neizdevās ielādēt. Pārlādē lapu un mēģini vēlreiz.</p>';
        return;
    }
    try {
        const map = window.L.map(mapElement, { scrollWheelZoom: true }).setView([latitude, longitude], 15);
        const tileUrl = window.VOLUNTIO_MAP_TILE_URL || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
        const tiles = window.L.tileLayer(tileUrl, {
            attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors',
            maxZoom: 19,
            referrerPolicy: 'strict-origin-when-cross-origin'
        }).addTo(map);
        tiles.once('tileerror', () => {
            mapElement.insertAdjacentHTML('beforeend', '<p class="map-unavailable">Kartes flīzes pašlaik nav pieejamas.</p>');
        });
        window.L.marker([latitude, longitude]).addTo(map).bindPopup(escapeHtml(event.location)).openPopup();
        window.requestAnimationFrame(() => map.invalidateSize());
        window.setTimeout(() => map.invalidateSize(), 180);
        if (window.ResizeObserver) new ResizeObserver(() => map.invalidateSize({ animate: false })).observe(mapElement);
    } catch {
        mapElement.innerHTML = '<p class="map-unavailable">Karti neizdevās ielādēt. Pārlādē lapu un mēģini vēlreiz.</p>';
    }
}

async function setupApplicationForm() {
    const form = document.querySelector('[data-application-form]');
    const select = document.querySelector('[data-event-select]');

    if (!form || !select) {
        return;
    }

    const { data: events, error } = await supabaseClient
        .from('events')
        .select('id, title, event_date, creator_id, volunteer_role_requirements, volunteer_roles')
        .eq('status', 'approved')
        .gte('event_date', eventToday())
        .order('event_date', { ascending: true });

    if (error) {
        showFormMessage(error.message, true);
        return;
    }

    select.innerHTML = events.length
        ? events.map((event) => `<option value="${event.id}">${escapeHtml(event.title)} - ${escapeHtml(event.event_date)}</option>`).join('')
        : '<option value="">Nav pieejamu pasākumu</option>';
    const requestedEvent = new URLSearchParams(window.location.search).get('event');
    if (requestedEvent && events.some((event) => event.id === requestedEvent)) {
        select.value = requestedEvent;
        select.disabled = true;
    }
    const currentUser = await getCurrentUser();
    if (currentUser) {
        form.elements.name.value = currentUser.profile?.full_name || '';
        form.elements.email.value = currentUser.email || '';
    }
    const roleSelect = form.elements.requestedRole;
    const updateRoleOptions = async () => {
        const selectedEvent = events.find((event) => event.id === select.value);
        const { data: availability } = selectedEvent
            ? await supabaseClient.rpc('event_role_availability', { target_event_id: selectedEvent.id })
            : { data: [] };
        if (selectedEvent && select.value !== selectedEvent.id) return;
        const roles = (availability || (selectedEvent ? eventRoles(selectedEvent) : [])).map((role) => ({
            name: role.role_name || role.name,
            capacity: Number(role.capacity),
            filled: Number(role.filled || 0)
        })).filter((role) => role.filled < role.capacity);
        roleSelect.innerHTML = roles.length
            ? `<option value="">Izvēlies lomu</option>${roles.map((role) => `<option value="${escapeHtml(role.name)}">${escapeHtml(role.name)} (${role.filled}/${role.capacity})</option>`).join('')}`
            : '<option value="">Šim pasākumam nav pieejamu lomu</option>';
        roleSelect.disabled = !roles.length;
        const button = form.querySelector('button[type="submit"]');
        button.disabled = !roles.length;
        if (currentUser && selectedEvent) {
            const { data } = await supabaseClient.from('event_applications').select('status').eq('event_id', selectedEvent.id).eq('volunteer_id', currentUser.id).maybeSingle();
            if (select.value !== selectedEvent.id) return;
            showFormMessage(data ? applicationStatusMessage(data.status) : '');
            button.disabled = Boolean(data) || !roles.length;
        }
    };
    updateRoleOptions();
    select.addEventListener('change', updateRoleOptions);

    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const currentUser = await getCurrentUser();
        if (!currentUser) {
            window.location.href = 'login.html';
            return;
        }
        const selectedEvent = events.find((event) => event.id === select.value);
        if (selectedEvent?.creator_id === currentUser.id) {
            showFormMessage('Tu esi šī pasākuma organizators un nevari tam pieteikties.', true);
            return;
        }
        if (!form.elements.requestedRole.value) {
            showFormMessage('Izvēlies lomu, kurā vēlies palīdzēt.', true);
            return;
        }
        await sendApplicationFromForm(form, select.value, currentUser.id);
    });
}

async function setupReportForm() {
    const form = document.querySelector('[data-report-form]');
    const select = document.querySelector('[data-report-event]');
    if (!form || !select) return;
    const currentUser = await getCurrentUser();
    if (!currentUser) return;
    const { data: events, error } = await supabaseClient.from('events').select('id, title').eq('status', 'approved').order('title');
    if (error) {
        showFormMessage(error.message, true);
        return;
    }
    const requestedEvent = new URLSearchParams(window.location.search).get('event');
    select.innerHTML = events.length ? events.map((event) => `<option value="${event.id}" ${event.id === requestedEvent ? 'selected' : ''}>${escapeHtml(event.title)}</option>`).join('') : '<option value="">Nav pieejamu pasākumu</option>';
    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const { data: report, error: reportError } = await supabaseClient.from('reports').insert({
            reporter_id: currentUser.id,
            event_id: select.value || null,
            reason: form.elements.reason.value,
            evidence: form.elements.evidence.value.trim()
        }).select('id').single();
        if (reportError) {
            showFormMessage(reportError.message, true);
            return;
        }
        showFormMessage('Ziņojums nosūtīts administratoram.');
        form.reset();
    });
}

function setupEventDetail() {
    const detail = document.querySelector('[data-event-detail]');
    if (!detail) return;
    const eventId = new URLSearchParams(window.location.search).get('id');
    const joinForm = document.querySelector('[data-detail-application]');
    let currentUser;
    const load = async () => {
        const result = await supabaseClient.from('events').select('id, title, category, event_date, event_start_time, event_end_time, event_started_at, location, latitude, longitude, description, volunteer_roles, volunteer_role_requirements, volunteer_hours, creator_id, status, event_images(storage_path, original_storage_path, sort_order), profiles!events_creator_id_fkey(full_name, avatar_path)').eq('id', eventId).single();
        if (result.error) { detail.innerHTML = `<h1>Pasākums nav atrasts</h1><p>${escapeHtml(result.error.message)}</p>`; return; }
        const event = result.data;
        if (event.status === 'archived') {
            detail.innerHTML = `<p class="eyebrow">${escapeHtml(event.category)}</p><h1>${escapeHtml(event.title)}</h1><p class="event-deleted-message">Šis pasākums ir dzēsts un vairs nav pieejams.</p>`;
            document.querySelector('[data-event-join]')?.remove();
            document.querySelector('[data-organizer-panel]')?.remove();
            document.querySelector('[data-event-chat]')?.remove();
            return;
        }
        const { data: availability } = await supabaseClient.rpc('event_role_availability', { target_event_id: event.id });
        const roles = (availability || eventRoles(event)).map((role) => ({ name: role.role_name || role.name, capacity: Number(role.capacity), filled: Number(role.filled || 0) }));
        detail.innerHTML = `<div class="event-hero-copy"><p class="eyebrow">${escapeHtml(event.category)}</p><h1>${escapeHtml(event.title)}</h1><p>${escapeHtml(event.description)}</p></div><div class="event-facts"><span>📅 ${escapeHtml(event.event_date)}</span><span>🕒 ${escapeHtml(String(event.event_start_time || '09:00').slice(0, 5))}–${escapeHtml(String(event.event_end_time || '10:00').slice(0, 5))}</span><span>📍 ${escapeHtml(event.location)}</span></div><div class="event-detail-grid"><div class="event-detail-block event-detail-roles"><span class="detail-label">Nepieciešamās lomas</span><div class="role-capacity-list">${roles.map((role) => `<span>${escapeHtml(role.name)} <strong>(${role.filled}/${role.capacity})</strong></span>`).join('') || '<span>Lomas nav norādītas.</span>'}</div></div></div>`;
        detail.dataset.creatorId = event.creator_id;
        const images = sortedEventImages(event);
        if (images.length) detail.insertAdjacentHTML('beforeend', `<div class="event-image-gallery" data-image-gallery>${images.map((image, index) => {
            const source = supabaseClient.storage.from('event-images').getPublicUrl(image.storage_path).data.publicUrl;
            const originalSource = supabaseClient.storage.from('event-images').getPublicUrl(image.original_storage_path || image.storage_path).data.publicUrl;
            const alt = `${event.title} — attēls ${index + 1}`;
            return `<button class="gallery-trigger" type="button" data-gallery-image data-gallery-src="${escapeHtml(originalSource)}" data-gallery-alt="${escapeHtml(alt)}" aria-label="Atvērt ${escapeHtml(alt)}"${index ? ' hidden' : ''}><img src="${escapeHtml(source)}" alt="${escapeHtml(alt)}" width="900" height="600"></button>`;
        }).join('')}<button class="gallery-arrow gallery-arrow-left" type="button" data-gallery-previous aria-label="Iepriekšējais attēls">&#8592;</button><button class="gallery-arrow gallery-arrow-right" type="button" data-gallery-next aria-label="Nākamais attēls">&#8594;</button><div class="gallery-dots" aria-label="Izvēlies attēlu">${images.map((image, index) => `<button class="gallery-dot${index === 0 ? ' active' : ''}" type="button" data-gallery-index="${index}" aria-label="Rādīt attēlu ${index + 1}" aria-current="${index === 0 ? 'true' : 'false'}"></button>`).join('')}</div></div>`);
        setupEventCarousel(detail.querySelector('[data-image-gallery]'));
        setupEventMap(event);
        currentUser = await getCurrentUser();
        const organizerElement = document.querySelector('[data-event-organizer]');
        if (organizerElement) organizerElement.innerHTML = `<div class="event-person-row">${profileAvatarMarkup(event.profiles, 'event-person-avatar', event.profiles?.full_name)}<div><strong>${escapeHtml(event.profiles?.full_name || 'Voluntio organizators')}</strong><span>Pasākuma organizators</span></div></div>`;
        const participantsElement = document.querySelector('[data-event-participants]');
        const loadParticipants = async () => {
            if (!participantsElement) return [];
            const { data, error } = await supabaseClient.rpc('event_participants', { event_id: event.id });
            if (error) {
                participantsElement.innerHTML = '<p class="section-copy">Dalībnieku saraksts būs redzams pēc pieslēgšanās.</p>';
                return [];
            }
            participantsElement.innerHTML = data.length ? data.map((participant) => `<div class="event-person-row">${profileAvatarMarkup(participant, 'event-person-avatar', participant.full_name)}<div><strong>${escapeHtml(participant.full_name)}</strong><span>${escapeHtml(participant.requested_role || 'Brīvprātīgais')}${participant.is_muted ? ' · saruna apturēta' : ''}</span></div></div>`).join('') : '<p class="section-copy">Vēl neviens nav pievienojies.</p>';
            return data;
        };
        let participants = await loadParticipants();
        const requestedRole = joinForm?.elements.requestedRole;
        if (requestedRole) requestedRole.innerHTML = roles.length
            ? `<option value="">Izvēlies lomu</option>${roles.filter((role) => role.filled < role.capacity).map((role) => `<option value="${escapeHtml(role.name)}">${escapeHtml(role.name)} (${role.filled}/${role.capacity})</option>`).join('')}`
            : '<option value="">Nav pieejamu lomu</option>';
        if (currentUser?.id === event.creator_id) {
            joinForm?.closest('[data-event-join]')?.remove();
            const panel = document.querySelector('[data-organizer-panel]');
            const applications = document.querySelector('[data-organizer-applications]');
            panel.hidden = false;
            const organizerMessage = (message, error = false) => { const status = document.querySelector('[data-organizer-status]'); status.textContent = message; status.classList.toggle('form-error', error); };
            let { data: completion } = await supabaseClient.from('event_completions').select('id, status, notes').eq('event_id', event.id).maybeSingle();
            const loadApplications = async () => {
                const { data, error } = await supabaseClient.from('event_applications').select('id, volunteer_id, requested_role, status, message, profiles(full_name, avatar_path)').eq('event_id', event.id).order('created_at');
                if (error) { organizerMessage(`Pieteikumus neizdevās ielādēt: ${error.message}`, true); return; }
                const mutedParticipants = new Set(participants.filter((participant) => participant.is_muted).map((participant) => participant.id));
                const completionAction = eventIsFinished(event)
                    ? completion?.status === 'approved' ? '<span class="completion-confirmed">Pabeigšana pārbaudīta — stundas piešķirtas.</span>'
                        : completion?.status === 'pending' ? '<span class="completion-pending">Pabeigšana gaida administratora pārbaudi.</span>'
                        : `<button class="table-button" type="button" data-request-completion>${completion?.status === 'rejected' ? 'Iesniegt atkārtoti pārbaudei' : 'Atzīmēt kā pabeigtu'}</button>`
                    : '';
                const startAction = event.status === 'approved' && event.event_date === eventToday() && !event.event_started_at ? '<button class="table-button" type="button" data-start-event>Sākt pasākumu tagad</button>' : event.event_started_at ? '<span class="completion-confirmed">Pasākums ir sākts.</span>' : '';
                applications.innerHTML = `<div class="organizer-event-actions"><a class="btn-card" href="create-event.html?edit=${encodeURIComponent(event.id)}">Rediģēt pasākumu</a>${startAction}${completionAction}<button class="table-button table-button-danger" type="button" data-cancel-event>Atcelt pasākumu</button></div>
                    <div class="table-wrap"><table class="organizer-table"><thead><tr><th>Vārds</th><th>Loma</th><th>Statuss</th><th>Ziņa</th><th>Darbības</th></tr></thead><tbody>
                    ${(data || []).map(application => `<tr><td><div class="event-person-with-copy">${profileAvatarMarkup(application.profiles, 'event-person-avatar', application.profiles?.full_name)}<strong>${escapeHtml(application.profiles?.full_name || 'Lietotājs')}</strong></div></td>
                    <td>${escapeHtml(application.requested_role || 'Nav norādīta')}</td><td><span class="status status-${application.status}">${applicationStatusLabel(application.status)}</span>${mutedParticipants.has(application.volunteer_id) ? '<small>Nevar rakstīt pasākuma čatā</small>' : ''}</td>
                    <td class="application-message">${escapeHtml(application.message || '—')}</td><td><div class="participant-actions">${application.status === 'pending' ? `<button class="table-button" type="button" data-application-id="${application.id}" data-application-status="approved">Apstiprināt</button><button class="table-button table-button-danger" type="button" data-application-id="${application.id}" data-application-status="rejected">Noraidīt</button>` : application.status === 'approved' ? `<button class="table-button" type="button" data-participant-action="${mutedParticipants.has(application.volunteer_id) ? 'unmute' : 'mute'}" data-participant-id="${application.volunteer_id}" title="${mutedParticipants.has(application.volunteer_id) ? 'Atļaut rakstīt pasākuma čatā' : 'Nevarēs rakstīt pasākuma čatā'}">${mutedParticipants.has(application.volunteer_id) ? 'Atļaut rakstīt' : 'Apklusināt'}</button><button class="table-button table-button-danger" type="button" data-participant-action="kick" data-participant-id="${application.volunteer_id}">Noņemt</button>` : '—'}</div></td></tr>`).join('') || '<tr><td colspan="5">Pieteikumu vēl nav.</td></tr>'}
                    </tbody></table></div>`;
                applications.querySelectorAll('[data-application-id]').forEach((button) => button.addEventListener('click', async () => {
                    button.disabled = true;
                    const { error } = await supabaseClient.rpc('set_event_application_status', { application_id: button.dataset.applicationId, new_status: button.dataset.applicationStatus });
                    if (error) { button.disabled = false; organizerMessage(error.message, true); }
                    else { participants = await loadParticipants(); await loadApplications(); }
                }));
                applications.querySelectorAll('[data-participant-action]').forEach((button) => button.addEventListener('click', async () => {
                    button.disabled = true;
                    const { error } = await supabaseClient.rpc('organizer_set_participant_state', { event_id: event.id, participant_id: button.dataset.participantId, action: button.dataset.participantAction });
                    if (error) { button.disabled = false; organizerMessage(error.message, true); return; }
                    participants = await loadParticipants();
                    await loadApplications();
                }));
                applications.querySelector('[data-cancel-event]')?.addEventListener('click', async () => {
                    if (!window.confirm('Vai tiešām atcelt šo pasākumu? Tas vairs nebūs pieejams dalībniekiem.')) return;
                    const { error } = await supabaseClient.from('events').update({ status: 'archived' }).eq('id', event.id).eq('creator_id', currentUser.id);
                    if (error) { button.disabled = false; organizerMessage(error.message, true); }
                    else window.location.reload();
                });
                applications.querySelector('[data-request-completion]')?.addEventListener('click', async (requestEvent) => {
                    requestEvent.currentTarget.disabled = true;
                    const { error } = await supabaseClient.rpc('request_event_completion', { target_event_id: event.id });
                    if (error) { requestEvent.currentTarget.disabled = false; organizerMessage(error.message, true); return; }
                    completion = { ...(completion || {}), status: 'pending' };
                    organizerMessage('Pabeigšana nosūtīta administratora pārbaudei.');
                    await loadApplications();
                });
                applications.querySelector('[data-start-event]')?.addEventListener('click', async (startEvent) => {
                    startEvent.currentTarget.disabled = true;
                    const { error } = await supabaseClient.rpc('organizer_start_event', { target_event_id: event.id });
                    if (error) { startEvent.currentTarget.disabled = false; organizerMessage(error.message, true); return; }
                    event.event_started_at = new Date().toISOString();
                    organizerMessage('Pasākums sākts. Tā beigu laiks un darba stundas tiek skaitīti no šī brīža.');
                    await loadApplications();
                });
            };
            await loadApplications();
        }
        if (joinForm) joinForm.addEventListener('submit', async (submitEvent) => {
            submitEvent.preventDefault();
            const user = currentUser || await getCurrentUser();
            if (!user) { window.location.href = 'login.html'; return; }
            if (!joinForm.elements.requestedRole.value) { showFormMessage('Izvēlies lomu, kurā vēlies palīdzēt.', true); return; }
            await sendApplicationFromForm(joinForm, event.id, user.id);
        });
        const { data: ownApplication } = currentUser ? await supabaseClient.from('event_applications').select('status').eq('event_id', event.id).eq('volunteer_id', currentUser.id).maybeSingle() : { data: null };
        if (ownApplication && joinForm?.isConnected) {
            if (ownApplication.status === 'approved') {
                joinForm.closest('[data-event-join]')?.remove();
            } else {
                showFormMessage(applicationStatusMessage(ownApplication.status));
                joinForm.querySelector('button[type="submit"]').disabled = true;
            }
        }
        if (eventIsFinished(event) && joinForm?.isConnected) {
            showFormMessage('Pasākums ir beidzies. Pieteikšanās ir slēgta.');
            joinForm.querySelector('button[type="submit"]').disabled = true;
        }
        await setupEventChat(event, currentUser);
    };
    return load().catch(error => {
        const status = document.querySelector('[data-chat-status]');
        if (status) status.textContent = `Pasākumu neizdevās ielādēt: ${error.message}`;
    });
}

function dataUrlToBlob(dataUrl) {
    const [metadata, data] = dataUrl.split(',');
    const mime = metadata.match(/:(.*?);/)[1];
    const binary = atob(data);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
    }
    return new Blob([bytes], { type: mime });
}

function parseLegacyRoles(value) {
    return String(value || '').split(',').map((item) => {
        const match = item.trim().match(/^(.*?)\s*\((\d+)\)$/);
        return match ? { name: match[1].trim(), capacity: Number(match[2]) } : null;
    }).filter(Boolean);
}

function eventRoles(event) {
    const roles = Array.isArray(event?.volunteer_role_requirements) ? event.volunteer_role_requirements : [];
    return roles.length ? roles.map((role) => ({ name: String(role.name || '').trim(), capacity: Number(role.capacity) || 0 })).filter((role) => role.name && role.capacity > 0) : parseLegacyRoles(event?.volunteer_roles);
}

function escapeHtml(value) {
    return String(value).replace(/[&<>'"]/g, (character) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        "'": '&#39;',
        '"': '&quot;'
    }[character]));
}

function showEventRejectionDialog(title, onSubmit) {
    return new Promise(resolve => {
        const dialog = document.createElement('dialog');
        dialog.className = 'event-review-dialog';
        dialog.setAttribute('aria-labelledby', 'event-review-title');
        dialog.innerHTML = `<form data-event-rejection-form>
            <h2 id="event-review-title">Noraidīt pasākumu</h2><p>${escapeHtml(title)}</p>
            <label for="event-rejection-reason">Noraidīšanas iemesls</label>
            <textarea id="event-rejection-reason" name="reason" rows="5" minlength="3" maxlength="2000" placeholder="Paskaidro, kas jāmaina, lai pasākumu varētu apstiprināt." required autofocus></textarea>
            <p>Organizators saņems paziņojumu ar šo iemeslu.</p><p data-rejection-status role="status"></p>
            <div class="review-actions"><button class="table-button" type="button" data-rejection-cancel>Atcelt</button><button class="table-button table-button-danger" type="submit">Noraidīt un paziņot</button></div>
            </form>`;
        document.body.append(dialog);
        let busy = false, saved = false;
        dialog.querySelector('[data-rejection-cancel]').addEventListener('click', () => dialog.close());
        dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
        dialog.addEventListener('close', () => { dialog.remove(); resolve(saved); }, { once: true });
        dialog.querySelector('form').addEventListener('submit', async event => {
            event.preventDefault();
            if (busy) return;
            const form = event.currentTarget;
            const reason = form.elements.reason.value.trim();
            const status = form.querySelector('[data-rejection-status]');
            if (reason.length < 3) { status.textContent = 'Norādi iemeslu vismaz 3 rakstzīmēs.'; return; }
            busy = true;
            form.querySelectorAll('button').forEach(button => { button.disabled = true; });
            status.classList.remove('form-error');
            status.textContent = 'Saglabā noraidījumu un paziņojumu...';
            try { await onSubmit(reason); saved = true; dialog.close(); }
            catch (error) { status.textContent = `Noraidījumu neizdevās saglabāt: ${error.message}`; status.classList.add('form-error'); }
            finally { busy = false; form.querySelectorAll('button').forEach(button => { button.disabled = false; }); }
        });
        dialog.showModal();
    });
}

function setupNotifications(currentUser) {
    const navbar = document.querySelector('.navbar');
    if (!navbar) return;
    navbar.querySelector('[data-notification-nav]')?.notificationCleanup?.();
    navbar.classList.toggle('has-notifications', Boolean(currentUser));
    if (!currentUser) return;
    const container = document.createElement('div');
    container.className = 'notification-nav';
    container.dataset.notificationNav = '';
    container.innerHTML = `<button class="notification-toggle" type="button" aria-label="Paziņojumi" aria-expanded="false" aria-controls="notification-dropdown" data-notification-toggle>
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/></svg>
        <span class="notification-badge" data-notification-count hidden></span></button>
        <section id="notification-dropdown" class="notification-dropdown" aria-label="Paziņojumi" hidden>
        <h2>Paziņojumi</h2><p data-notification-status role="status">Ielādē paziņojumus...</p>
        <div data-notification-list></div><button class="table-button" type="button" data-notification-more hidden>Rādīt vairāk</button>
        <button class="table-button" type="button" data-notification-retry hidden>Mēģināt vēlreiz</button></section>`;
    const authButtons = navbar.querySelector('.auth-buttons');
    if (!authButtons) return;
    authButtons.append(container);
    const toggle = container.querySelector('[data-notification-toggle]');
    const panel = container.querySelector('#notification-dropdown');
    const status = container.querySelector('[data-notification-status]');
    const badge = container.querySelector('[data-notification-count]');
    const list = container.querySelector('[data-notification-list]');
    const more = container.querySelector('[data-notification-more]');
    const retry = container.querySelector('[data-notification-retry]');
    let limit = 20, busy = false, stopped = false, refreshQueued = false, detail;
    let records = [];
    const close = () => { panel.hidden = true; toggle.setAttribute('aria-expanded', 'false'); };
    const refresh = async () => {
        if (stopped) return;
        if (busy) { refreshQueued = true; return; }
        busy = true; more.disabled = true; retry.hidden = true;
        try {
            const [result, unread] = await Promise.all([
                supabaseClient.from('notifications').select('id, event_id, title, body, created_at, read_at').eq('recipient_id', currentUser.id).order('created_at', { ascending: false }).order('id', { ascending: false }).limit(limit + 1),
                supabaseClient.from('notifications').select('id', { count: 'exact', head: true }).eq('recipient_id', currentUser.id).is('read_at', null)
            ]);
            if (result.error || unread.error) throw result.error || unread.error;
            if (stopped) return;
            records = (result.data || []).slice(0, limit);
            const count = unread.count || 0;
            badge.hidden = !count; badge.textContent = count > 99 ? '99+' : String(count);
            toggle.setAttribute('aria-label', count ? `Paziņojumi: ${count} nelasīti` : 'Paziņojumi');
            list.innerHTML = records.map(item => `<button class="notification-item${item.read_at ? '' : ' unread'}" type="button" data-notification-id="${escapeHtml(item.id)}">
                <strong>${escapeHtml(item.title)}</strong><span>${escapeHtml(item.body)}</span>
                <time datetime="${escapeHtml(item.created_at)}">${escapeHtml(new Date(item.created_at).toLocaleString('lv-LV', { timeZone: 'Europe/Riga' }))}</time></button>`).join('');
            status.textContent = records.length ? '' : 'Tev vēl nav paziņojumu.';
            more.hidden = (result.data || []).length <= limit;
        } catch (error) {
            if (!stopped) { status.textContent = 'Paziņojumus neizdevās ielādēt.'; retry.hidden = false; }
        } finally { busy = false; more.disabled = false; if (refreshQueued) { refreshQueued = false; refresh(); } }
    };
    toggle.addEventListener('click', () => { const open = panel.hidden; panel.hidden = !open; toggle.setAttribute('aria-expanded', String(open)); if (open) refresh(); });
    more.addEventListener('click', () => { limit += 20; refresh(); });
    retry.addEventListener('click', refresh);
    list.addEventListener('click', async event => {
        const button = event.target.closest('[data-notification-id]');
        const item = records.find(item => item.id === button?.dataset.notificationId);
        if (!item) return;
        close();
        if (item.event_id) {
            if (!item.read_at) await supabaseClient.rpc('mark_notification_read', { notification_id: item.id });
            window.location.href = `event.html?id=${encodeURIComponent(item.event_id)}`;
            return;
        }
        detail?.remove();
        detail = document.createElement('dialog');
        detail.className = 'notification-detail-dialog';
        detail.setAttribute('aria-labelledby', 'notification-detail-title');
        detail.innerHTML = `<h2 id="notification-detail-title">${escapeHtml(item.title)}</h2>
            <time>${escapeHtml(new Date(item.created_at).toLocaleString('lv-LV', { timeZone: 'Europe/Riga' }))}</time>
            <p class="notification-body">${escapeHtml(item.body)}</p><p data-notification-read-status role="status"></p>
            <div class="review-actions">${item.event_id ? `<a class="btn-card" href="event.html?id=${encodeURIComponent(item.event_id)}">Skatīt pasākumu</a>` : ''}
            <button class="table-button" type="button" data-notification-close>Aizvērt</button></div>`;
        document.body.append(detail);
        detail.querySelector('[data-notification-close]').addEventListener('click', event => event.currentTarget.closest('dialog').close());
        detail.addEventListener('close', event => { event.currentTarget.remove(); toggle.focus(); }, { once: true });
        detail.showModal();
        const readDialog = detail;
        if (!item.read_at) {
            try {
                const { error } = await supabaseClient.rpc('mark_notification_read', { notification_id: item.id });
                if (error) throw error;
                await refresh();
            } catch (error) { if (readDialog.isConnected) readDialog.querySelector('[data-notification-read-status]').textContent = 'Neizdevās atzīmēt kā lasītu. Paziņojums saglabāts.'; }
        }
    });
    const outside = event => { if (!container.contains(event.target)) close(); };
    const escape = event => { if (event.key === 'Escape' && !panel.hidden) { close(); toggle.focus(); } };
    document.addEventListener('click', outside);
    document.addEventListener('keydown', escape);
    const timer = window.setInterval(() => { if (!document.hidden) refresh(); }, 30000);
    container.notificationCleanup = () => {
        stopped = true; clearInterval(timer); document.removeEventListener('click', outside); document.removeEventListener('keydown', escape); detail?.remove(); container.remove();
    };
    window.addEventListener('pagehide', container.notificationCleanup, { once: true });
    refresh();
}

async function setupAdminRequests(currentUser) {
    const list = document.querySelector('[data-event-requests]');

    if (!list || !currentUser || currentUser.profile?.role !== 'admin') {
        return;
    }

    const { data: pendingRequests, error } = await supabaseClient
        .from('events')
        .select('id, title, event_date, creator_id, profiles!events_creator_id_fkey(full_name), event_images(id)')
        .eq('status', 'pending')
        .gte('event_date', eventToday())
        .order('created_at', { ascending: false });

    if (error) {
        list.innerHTML = `<tr><td colspan="5">${escapeHtml(error.message)}</td></tr>`;
        return;
    }

    list.innerHTML = pendingRequests.length ? pendingRequests.map((request) => `
        <tr>
            <td>${escapeHtml(request.title)}</td>
            <td>${escapeHtml(request.profiles?.full_name || request.creator_id)}</td>
            <td>${escapeHtml(request.event_date)}</td>
            <td>${(request.event_images || []).length} / 5</td>
            <td>${validEventDate(request.event_date) ? '' : '<small>Organizatoram jāmaina datums: atļauti ne vairāk kā 10 gadi nākotnē.</small>'}<button class="table-button" type="button" data-event-action="approved" data-event-id="${request.id}" ${validEventDate(request.event_date) ? '' : 'disabled'}>Apstiprināt</button> <button class="table-button table-button-danger" type="button" data-event-action="rejected" data-event-id="${request.id}">Noraidīt</button></td>
        </tr>
    `).join('') : '<tr><td colspan="5">Jaunu pasākumu pieprasījumu nav.</td></tr>';

    list.querySelectorAll('[data-event-action]').forEach((button) => {
        button.addEventListener('click', async () => {
            button.disabled = true;
            const review = async (reason = null) => {
                const { error } = await supabaseClient.rpc('admin_review_event', {
                    target_event_id: button.dataset.eventId, decision: button.dataset.eventAction, rejection_reason: reason
                });
                if (error) throw error;
            };
            try {
                if (button.dataset.eventAction === 'rejected') {
                    const request = pendingRequests.find(request => request.id === button.dataset.eventId);
                    if (!await showEventRejectionDialog(request.title, review)) { button.disabled = false; return; }
                } else await review();
            } catch (error) {
                button.disabled = false;
                showFormMessage(`Pasākumu neizdevās pārskatīt: ${error.message}`, true);
                return;
            }
            await setupAdminRequests(currentUser);
            await setupAdminDashboard(currentUser);
        });
    });
}

async function setupAdminCompletionRequests(currentUser) {
    const list = document.querySelector('[data-admin-completions]');
    const count = document.querySelector('[data-admin-count="completions"]');

    if (!list || !currentUser || currentUser.profile?.role !== 'admin') return;

    const { data: completions, error } = await supabaseClient
        .from('event_completions')
        .select('id, status, requested_at, events(id, title, event_date, creator_id, profiles!events_creator_id_fkey(full_name))')
        .eq('status', 'pending')
        .order('requested_at', { ascending: false });

    if (error) {
        list.innerHTML = adminEmptyRow(5, `Datus neizdevās ielādēt: ${error.message}`);
        if (count) count.textContent = '0 gaida';
        return;
    }

    const requests = completions || [];
    if (count) count.textContent = `${requests.length} gaida`;
    list.innerHTML = requests.length ? requests.map((completion) => {
        const event = completion.events;
        return `<tr><td>${escapeHtml(event?.title || 'Dzēsts pasākums')}</td><td>${escapeHtml(event?.profiles?.full_name || event?.creator_id || 'Nezināms lietotājs')}</td><td>${formatAdminDate(event?.event_date)}</td><td><span class="status status-pending">Gaida</span></td><td><button class="table-button" type="button" data-completion-action="approved" data-completion-id="${completion.id}">Apstiprināt</button> <button class="table-button table-button-danger" type="button" data-completion-action="rejected" data-completion-id="${completion.id}">Noraidīt</button></td></tr>`;
    }).join('') : adminEmptyRow(5, 'Pabeigšanas pieprasījumu nav.');

    list.querySelectorAll('[data-completion-action]').forEach((button) => {
        button.addEventListener('click', async () => {
            button.disabled = true;
            const { error: reviewError } = await supabaseClient.rpc('admin_review_event_completion', {
                target_completion_id: button.dataset.completionId,
                decision: button.dataset.completionAction
            });
            if (reviewError) {
                button.disabled = false;
                showFormMessage(reviewError.message, true);
                return;
            }
            await setupAdminCompletionRequests(currentUser);
        });
    });
}

function formatAdminDate(value) {
    if (!value) return '-';
    const dateValue = value instanceof Date ? value : String(value);
    const date = dateValue instanceof Date || dateValue.includes('T') || dateValue.includes('Z')
        ? new Date(dateValue)
        : new Date(`${dateValue}T00:00:00`);
    if (Number.isNaN(date.getTime())) return '-';
    return new Intl.DateTimeFormat('lv-LV', { dateStyle: 'short' }).format(date);
}

function adminEmptyRow(columns, text) {
    return `<tr><td colspan="${columns}">${escapeHtml(text)}</td></tr>`;
}

function renderAdminTable(list, rows, columns, emptyText, renderRow) {
    if (!list) return;
    try {
        list.innerHTML = rows.length ? rows.map(renderRow).join('') : adminEmptyRow(columns, emptyText);
    } catch (error) {
        console.error('Admin table rendering failed', error);
        list.innerHTML = adminEmptyRow(columns, `Tabulu neizdevās parādīt: ${error.message}`);
    }
}

function setupAdminFilters() {
    document.querySelectorAll('[data-admin-filter]').forEach((input) => {
        input.addEventListener('input', () => {
            const target = document.querySelector(`[data-admin-${input.dataset.filterTarget}]`);
            if (!target) return;
            const query = input.value.trim().toLowerCase();
            target.querySelectorAll('tr').forEach((row) => {
                row.hidden = Boolean(query) && !row.textContent.toLowerCase().includes(query);
            });
        });
    });
}

function setupAdminUserActions(currentUser) {
    if (!document.querySelector('[data-admin-users]') || currentUser?.profile?.role !== 'admin') return;
    if (document.documentElement.dataset.adminUserActionsBound === 'true') return;
    document.documentElement.dataset.adminUserActionsBound = 'true';

    const banDialog = document.querySelector('[data-ban-dialog]');
    const banForm = banDialog?.querySelector('[data-ban-form]');
    const closeBanDialog = () => banDialog?.close();
    banDialog?.querySelector('[data-ban-close]')?.addEventListener('click', closeBanDialog);
    banDialog?.querySelector('[data-ban-cancel]')?.addEventListener('click', closeBanDialog);

    banForm?.addEventListener('submit', async (event) => {
        event.preventDefault();
        const submitButton = banForm.querySelector('button[type="submit"]');
        const duration = banForm.querySelector('[data-ban-duration]').value;
        submitButton.disabled = true;
        try {
            const { error } = await supabaseClient.rpc('admin_set_user_banned', {
                target_user_id: banForm.dataset.userId,
                should_ban: true,
                ban_hours: duration === 'permanent' ? null : Number(duration)
            });
            if (error) throw error;
            closeBanDialog();
            await setupAdminDashboard(currentUser);
        } catch (error) {
            showFormMessage(`Lietotāju neizdevās bloķēt: ${error.message}${error.code ? ` (${error.code})` : ''}`, true);
        } finally {
            submitButton.disabled = false;
        }
    });

    document.addEventListener('click', async (event) => {
        if (!(event.target instanceof Element)) return;
        const button = event.target.closest('[data-user-action]');
        if (!button || !button.closest('[data-admin-users]')) return;
        const action = button.dataset.userAction;
        if (action === 'ban' && banDialog && banForm) {
            banForm.dataset.userId = button.dataset.userId;
            banDialog.querySelector('[data-ban-user]').textContent = `Lietotājs: ${button.dataset.userName || 'Nezināms lietotājs'}`;
            banDialog.showModal();
            return;
        }
        if (action === 'unban' || action === 'demote') {
            if (!window.confirm('Vai tiešām vēlies veikt šo darbību?')) return;
        }

        button.disabled = true;
        const roleAction = action === 'promote' || action === 'demote';
        const rpcName = roleAction ? 'admin_set_user_role' : 'admin_set_user_banned';
        const rpcArgs = roleAction
            ? { target_user_id: button.dataset.userId, target_role: action === 'promote' ? 'admin' : 'user' }
            : { target_user_id: button.dataset.userId, should_ban: false, ban_hours: null };
        try {
            const { error } = await supabaseClient.rpc(rpcName, rpcArgs);
            if (error) throw error;
            if (roleAction) {
                const { data: updatedUser, error: verificationError } = await supabaseClient.from('profiles').select('role').eq('id', button.dataset.userId).single();
                if (verificationError) throw verificationError;
                const expectedRole = action === 'promote' ? 'admin' : 'user';
                if (updatedUser?.role !== expectedRole) throw new Error('Lomas maiņa netika saglabāta datubāzē.');
            }
            await setupAdminDashboard(currentUser);
        } catch (error) {
            showFormMessage(`Darbību neizdevās izpildīt: ${error.message}${error.code ? ` (${error.code})` : ''}`, true);
        } finally {
            button.disabled = false;
        }
    });
}

async function setupAdminDashboard(currentUser) {
    if (!document.querySelector('[data-admin-stat]') || currentUser?.profile?.role !== 'admin') return;

    const [usersResult, eventsResult, applicationsResult, pendingResult] = await Promise.all([
        supabaseClient.from('profiles').select('id, full_name, role, is_banned, banned_until, created_at').order('created_at', { ascending: false }),
        supabaseClient.from('events').select('id, creator_id, title, status, event_date').order('event_date', { ascending: true }),
        supabaseClient.from('event_applications').select('id, event_id, status, created_at, volunteer_id').order('created_at', { ascending: false }),
        supabaseClient.from('events').select('id', { count: 'exact', head: true }).eq('status', 'pending')
    ]);
    const { data: reports, error: reportsError } = await supabaseClient.from('reports').select('id, event_id, reason, priority, status, created_at').neq('status', 'resolved').neq('status', 'dismissed').order('created_at', { ascending: false });
    const users = usersResult.data || [];
    const events = (eventsResult.data || []).map(event => ({ ...event, profiles: users.find(user => user.id === event.creator_id), event_applications: (applicationsResult.data || []).filter(application => application.event_id === event.id) }));
    const applications = (applicationsResult.data || []).map(application => ({ ...application, profiles: users.find(user => user.id === application.volunteer_id), events: events.find(event => event.id === application.event_id) }));
    const activeEvents = events.filter((event) => event.status === 'approved');
    const setStat = (name, value) => {
        const element = document.querySelector(`[data-admin-stat="${name}"]`);
        if (element) element.textContent = String(value);
    };
    const setCount = (name, value) => {
        const element = document.querySelector(`[data-admin-count="${name}"]`);
        if (element) element.textContent = `${value} kopā`;
    };
    setStat('users', users.length);
    setStat('events', activeEvents.length);
    setStat('applications', applications.length);
    setStat('pending', pendingResult.count || 0);
    setStat('reports', reports?.length || 0);
    setCount('users', users.length);
    setCount('events', events.length);
    setCount('applications', applications.length);
    setCount('reports', reports?.length || 0);

    const userList = document.querySelector('[data-admin-users]');
    renderAdminTable(userList, users, 6, 'Lietotāju nav.', (user) => `
        <tr><td>${escapeHtml(user.full_name)}</td><td title="${escapeHtml(user.id)}">${escapeHtml(user.id.slice(0, 8))}...</td><td>${user.role === 'admin' ? 'Administrators' : 'Brīvprātīgais'}</td><td>${applications.filter((application) => application.profiles?.id === user.id).length}</td><td><span class="status status-${isBanActive(user) ? 'rejected' : 'approved'}">${isBanActive(user) ? 'Bloķēts' : 'Aktīvs'}</span>${isBanActive(user) && user.banned_until ? `<small class="ban-until">līdz ${escapeHtml(new Date(user.banned_until).toLocaleDateString('lv-LV', { timeZone: 'Europe/Riga' }))}</small>` : ''}</td><td><button class="table-button" type="button" data-user-action="${user.role === 'admin' ? 'demote' : 'promote'}" data-user-id="${user.id}">${user.role === 'admin' ? 'Noņemt adminu' : 'Paaugstināt par adminu'}</button> <button class="table-button table-button-danger" type="button" data-user-action="${isBanActive(user) ? 'unban' : 'ban'}" data-user-id="${user.id}" data-user-name="${escapeHtml(user.full_name)}">${isBanActive(user) ? 'Atbloķēt' : 'Bloķēt'}</button> <button class="table-button" type="button" data-user-audit-id="${user.id}" data-user-audit-name="${escapeHtml(user.full_name)}">Audit Log</button></td></tr>
    `);

    const applicationList = document.querySelector('[data-admin-applications]');
    renderAdminTable(applicationList, applications.slice(0, 20), 5, 'Pieteikumu nav.', (application) => `
        <tr><td>${escapeHtml(application.profiles?.full_name || 'Nezināms lietotājs')}</td><td>${escapeHtml(application.events?.title || 'Dzēsts pasākums')}</td><td>${formatAdminDate(application.events?.event_date)}</td><td><span class="status status-${application.status === 'approved' ? 'approved' : application.status === 'rejected' ? 'rejected' : 'pending'}">${application.status === 'approved' ? 'Apstiprināts' : application.status === 'rejected' ? 'Noraidīts' : 'Gaida'}</span></td><td>-</td></tr>
    `);

    const eventList = document.querySelector('[data-admin-events]');
    renderAdminTable(eventList, events, 6, 'Pasākumu nav.', (event) => `
        <tr><td><a href="event.html?id=${encodeURIComponent(event.id)}">${escapeHtml(event.title)}</a></td><td>${escapeHtml(event.profiles?.full_name || 'Nezināms lietotājs')}</td><td>${(event.event_applications || []).length}</td><td><span class="status status-${event.status === 'approved' ? 'approved' : event.status === 'rejected' ? 'rejected' : 'pending'}">${event.status === 'approved' ? 'Publicēts' : event.status === 'rejected' ? 'Noraidīts' : event.status === 'pending' ? 'Gaida' : 'Arhivēts'}</span></td><td>${formatAdminDate(event.event_date)}</td><td>${event.status !== 'archived' ? `<button class="table-button table-button-danger" type="button" data-admin-archive-event="${event.id}">Arhivēt</button>` : '-'}</td></tr>
    `);

    eventList?.querySelectorAll('[data-admin-archive-event]').forEach((button) => {
        button.addEventListener('click', async () => {
            if (!window.confirm('Vai arhivēt šo pasākumu moderēšanas nolūkā?')) return;
            button.disabled = true;
            const { error } = await supabaseClient.from('events').update({ status: 'archived' }).eq('id', button.dataset.adminArchiveEvent);
            if (error) { button.disabled = false; showFormMessage(error.message, true); return; }
            await setupAdminDashboard(currentUser);
        });
    });

    const reportList = document.querySelector('[data-admin-reports]');
    renderAdminTable(reportList, reports || [], 6, 'Atvērtu ziņojumu nav.', (report) => `
        <tr><td><span class="status status-${report.priority === 'high' ? 'rejected' : report.priority === 'low' ? 'approved' : 'pending'}">${escapeHtml(report.priority)}</span></td><td>${escapeHtml(report.reason)}</td><td>${escapeHtml(events.find((event) => event.id === report.event_id)?.title || 'Dzēsts pasākums')}</td><td>${formatAdminDate(report.created_at?.slice(0, 10))}</td><td>${escapeHtml(report.status)}</td><td><button class="table-button" type="button" data-report-action="resolved" data-report-id="${report.id}">Atrisināts</button> <button class="table-button table-button-danger" type="button" data-report-action="dismissed" data-report-id="${report.id}">Noraidīt</button></td></tr>
    `);

    for (const [list, result, columns] of [[userList, usersResult, 6], [eventList, eventsResult, 6], [applicationList, applicationsResult, 5], [reportList, { error: reportsError }, 6]]) {
        if (list && result.error) list.innerHTML = adminEmptyRow(columns, `Datus neizdevās ielādēt: ${result.error.message}`);
    }

    applicationList?.querySelectorAll('[data-application-action]').forEach((button) => {
        button.addEventListener('click', async () => {
            button.disabled = true;
            const { error } = await supabaseClient.from('event_applications').update({
                status: button.dataset.applicationAction
            }).eq('id', button.dataset.applicationId);
            if (error) {
                button.disabled = false;
                showFormMessage(error.message, true);
                return;
            }
            await setupAdminDashboard(currentUser);
        });
    });

    reportList?.querySelectorAll('[data-report-action]').forEach((button) => {
        button.addEventListener('click', async () => {
            button.disabled = true;
            const { error } = await supabaseClient.from('reports').update({ status: button.dataset.reportAction, resolved_by: currentUser.id, resolved_at: new Date().toISOString() }).eq('id', button.dataset.reportId);
            if (error) {
                button.disabled = false;
                showFormMessage(error.message, true);
                return;
            }
            await setupAdminDashboard(currentUser);
        });
    });
}

function localTestEvents() {
    return [
        ['Parka sakopšana', 'Talka', 'Rīga', '#d8eedc'],
        ['Palīdzība dzīvnieku patversmei', 'Labdarība', 'Jelgava', '#ffe3ca'],
        ['Skolas brīvprātīgo diena', 'Skolas pasākums', 'Liepāja', '#dfe5ff']
    ].map(([title, category, location, color], index) => ({
        id: `local-test-${index + 1}`, title, category, location, isLocalTest: true,
        description: 'Demonstrācijas pasākums meklēšanas un filtru izmēģināšanai.',
        event_date: 'Datums tiks precizēts', status: 'approved',
        preview_image: `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="900" height="600" viewBox="0 0 900 600"><rect width="900" height="600" fill="${color}"/><circle cx="720" cy="130" r="65" fill="#fff"/><path d="M0 480L230 210 470 480 670 290 900 480V600H0Z" fill="#5168a0"/><text x="450" y="540" text-anchor="middle" font-family="sans-serif" font-size="38" fill="white">LOCAL TEST ${index + 1}</text></svg>`)}`
    }));
}

function sortedEventImages(event) {
    return [...(event.event_images || [])].sort((a, b) => a.sort_order - b.sort_order);
}

function setupEventCarousel(gallery) {
    if (!gallery) return;
    const images = [...gallery.querySelectorAll('[data-gallery-image]')];
    const dots = [...gallery.querySelectorAll('[data-gallery-index]')];
    let currentIndex = 0;
    const show = (index) => {
        currentIndex = (index + images.length) % images.length;
        images.forEach((image, imageIndex) => { image.hidden = imageIndex !== currentIndex; });
        dots.forEach((dot, dotIndex) => {
            const active = dotIndex === currentIndex;
            dot.classList.toggle('active', active);
            dot.setAttribute('aria-current', String(active));
        });
    };
    gallery.querySelector('[data-gallery-previous]')?.addEventListener('click', () => show(currentIndex - 1));
    gallery.querySelector('[data-gallery-next]')?.addEventListener('click', () => show(currentIndex + 1));
    dots.forEach((dot) => dot.addEventListener('click', () => show(Number(dot.dataset.galleryIndex))));
}

function setupImageLightbox() {
    if (document.querySelector('[data-image-lightbox]')) return;
    const dialog = document.createElement('dialog');
    dialog.className = 'image-lightbox';
    dialog.dataset.imageLightbox = 'true';
    dialog.setAttribute('aria-label', 'Pasākuma attēlu galerija');
    dialog.innerHTML = `<button class="image-lightbox-close" type="button" data-lightbox-close aria-label="Aizvērt attēlu galeriju">&times;</button>
        <button class="image-lightbox-arrow image-lightbox-arrow-left" type="button" data-lightbox-previous aria-label="Iepriekšējais attēls">&#8592;</button>
        <figure><img data-lightbox-image alt=""><figcaption data-lightbox-caption></figcaption></figure>
        <button class="image-lightbox-arrow image-lightbox-arrow-right" type="button" data-lightbox-next aria-label="Nākamais attēls">&#8594;</button>`;
    document.body.append(dialog);
    const image = dialog.querySelector('[data-lightbox-image]');
    const caption = dialog.querySelector('[data-lightbox-caption]');
    let items = [];
    let currentIndex = 0;
    const render = () => {
        const item = items[currentIndex];
        if (!item) return;
        image.src = item.dataset.gallerySrc;
        image.alt = item.dataset.galleryAlt;
        caption.textContent = `${item.dataset.galleryAlt} · ${currentIndex + 1}/${items.length}`;
        dialog.querySelector('[data-lightbox-previous]').hidden = items.length < 2;
        dialog.querySelector('[data-lightbox-next]').hidden = items.length < 2;
    };
    const move = (step) => {
        if (items.length < 2) return;
        currentIndex = (currentIndex + step + items.length) % items.length;
        render();
    };
    document.addEventListener('click', (event) => {
        const trigger = event.target.closest('[data-gallery-image]');
        if (!trigger) return;
        const gallery = trigger.closest('[data-image-gallery]');
        items = [...gallery.querySelectorAll('[data-gallery-image]')];
        currentIndex = items.indexOf(trigger);
        render();
        dialog.showModal();
    });
    dialog.querySelector('[data-lightbox-close]').addEventListener('click', () => dialog.close());
    dialog.querySelector('[data-lightbox-previous]').addEventListener('click', () => move(-1));
    dialog.querySelector('[data-lightbox-next]').addEventListener('click', () => move(1));
    dialog.addEventListener('click', (event) => { if (event.target === dialog) dialog.close(); });
    dialog.addEventListener('keydown', (event) => {
        if (event.key === 'ArrowLeft') move(-1);
        if (event.key === 'ArrowRight') move(1);
    });
}

async function renderCustomEvents() {
    const list = document.querySelector('[data-custom-events]');
    const homeList = document.querySelector('[data-home-events]');
    if (!list && !homeList) {
        return;
    }

    const status = document.querySelector('[data-events-status]');
    let approvedEvents;
    try {
        const { data, error } = await supabaseClient
            .from('events')
            .select('id, title, category, event_date, event_start_time, event_end_time, location, description, volunteer_roles, status, event_images(storage_path, sort_order)')
            .eq('status', 'approved')
            .order('event_date', { ascending: true });

        if (error) throw error;
        approvedEvents = data || [];
    } catch (error) {
        if (status) status.textContent = `Pasākumus neizdevās ielādēt: ${error.message}`;
        if (homeList) homeList.textContent = 'Pasākumus neizdevās ielādēt.';
        return;
    }

    const categoryKey = (category) => {
        const normalized = String(category).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
        if (normalized.includes('talka')) return 'talka';
        if (normalized.includes('labdar')) return 'labdariba';
        if (normalized.includes('skol')) return 'skola';
        return normalized;
    };

    const availableEvents = approvedEvents.filter((event) => event.status === 'approved');
    const listedEvents = approvedEvents.length ? approvedEvents : localTestEvents();
    if (status) status.textContent = approvedEvents.length ? '' : 'LOCAL TEST — 3 demonstrācijas pasākumi. Tie nav saglabāti datubāzē.';
    if (list) list.innerHTML = listedEvents.map((event) => `
        <div class="event-card${event.status === 'archived' ? ' event-card-deleted' : ''}" data-category="${escapeHtml(categoryKey(event.category))}" data-event-search="${escapeHtml([event.title, event.description, event.category, event.location, event.volunteer_roles].filter(Boolean).join(' '))}">
            ${event.isLocalTest ? '<span class="local-test-label">LOCAL TEST</span>' : ''}
            <div class="card-badge">${escapeHtml(event.category)}</div>
            ${event.preview_image || sortedEventImages(event)[0] ? `<img class="event-image" width="900" height="600" src="${escapeHtml(event.preview_image || supabaseClient.storage.from('event-images').getPublicUrl(sortedEventImages(event)[0].storage_path).data.publicUrl)}" alt="${escapeHtml(event.title)}">` : ''}
            <h3>${escapeHtml(event.title)}</h3>
            <p class="card-desc">${escapeHtml(event.description)}</p>
            <div class="card-meta">
                <span>📅 ${escapeHtml(event.event_date)}</span>
                <span>🕒 ${escapeHtml(String(event.event_start_time || '09:00').slice(0, 5))}–${escapeHtml(String(event.event_end_time || '10:00').slice(0, 5))}</span>
                <span>📍 ${escapeHtml(event.location)}</span>
            </div>
            ${event.volunteer_roles ? `<p class="event-roles"><strong>Lomas:</strong> ${escapeHtml(event.volunteer_roles)}</p>` : ''}
            ${event.isLocalTest ? '<p>Demonstrācija — pieteikšanās nav pieejama.</p>' : event.status === 'archived' ? '<p class="event-deleted-message">Dzēsts, vairs nav pieejams.</p>' : `<a href="event.html?id=${encodeURIComponent(event.id)}" class="btn-card">Skatīt pasākumu</a><a href="report.html?event=${encodeURIComponent(event.id)}" class="text-button">Ziņot par pasākumu</a>`}
        </div>
    `).join('');
    if (homeList) homeList.innerHTML = availableEvents.length ? availableEvents.slice(0, 2).map((event) => `
        <article class="home-event-card">
            <span class="event-kind">${escapeHtml(event.category)}</span>
            <p class="event-date">${escapeHtml(event.event_date)}</p>
            <h3>${escapeHtml(event.title)}</h3>
            <p>${escapeHtml(event.description)}</p>
            ${event.volunteer_roles ? `<p class="event-roles"><strong>Lomas:</strong> ${escapeHtml(event.volunteer_roles)}</p>` : ''}
            <div><span>${escapeHtml(event.location)}</span></div>
            <a href="event.html?id=${encodeURIComponent(event.id)}" class="btn-card">Skatīt pasākumu</a>
            <a href="report.html?event=${encodeURIComponent(event.id)}" class="text-button">Ziņot par pasākumu</a>
        </article>
    `).join('') : '<p class="no-results">Apstiprinātu pasākumu pašlaik nav.</p>';
    if (list) list.dataset.loaded = 'true';
    document.dispatchEvent(new Event('voluntio:events-rendered'));
}

function setupEventFilters() {
    const search = document.querySelector('#searchInput');
    const category = document.querySelector('#categoryFilter');
    const section = document.querySelector('.events-grid-section');
    if (!search || !category || !section) return;

    const normalize = (value) => String(value || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim();
    const list = section.querySelector('.custom-events-grid');
    const more = section.querySelector('[data-show-more]');
    if (!list) return;
    let limit = 3;
    const filterEvents = () => {
        if (list.dataset.loaded !== 'true') return;
        const query = normalize(search.value.trim());
        const selectedCategory = normalize(category.value);
        let visibleCount = 0;
        list.querySelectorAll('.event-card').forEach((card) => {
            const searchableText = normalize(card.dataset.eventSearch || card.textContent);
            const cardCategory = normalize(card.dataset.category || '');
            const matchesSearch = !query || searchableText.includes(query);
            const matchesCategory = !selectedCategory || cardCategory === selectedCategory;
            const matches = matchesSearch && matchesCategory;
            card.hidden = !matches || visibleCount >= limit;
            if (matches) visibleCount += 1;
        });
        if (more) more.hidden = visibleCount <= limit;

        let emptyState = list.querySelector('.no-results');
        if (!visibleCount) {
            if (!emptyState) {
                emptyState = document.createElement('p');
                emptyState.className = 'no-results';
                list.append(emptyState);
            }
            emptyState.textContent = 'Pēc izvēlētajiem kritērijiem pasākumi nav atrasti.';
            emptyState.hidden = false;
        } else if (emptyState) {
            emptyState.hidden = true;
        }
    };
    const resetFilters = () => { limit = 3; filterEvents(); };
    search.addEventListener('input', resetFilters);
    category.addEventListener('change', resetFilters);
    document.addEventListener('voluntio:events-rendered', resetFilters);
    more?.addEventListener('click', () => { limit += 3; filterEvents(); });
    filterEvents();
}

function setupFooterLinks() {
    document.querySelectorAll('[data-registration-form] a[href="#"]').forEach((link) => {
        const label = link.textContent.toLowerCase();
        link.href = label.includes('privātuma') ? 'privacy.html' : 'terms.html';
    });
    document.querySelectorAll('footer').forEach((footer) => {
        if (footer.querySelector('.footer-links')) return;
        const links = document.createElement('p');
        links.className = 'footer-links';
        links.innerHTML = '<a href="terms.html">Lietošanas noteikumi</a><span aria-hidden="true">·</span><a href="privacy.html">Privātuma politika</a>';
        footer.append(links);
    });
}

function setupLoginForm() {
    const form = document.querySelector('[data-login-form]');

    if (!form) {
        return;
    }

    setupPasswordToggles(form);
    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        clearFormErrors(form);
        if (!validateEmail(form.elements.email.value.trim())) {
            setFieldError(form, 'email', 'Ievadi derīgu e-pasta adresi.');
            return;
        }
        if (!form.elements.password.value) {
            setFieldError(form, 'password', 'Ievadi savu paroli.');
            return;
        }
        const { error } = await supabaseClient.auth.signInWithPassword({
            email: form.elements.email.value.trim(),
            password: form.elements.password.value
        });
        if (error) {
            showFormMessage(error.message, true);
            return;
        }
        const currentUser = await getCurrentUser();
        window.location.href = currentUser?.profile?.role === 'admin' ? 'admin.html' : 'index.html';
    });
}

async function setupProfilePage(currentUser) {
    const form = document.querySelector('[data-profile-form]');
    if (!form || !currentUser) return;
    const passwordForm = document.querySelector('[data-password-form]');
    const passwordMessage = document.querySelector('[data-password-message]');
    const avatarInput = form.querySelector('[data-profile-avatar-input]');
    const avatarPreview = form.querySelector('[data-profile-avatar-preview]');
    const avatarFallback = form.querySelector('[data-profile-avatar-fallback]');
    let pendingAvatar;
    const renderAvatar = (url = profileAvatarUrl(currentUser.profile)) => {
        if (avatarFallback) avatarFallback.textContent = initialsForName(currentUser.profile?.full_name || currentUser.email);
        if (!avatarPreview || !avatarFallback) return;
        avatarPreview.hidden = !url;
        avatarFallback.hidden = Boolean(url);
        if (url) avatarPreview.src = url;
    };
    renderAvatar();
    avatarInput?.addEventListener('change', async () => {
        const file = avatarInput.files?.[0];
        if (!file) return;
        if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 5 * 1024 * 1024) {
            showFormMessage('Izvēlies JPG, PNG vai WEBP attēlu līdz 5 MB.', true);
            avatarInput.value = '';
            return;
        }
        try {
            pendingAvatar = await createAvatarPreview(file);
            renderAvatar(pendingAvatar);
            showFormMessage('Attēls ir gatavs — saglabā profilu, lai to publicētu.');
        } catch {
            showFormMessage('Neizdevās apstrādāt profila attēlu.', true);
        }
    });
    const recoveryMode = window.location.hash.includes('type=recovery');
    const currentPasswordField = passwordForm?.elements.currentPassword;
    if (recoveryMode && currentPasswordField) {
        currentPasswordField.required = false;
        currentPasswordField.hidden = true;
        passwordForm.querySelector('label[for="current-password"]').hidden = true;
    }
    const myEvents = document.querySelector('[data-my-events]');
    if (myEvents) {
        const { data: events, error } = await supabaseClient.from('events').select('id, title, event_date, status').eq('creator_id', currentUser.id).order('created_at', { ascending: false });
        myEvents.innerHTML = error ? `<p>${escapeHtml(error.message)}</p>` : events.length ? events.map((event) => `<div class="owned-event"><div><strong>${escapeHtml(event.title)}</strong><span>${escapeHtml(event.event_date)} · ${event.status === 'archived' ? 'Dzēsts, vairs nav pieejams' : escapeHtml(event.status)}</span></div>${event.status === 'archived' ? '<span class="event-deleted-label">Dzēsts</span>' : `<div class="owned-event-actions"><a class="btn-card" href="create-event.html?edit=${encodeURIComponent(event.id)}">Rediģēt</a><button class="table-button table-button-danger" type="button" data-delete-event="${escapeHtml(event.id)}">Dzēst</button></div>`}</div>`).join('') : '<p>Tu vēl neesi izveidojis pasākumus.</p>';
        myEvents.querySelectorAll('[data-delete-event]').forEach((button) => button.addEventListener('click', async () => {
            if (!window.confirm('Vai tiešām vēlies dzēst šo pasākumu? Citi redzēs, ka tas vairs nav pieejams.')) return;
            button.disabled = true;
            const { error: deleteError } = await supabaseClient.from('events').update({ status: 'archived' }).eq('id', button.dataset.deleteEvent).eq('creator_id', currentUser.id);
            if (deleteError) {
                button.disabled = false;
                showFormMessage(deleteError.message, true);
                return;
            }
            window.location.reload();
        }));
    }
    const { data: volunteerSummary, error: volunteerSummaryError } = await supabaseClient.rpc('my_volunteer_summary');
    const summary = Array.isArray(volunteerSummary) ? volunteerSummary[0] : volunteerSummary;
    const hours = document.querySelector('[data-profile-hours]');
    const tasks = document.querySelector('[data-profile-tasks]');
    const achievements = document.querySelector('[data-profile-achievements]');
    if (!volunteerSummaryError && summary) {
        if (hours) hours.textContent = Number(summary.total_hours || 0).toLocaleString('lv-LV');
        if (tasks) tasks.textContent = String(summary.completed_tasks || 0);
        const earned = Array.isArray(summary.achievements) ? summary.achievements : [];
        if (achievements) achievements.innerHTML = earned.length ? earned.map((achievement) => `<div class="achievement-badge"><span class="achievement-badge-mark" aria-hidden="true">✓</span><div><strong>${escapeHtml(achievement.title)}</strong><small>${escapeHtml(achievement.description)}</small></div></div>`).join('') : '<p class="section-copy">Pēc pirmā pārbaudītā pasākuma šeit parādīsies tavs pirmais sasniegums.</p>';
    } else if (achievements) {
        achievements.innerHTML = '<p class="section-copy">Sasniegumus pašlaik neizdevās ielādēt.</p>';
    }
    form.elements.fullName.value = currentUser.profile?.full_name || '';
    form.elements.email.value = currentUser.email || '';
    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const newName = form.elements.fullName.value.trim();
        const { error: nameError } = await supabaseClient.rpc('update_my_profile', { new_full_name: newName });
        if (nameError) {
            showFormMessage(nameError.message, true);
            return;
        }
        currentUser.profile.full_name = newName;
        if (pendingAvatar) {
            const path = `${currentUser.id}/avatar.jpg`;
            const { error: uploadError } = await supabaseClient.storage.from('profile-avatars').upload(path, dataUrlToBlob(pendingAvatar), {
                contentType: 'image/jpeg',
                upsert: true
            });
            if (uploadError) {
                showFormMessage(`Vārds ir saglabāts, bet attēlu neizdevās augšupielādēt: ${uploadError.message}`, true);
                return;
            }
            const { error: avatarError } = await supabaseClient.rpc('update_my_avatar_path', { new_avatar_path: path });
            if (avatarError) {
                showFormMessage(`Vārds ir saglabāts, bet attēlu neizdevās piesaistīt profilam: ${avatarError.message}`, true);
                return;
            }
            currentUser.profile.avatar_path = path;
            pendingAvatar = undefined;
            renderAvatar(`${profileAvatarUrl(currentUser.profile)}?v=${Date.now()}`);
        }
        updateAuthLinks(currentUser);
        showFormMessage('Profils atjaunināts.');
    });
    passwordForm?.addEventListener('submit', async (event) => {
        event.preventDefault();
        const currentPassword = passwordForm.elements.currentPassword.value;
        const password = passwordForm.elements.password.value;
        const confirmation = passwordForm.elements.passwordConfirm.value;
        passwordMessage.textContent = '';
        passwordMessage.classList.remove('form-error');
        if (!recoveryMode) {
            const { error: currentPasswordError } = await supabaseClient.auth.signInWithPassword({
                email: currentUser.email,
                password: currentPassword
            });
            if (currentPasswordError) {
                passwordMessage.textContent = 'Pašreizējā parole nav pareiza.';
                passwordMessage.classList.add('form-error');
                return;
            }
        }
        if (password.length < 8 || password !== confirmation) {
            passwordMessage.textContent = password.length < 8 ? 'Parolei jābūt vismaz 8 rakstzīmes garai.' : 'Paroles nesakrīt.';
            passwordMessage.classList.add('form-error');
            return;
        }
        const { error } = await supabaseClient.auth.updateUser({ password });
        passwordMessage.textContent = error ? error.message : 'Parole veiksmīgi nomainīta.';
        passwordMessage.classList.toggle('form-error', Boolean(error));
        if (!error) {
            passwordForm.reset();
            if (recoveryMode) window.history.replaceState({}, document.title, 'profile.html');
        }
    });
    document.querySelector('[data-profile-reset]')?.addEventListener('click', async () => {
        const { error } = await supabaseClient.auth.resetPasswordForEmail(currentUser.email, { redirectTo: `${window.location.origin}/profile.html` });
        passwordMessage.textContent = error ? error.message : 'Atiestatīšanas e-pasts ir nosūtīts.';
        passwordMessage.classList.toggle('form-error', Boolean(error));
    });
    document.querySelector('[data-export-data]')?.addEventListener('click', async () => {
        const { data, error } = await supabaseClient.rpc('export_my_data');
        if (error) return showFormMessage(error.message, true);
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = 'voluntio-personal-data.json';
        link.click();
        URL.revokeObjectURL(link.href);
    });
    const deleteForm = document.querySelector('[data-delete-account-form]');
    const deleteMessage = document.querySelector('[data-delete-account-message]');
    deleteForm?.addEventListener('submit', async (event) => {
        event.preventDefault();
        deleteMessage.textContent = '';
        const { error: passwordError } = await supabaseClient.auth.signInWithPassword({
            email: currentUser.email,
            password: deleteForm.elements.password.value
        });
        if (passwordError) {
            deleteMessage.textContent = 'Parole nav pareiza. Konts netika dzēsts.';
            deleteMessage.classList.add('form-error');
            return;
        }
        if (!window.confirm('Vai tiešām vēlies neatgriezeniski dzēst savu kontu un datus?')) return;
        const { error } = await supabaseClient.rpc('delete_my_account');
        if (error) {
            deleteMessage.textContent = error.message;
            deleteMessage.classList.add('form-error');
            return;
        }
        await supabaseClient.auth.signOut();
        window.location.href = 'index.html';
    });
}

function setupRegistrationForm() {
    const form = document.querySelector('[data-registration-form]');

    if (!form) {
        return;
    }

    setupPasswordToggles(form);
    const password = form.elements.password;
    password.addEventListener('input', () => updatePasswordStrength(password.value, form));
    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        clearFormErrors(form);
        const firstName = form.elements.firstName.value.trim();
        const lastName = form.elements.lastName.value.trim();
        const email = form.elements.email.value.trim();
        const confirmation = form.elements.passwordConfirm.value;
        let invalid = false;
        if (!firstName) { setFieldError(form, 'firstName', 'Ievadi savu vārdu.'); invalid = true; }
        if (!lastName) { setFieldError(form, 'lastName', 'Ievadi savu uzvārdu.'); invalid = true; }
        if (!validateEmail(email)) { setFieldError(form, 'email', 'Ievadi derīgu e-pasta adresi.'); invalid = true; }
        if (password.value.length < 8) { setFieldError(form, 'password', 'Parolei jābūt vismaz 8 rakstzīmes garai.'); invalid = true; }
        if (password.value !== confirmation) { setFieldError(form, 'passwordConfirm', 'Paroles nesakrīt.'); invalid = true; }
        if (!form.elements.terms.checked) { setFieldError(form, 'terms', 'Lai turpinātu, piekrīti noteikumiem.'); invalid = true; }
        if (invalid) return;
        const { error } = await supabaseClient.auth.signUp({
            email,
            password: password.value,
            options: {
                emailRedirectTo: new URL('profile.html', window.location.href).href,
                data: { full_name: `${firstName} ${lastName}`, first_name: firstName, last_name: lastName, phone: form.elements.phone.value.trim() }
            }
        });
        if (error) {
            showFormMessage(error.message, true);
            return;
        }
        showFormMessage('Konts izveidots. Pārbaudi e-pastu, lai apstiprinātu kontu.');
    });
}

function validateEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function setFieldError(form, name, message) {
    const element = form.elements[name];
    element?.classList.add('input-error');
    const error = form.querySelector(`[data-error-for="${name}"]`);
    if (error) error.textContent = message;
}

function clearFormErrors(form) {
    form.querySelectorAll('.input-error').forEach((element) => element.classList.remove('input-error'));
    form.querySelectorAll('[data-error-for]').forEach((element) => { element.textContent = ''; });
    showFormMessage('');
}

function setupPasswordToggles(form) {
    form.querySelectorAll('[data-password-toggle]').forEach((button) => {
        button.innerHTML = '<span aria-hidden="true">◉</span><span class="visually-hidden">Rādīt</span>';
        button.addEventListener('click', () => {
            const input = button.parentElement.querySelector('input');
            const revealed = input.type === 'text';
            input.type = revealed ? 'password' : 'text';
            button.classList.toggle('is-revealed', !revealed);
            button.innerHTML = revealed
                ? '<span aria-hidden="true">◉</span><span class="visually-hidden">Rādīt</span>'
                : '<span aria-hidden="true">◉̸</span><span class="visually-hidden">Slēpt</span>';
            button.setAttribute('aria-label', revealed ? 'Rādīt paroli' : 'Slēpt paroli');
        });
    });
}

function updatePasswordStrength(value, form) {
    const bar = form.querySelector('[data-strength-bar]');
    const hint = form.querySelector('[data-password-hint]');
    if (!bar || !hint) return;
    const score = [value.length >= 8, /[A-Z]/.test(value), /\d/.test(value), /[^A-Za-z0-9]/.test(value)].filter(Boolean).length;
    const labels = ['Izmanto vismaz 8 rakstzīmes.', 'Vāja parole', 'Vidēji droša parole', 'Spēcīga parole', 'Ļoti spēcīga parole'];
    const colors = ['#d92d20', '#d92d20', '#f79009', '#12b76a', '#12b76a'];
    bar.style.width = `${score * 25}%`;
    bar.style.background = colors[score];
    hint.textContent = labels[score];
}

let activeLanguage = 'lv';
const originalTextValues = new WeakMap();
const originalAttributeValues = new WeakMap();

function setupPagePreferences() {
    const navbar = document.querySelector('.navbar');
    const authContent = document.querySelector('.auth-content');
    if ((!navbar && !authContent) || document.querySelector('.nav-preferences')) return;

    const controls = document.createElement('div');
    controls.className = 'nav-preferences';
    controls.dataset.noTranslate = 'true';
    const darkMode = sessionStorage.getItem('voluntio-theme') === 'dark';
    const savedLanguage = localStorage.getItem('voluntio-language');
    document.body.classList.toggle('dark-mode', darkMode);
    controls.innerHTML = `<button class="nav-preference" type="button" data-theme-toggle>${darkMode ? 'Gaišs' : 'Tumšs'}</button><button class="nav-preference" type="button" data-language-toggle>${savedLanguage === 'en' ? 'LV' : 'EN'}</button>`;
    if (navbar) navbar.insertBefore(controls, navbar.querySelector('.auth-buttons'));
    else authContent.append(controls);

    controls.querySelector('[data-theme-toggle]').addEventListener('click', (event) => {
        document.body.classList.toggle('dark-mode');
        const isDark = document.body.classList.contains('dark-mode');
        sessionStorage.setItem('voluntio-theme', isDark ? 'dark' : 'light');
        event.currentTarget.textContent = isDark ? 'Gaišs' : 'Tumšs';
    });
    controls.querySelector('[data-language-toggle]').addEventListener('click', async (event) => {
        const button = event.currentTarget;
        const targetLanguage = activeLanguage === 'lv' ? 'en' : 'lv';
        button.disabled = true;
        button.textContent = '...';
        try {
            await translatePage(targetLanguage);
            activeLanguage = targetLanguage;
            localStorage.setItem('voluntio-language', targetLanguage);
            button.textContent = targetLanguage === 'en' ? 'LV' : 'EN';
            document.documentElement.lang = targetLanguage;
        } catch (error) {
            showFormMessage('Tulkojumu pašlaik neizdevās ielādēt.', true);
            button.textContent = activeLanguage === 'lv' ? 'EN' : 'LV';
        } finally {
            button.disabled = false;
        }
    });
    if (savedLanguage === 'en') {
        translatePage('en').then(() => {
            activeLanguage = 'en';
            document.documentElement.lang = 'en';
        }).catch(() => {
            localStorage.removeItem('voluntio-language');
        });
    }
}

function setupNavigation() {
    const navbar = document.querySelector('body:not(.auth-page) .navbar');
    if (!navbar || navbar.querySelector('[data-menu-toggle]')) return;

    const navLinks = navbar.querySelector('.nav-links');
    const authButtons = navbar.querySelector('.auth-buttons');
    if (!navLinks || !authButtons) return;

    const menuId = 'primary-navigation';
    const panel = document.createElement('div');
    panel.className = 'mobile-nav-panel';
    panel.id = menuId;
    navbar.append(panel);
    panel.append(navLinks);
    const preferences = navbar.querySelector('.nav-preferences');
    if (preferences) panel.append(preferences);
    panel.append(authButtons);
    const button = document.createElement('button');
    button.className = 'menu-toggle';
    button.type = 'button';
    button.dataset.menuToggle = 'true';
    button.setAttribute('aria-expanded', 'false');
    button.setAttribute('aria-controls', menuId);
    button.setAttribute('aria-label', 'Atvērt navigāciju');
    button.innerHTML = '<span></span><span></span><span></span>';
    navbar.querySelector('.logo').insertAdjacentElement('afterend', button);

    const closeMenu = () => {
        navbar.classList.remove('menu-open');
        button.setAttribute('aria-expanded', 'false');
        button.setAttribute('aria-label', 'Atvērt navigāciju');
    };
    button.addEventListener('click', () => {
        const isOpen = navbar.classList.toggle('menu-open');
        button.setAttribute('aria-expanded', String(isOpen));
        button.setAttribute('aria-label', isOpen ? 'Aizvērt navigāciju' : 'Atvērt navigāciju');
    });
    navLinks.addEventListener('click', (event) => {
        if (event.target.closest('a')) closeMenu();
    });
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && navbar.classList.contains('menu-open')) {
            closeMenu();
            button.focus();
        }
    });
}

function removeTranslationArtifacts() {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
        const node = walker.currentNode;
        if (node.parentElement?.closest('script, style')) continue;
        node.nodeValue = node.nodeValue.replace(/[\[\]]{3,}/g, '');
    }
}

async function translatePage(targetLanguage) {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
            const parent = node.parentElement;
            if (!node.nodeValue.trim() || !parent || parent.closest('script, style, [data-no-translate]')) return NodeFilter.FILTER_REJECT;
            return NodeFilter.FILTER_ACCEPT;
        }
    });
    const textNodes = [];
    while (walker.nextNode()) textNodes.push(walker.currentNode);
    const attributes = [...document.querySelectorAll('input[placeholder], textarea[placeholder], [title]')]
        .filter((element) => !element.closest('[data-no-translate]'))
        .flatMap((element) => ['placeholder', 'title'].filter((attribute) => element.hasAttribute(attribute)).map((attribute) => ({ element, attribute })));
    const items = [
        ...textNodes.map((node) => {
            if (!originalTextValues.has(node)) originalTextValues.set(node, node.nodeValue);
            return { node, text: originalTextValues.get(node) };
        }),
        ...attributes.map(({ element, attribute }) => {
            if (!originalAttributeValues.has(element)) originalAttributeValues.set(element, {});
            const originals = originalAttributeValues.get(element);
            if (!(attribute in originals)) originals[attribute] = element.getAttribute(attribute);
            return { element, attribute, text: originals[attribute] };
        })
    ];

    // Latvian is the authored source. Never translate English back into
    // Latvian: that is what changed imperative wording such as “Izveidot”.
    if (targetLanguage === 'lv') {
        items.forEach((item) => {
            if (item.node) item.node.nodeValue = item.text;
            else item.element.setAttribute(item.attribute, item.text);
        });
        return;
    }

    // Larger parallel batches keep dense pages as responsive as the homepage,
    // without reintroducing separator artifacts into translated content.
    for (let index = 0; index < items.length; index += 24) {
        const batch = items.slice(index, index + 24);
        const results = await Promise.all(batch.map(async (item) => {
            const original = item.text.trim();
            return original ? translateWithApi(original, 'lv', targetLanguage) : '';
        }));
        batch.forEach((item, itemIndex) => {
            const original = item.text.trim();
            const result = results[itemIndex];
            if (!result) return;
            if (item.node) item.node.nodeValue = item.text.replace(original, result);
            else item.element.setAttribute(item.attribute, result);
        });
    }
}

async function translateWithApi(text, sourceLanguage, targetLanguage) {
    const url = new URL('https://translate.googleapis.com/translate_a/single');
    url.searchParams.set('client', 'gtx');
    url.searchParams.set('sl', sourceLanguage);
    url.searchParams.set('tl', targetLanguage);
    url.searchParams.set('dt', 't');
    url.searchParams.set('q', text);
    const response = await fetch(url);
    if (!response.ok) throw new Error('Translation request failed');
    const data = await response.json();
    return data[0].map((part) => part[0]).join('');
}

document.addEventListener('DOMContentLoaded', async () => {
    removeTranslationArtifacts();
    setupImageLightbox();
    setupEventFilters();
    const currentUser = await getCurrentUser();
    showStoredBanNotice();
    if (!await guardPage(currentUser)) {
        return;
    }
    // A banned session is signed out by getCurrentUser before public queries run.
    setupAdminUserActions(currentUser);
    renderCustomEvents();
    updateAuthLinks(currentUser);
    setupPagePreferences();
    setupNavigation();
    setupLoginForm();
    setupRegistrationForm();
    setupProfilePage(currentUser);
    setupEventForm();
    setupLocationPicker();
    setupApplicationForm();
    setupReportForm();
    setupEventDetail();
    setupAdminRequests(currentUser);
    setupAdminDashboard(currentUser);
    setupAdminCompletionRequests(currentUser);
    setupAdminFilters();
    setupHomeSummary();
    setupFooterLinks();
});
