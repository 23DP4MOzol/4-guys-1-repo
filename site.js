const supabaseClient = window.voluntioSupabase;

async function getCurrentUser() {
    const { data: { user } } = await supabaseClient.auth.getUser();
    if (!user) {
        return null;
    }

    const { data: profile } = await supabaseClient
        .from('profiles')
        .select('id, full_name, role, is_banned')
        .eq('id', user.id)
        .single();

    if (profile?.is_banned) {
        await supabaseClient.auth.signOut();
        return null;
    }

    return { ...user, profile };
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
    const isAdmin = currentUser?.profile?.role === 'admin';
    document.querySelectorAll('.hero-text-link').forEach((link) => { link.hidden = Boolean(currentUser); });

    document.querySelectorAll('a[href="admin.html"]').forEach((link) => {
        link.closest('li')?.classList.toggle('hidden-nav-item', !isAdmin);
    });

    if (!authButtons || !currentUser) {
        return;
    }

    const displayName = currentUser.profile?.full_name || currentUser.email.split('@')[0];
    const initials = displayName.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join('').toUpperCase();
    authButtons.innerHTML = `
        <a class="user-profile" href="profile.html" aria-label="Atvērt profilu"><span class="user-avatar" aria-hidden="true">${escapeHtml(initials || 'V')}</span><span class="user-greeting">Sveiks, ${escapeHtml(displayName)}</span></a>
        <button class="btn-login logout-button" type="button">Iziet</button>
    `;

    authButtons.querySelector('.logout-button').addEventListener('click', async () => {
        await supabaseClient.auth.signOut();
        window.location.href = 'index.html';
    });
}

async function setupHomeSummary() {
    const countElement = document.querySelector('[data-home-week-count]');
    if (!countElement) return;

    const today = new Date();
    const weekStart = new Date(today);
    const day = weekStart.getDay() || 7;
    weekStart.setDate(weekStart.getDate() - day + 1);
    const nextWeek = new Date(weekStart);
    nextWeek.setDate(nextWeek.getDate() + 7);
    const toDate = (date) => date.toISOString().slice(0, 10);
    const { count, error } = await supabaseClient
        .from('events')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'approved')
        .gte('event_date', toDate(weekStart))
        .lt('event_date', toDate(nextWeek));

    countElement.textContent = error ? '0' : String(count || 0);
}

function createCroppedPreview(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            const image = new Image();
            image.onload = () => {
                const canvas = document.createElement('canvas');
                canvas.width = 900;
                canvas.height = 600;
                const context = canvas.getContext('2d');
                const scale = Math.max(canvas.width / image.width, canvas.height / image.height);
                const width = image.width * scale;
                const height = image.height * scale;
                context.drawImage(image, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height);
                resolve(canvas.toDataURL('image/jpeg', 0.82));
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
    let croppedImages = [];
    const editId = new URLSearchParams(window.location.search).get('edit');

    if (!form || !input || !preview) {
        return;
    }

    const roleBuilder = form.querySelector('[data-role-builder]');
    const rolesField = form.elements.roles;

    const syncRoles = () => {
        rolesField.value = [...roleBuilder.querySelectorAll('.role-row')].map((row) => {
            const name = row.querySelector('[name="role-name"]').value.trim();
            const count = Math.max(0, Number(row.querySelector('[name="role-count"]').value) || 0);
            return name ? `${name} (${count})` : '';
        }).filter(Boolean).join(', ');
    };
    if (editId) {
        supabaseClient.from('events').select('title, category, event_date, location, volunteer_roles, description, whitelist_volunteers').eq('id', editId).single().then(({ data }) => {
            if (!data) return;
            form.elements.title.value = data.title;
            form.elements.category.value = data.category;
            form.elements.date.value = data.event_date;
            form.elements.location.value = data.location;
            form.elements.description.value = data.description;
            form.elements.whitelist.checked = data.whitelist_volunteers;
            const button = form.querySelector('button[type="submit"]');
            if (button) button.textContent = 'Saglabāt izmaiņas';
        });
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
        row.querySelector('[name="role-count"]').value = '0';
        row.querySelector('[data-remove-role]').disabled = false;
        roleBuilder.append(row);
        row.querySelector('[name="role-name"]').focus();
    });

    input.addEventListener('change', async () => {
        const files = Array.from(input.files).slice(0, 5);
        if (input.files.length > 5) {
            window.alert('Pasākumam drīkst pievienot ne vairāk kā 5 attēlus.');
        }

        preview.innerHTML = '<p class="image-processing">Apstrādā attēlus...</p>';
        croppedImages = await Promise.all(files.map(createCroppedPreview));
        preview.innerHTML = croppedImages.map((image, index) => `
            <div class="image-preview-item">
                <img src="${image}" alt="Pasākuma attēls ${index + 1}">
                <span>Attēls ${index + 1}</span>
            </div>
        `).join('');
    });

    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const currentUser = await getCurrentUser();
        if (!currentUser) {
            window.location.href = 'login.html';
            return;
        }
        const title = form.elements.title.value.trim();
        if (title.length < 3 || title.length > 120) {
            showFormMessage('Pasākuma nosaukumam jābūt 3–120 rakstzīmes garam.', true);
            form.elements.title.focus();
            return;
        }

        const eventPayload = {
            creator_id: currentUser.id,
            title,
            category: form.elements.category.value,
            event_date: form.elements.date.value,
            location: form.elements.location.value.trim(),
            volunteer_roles: form.elements.roles.value.trim(),
            description: form.elements.description.value.trim(),
            whitelist_volunteers: form.elements.whitelist.checked,
            status: 'pending'
        };
        const eventQuery = editId
            ? supabaseClient.from('events').update(eventPayload).eq('id', editId).eq('creator_id', currentUser.id).select('id').single()
            : supabaseClient.from('events').insert(eventPayload).select('id').single();
        const { data: eventRecord, error } = await eventQuery;

        if (error) {
            showFormMessage(`Neizdevās iesniegt pasākumu: ${error.message}`, true);
            return;
        }

        if (editId) {
            window.location.href = 'profile.html';
            return;
        }
        const uploadedPaths = [];
        for (let index = 0; index < croppedImages.length; index += 1) {
            const path = `${currentUser.id}/${eventRecord.id}/${index + 1}.jpg`;
            const upload = await supabaseClient.storage.from('event-images').upload(path, dataUrlToBlob(croppedImages[index]), {
                contentType: 'image/jpeg',
                upsert: false
            });
            if (upload.error) {
                await supabaseClient.from('events').delete().eq('id', eventRecord.id);
                showFormMessage(`Attēla augšupielāde neizdevās: ${upload.error.message}`, true);
                return;
            }
            uploadedPaths.push(path);
            const imageRecord = await supabaseClient.from('event_images').insert({
                event_id: eventRecord.id,
                storage_path: path,
                sort_order: index
            });
            if (imageRecord.error) {
                await supabaseClient.storage.from('event-images').remove(uploadedPaths);
                await supabaseClient.from('events').delete().eq('id', eventRecord.id);
                showFormMessage(`Attēla saglabāšana neizdevās: ${imageRecord.error.message}`, true);
                return;
            }
        }

        showFormMessage('Pasākuma pieprasījums nosūtīts adminam apstiprināšanai.');
        form.reset();
        roleBuilder.innerHTML = roleBuilder.children[0]?.outerHTML || '';
        roleBuilder.querySelectorAll('input').forEach((field) => { field.value = field.name === 'role-count' ? '0' : ''; });
        roleBuilder.querySelector('[data-remove-role]').disabled = true;
        syncRoles();
        preview.innerHTML = '';
        window.location.href = 'profile.html';
    });
}

async function setupApplicationForm() {
    const form = document.querySelector('[data-application-form]');
    const select = document.querySelector('[data-event-select]');

    if (!form || !select) {
        return;
    }

    const { data: events, error } = await supabaseClient
        .from('events')
        .select('id, title, event_date, creator_id')
        .eq('status', 'approved')
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
        const { error: applicationError } = await supabaseClient.from('event_applications').insert({
            event_id: select.value,
            volunteer_id: currentUser.id,
            message: form.elements.message.value.trim()
        });

        if (applicationError) {
            showFormMessage(applicationError.message, true);
            return;
        }
        showFormMessage('Pieteikums nosūtīts pasākuma organizatoram.');
        form.reset();
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
        await supabaseClient.from('audit_logs').insert({ actor_id: currentUser.id, action: 'submitted_report', entity_type: 'report', entity_id: report.id });
        showFormMessage('Ziņojums nosūtīts administratoram.');
        form.reset();
    });
}

function setupEventDetail() {
    const detail = document.querySelector('[data-event-detail]');
    if (!detail) return;
    const eventId = new URLSearchParams(window.location.search).get('id');
    const joinForm = document.querySelector('[data-detail-application]');
    const chatList = document.querySelector('[data-chat-list]');
    const chatForm = document.querySelector('[data-chat-form]');
    const blockedWords = ['spamword', 'scamword'];
    let currentUser;
    const load = async () => {
        const result = await supabaseClient.from('events').select('id, title, category, event_date, location, description, volunteer_roles, creator_id, status, profiles!events_creator_id_fkey(full_name)').eq('id', eventId).single();
        if (result.error) { detail.innerHTML = `<h1>Pasākums nav atrasts</h1><p>${escapeHtml(result.error.message)}</p>`; return; }
        const event = result.data;
        if (event.status === 'archived') {
            detail.innerHTML = `<p class="eyebrow">${escapeHtml(event.category)}</p><h1>${escapeHtml(event.title)}</h1><p class="event-deleted-message">Šis pasākums ir dzēsts un vairs nav pieejams.</p>`;
            document.querySelector('[data-event-join]')?.remove();
            document.querySelector('[data-organizer-panel]')?.remove();
            document.querySelector('[data-event-chat]')?.remove();
            return;
        }
        detail.innerHTML = `<p class="eyebrow">${escapeHtml(event.category)}</p><h1>${escapeHtml(event.title)}</h1><div class="event-detail-grid"><div class="event-detail-block"><span class="detail-label">Apraksts</span><p>${escapeHtml(event.description)}</p></div><div class="event-detail-block"><span class="detail-label">Norises vieta</span><p class="event-location">${escapeHtml(event.location)}</p><span class="detail-label">Datums</span><p class="event-meta">${escapeHtml(event.event_date)}</p></div>${event.volunteer_roles ? `<div class="event-detail-block event-detail-roles"><span class="detail-label">Nepieciešamās lomas</span><p class="event-roles">${escapeHtml(event.volunteer_roles)}</p></div>` : ''}<div class="event-detail-block"><span class="detail-label">Organizators</span><p>${escapeHtml(event.profiles?.full_name || '')}</p></div></div>`;
        currentUser = await getCurrentUser();
        if (currentUser?.id === event.creator_id) {
            joinForm?.closest('[data-event-join]')?.remove();
            const panel = document.querySelector('[data-organizer-panel]');
            const applications = document.querySelector('[data-organizer-applications]');
            panel.hidden = false;
            const loadApplications = async () => {
                const { data } = await supabaseClient.from('event_applications').select('id, status, message, profiles(full_name)').eq('event_id', event.id).order('created_at');
                applications.innerHTML = (data || []).map((application) => `<div class="owned-event"><div><strong>${escapeHtml(application.profiles?.full_name || 'Lietotājs')}</strong><span>${escapeHtml(application.message || '')} · ${escapeHtml(application.status)}</span></div>${application.status === 'pending' ? `<button class="table-button" type="button" data-application-id="${application.id}" data-application-status="approved">Apstiprināt</button> <button class="table-button table-button-danger" type="button" data-application-id="${application.id}" data-application-status="rejected">Noraidīt</button>` : ''}</div>`).join('') || '<p>Pieteikumu nav.</p>';
                applications.querySelectorAll('[data-application-id]').forEach((button) => button.addEventListener('click', async () => {
                    await supabaseClient.from('event_applications').update({ status: button.dataset.applicationStatus }).eq('id', button.dataset.applicationId);
                    loadApplications();
                }));
            };
            loadApplications();
        }
        if (joinForm) joinForm.addEventListener('submit', async (submitEvent) => {
            submitEvent.preventDefault();
            const user = currentUser || await getCurrentUser();
            if (!user) { window.location.href = 'login.html'; return; }
            const { error } = await supabaseClient.from('event_applications').insert({ event_id: event.id, volunteer_id: user.id, message: joinForm.elements.message.value.trim() });
            showFormMessage(error ? error.message : 'Pieteikums nosūtīts organizatoram.', Boolean(error));
            if (!error) joinForm.querySelector('button').disabled = true;
        });
        loadChat();
    };
    const loadChat = async () => {
        if (!chatList) return;
        const { data } = await supabaseClient.from('event_messages').select('id, message, created_at, profiles(full_name)').eq('event_id', eventId).order('created_at');
        chatList.innerHTML = (data || []).map((message) => `<p><strong>${escapeHtml(message.profiles?.full_name || 'Lietotājs')}:</strong> ${escapeHtml(message.message)}</p>`).join('') || '<p>Šeit vēl nav ziņu.</p>';
    };
    chatForm?.addEventListener('submit', async (event) => {
        event.preventDefault();
        const user = currentUser || await getCurrentUser();
        const value = chatForm.elements.message.value.trim();
        if (!user) { window.location.href = 'login.html'; return; }
        if (!value || blockedWords.some((word) => value.toLowerCase().includes(word))) { showFormMessage('Ziņa satur neatļautu tekstu.', true); return; }
        const { error } = await supabaseClient.from('event_messages').insert({ event_id: eventId, sender_id: user.id, message: value });
        if (error) { showFormMessage(error.message, true); return; }
        chatForm.reset();
        await loadChat();
    });
    supabaseClient.channel(`event-chat-${eventId}`).on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'event_messages', filter: `event_id=eq.${eventId}` }, loadChat).subscribe();
    load();
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

function escapeHtml(value) {
    return String(value).replace(/[&<>'"]/g, (character) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        "'": '&#39;',
        '"': '&quot;'
    }[character]));
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
            <td><button class="table-button" type="button" data-event-action="approved" data-event-id="${request.id}">Apstiprināt</button> <button class="table-button table-button-danger" type="button" data-event-action="rejected" data-event-id="${request.id}">Noraidīt</button></td>
        </tr>
    `).join('') : '<tr><td colspan="5">Jaunu pasākumu pieprasījumu nav.</td></tr>';

    list.querySelectorAll('[data-event-action]').forEach((button) => {
        button.addEventListener('click', async () => {
            button.disabled = true;
            const { error: updateError } = await supabaseClient.from('events').update({
                status: button.dataset.eventAction,
                reviewed_by: currentUser.id,
                reviewed_at: new Date().toISOString()
            }).eq('id', button.dataset.eventId);
            if (updateError) {
                button.disabled = false;
                showFormMessage(updateError.message, true);
                return;
            }
            await setupAdminRequests(currentUser);
            await setupAdminDashboard(currentUser);
        });
    });
}

function formatAdminDate(value) {
    if (!value) return '-';
    return new Intl.DateTimeFormat('lv-LV', { dateStyle: 'short' }).format(new Date(`${value}T00:00:00`));
}

function adminEmptyRow(columns, text) {
    return `<tr><td colspan="${columns}">${escapeHtml(text)}</td></tr>`;
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

async function setupAdminDashboard(currentUser) {
    if (!document.querySelector('[data-admin-stat]') || currentUser?.profile?.role !== 'admin') return;

    const [usersResult, eventsResult, applicationsResult, pendingResult] = await Promise.all([
        supabaseClient.from('profiles').select('id, full_name, role, is_banned, created_at').order('created_at', { ascending: false }),
        supabaseClient.from('events').select('id, title, status, event_date, profiles!events_creator_id_fkey(full_name), event_applications(id)').order('event_date', { ascending: true }),
        supabaseClient.from('event_applications').select('id, status, created_at, volunteer_id, profiles(id, full_name), events(title, event_date)').order('created_at', { ascending: false }),
        supabaseClient.from('events').select('id', { count: 'exact', head: true }).eq('status', 'pending')
    ]);
    const [{ data: reports }, { data: auditLogs }] = await Promise.all([
        supabaseClient.from('reports').select('id, reason, priority, status, created_at, events(title)').neq('status', 'resolved').neq('status', 'dismissed').order('created_at', { ascending: false }),
        supabaseClient.from('audit_logs').select('id, action, entity_type, entity_id, details, created_at').order('created_at', { ascending: false }).limit(25)
    ]);

    const users = usersResult.data || [];
    const events = eventsResult.data || [];
    const applications = applicationsResult.data || [];
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
    if (userList) userList.innerHTML = users.length ? users.map((user) => `
        <tr><td>${escapeHtml(user.full_name)}</td><td title="${escapeHtml(user.id)}">${escapeHtml(user.id.slice(0, 8))}...</td><td>${user.role === 'admin' ? 'Administrators' : 'Brīvprātīgais'}</td><td>${applications.filter((application) => application.profiles?.id === user.id).length}</td><td><span class="status status-${user.is_banned ? 'rejected' : 'approved'}">${user.is_banned ? 'Bloķēts' : 'Aktīvs'}</span></td><td><button class="table-button" type="button" data-user-action="${user.role === 'admin' ? 'demote' : 'promote'}" data-user-id="${user.id}">${user.role === 'admin' ? 'Noņemt adminu' : 'Promovēt adminam'}</button> <button class="table-button table-button-danger" type="button" data-user-action="${user.is_banned ? 'unban' : 'ban'}" data-user-id="${user.id}">${user.is_banned ? 'Atbloķēt' : 'Bloķēt'}</button></td></tr>
    `).join('') : adminEmptyRow(6, 'Lietotāju nav.');

    const applicationList = document.querySelector('[data-admin-applications]');
    if (applicationList) applicationList.innerHTML = applications.length ? applications.slice(0, 20).map((application) => `
        <tr><td>${escapeHtml(application.profiles?.full_name || 'Nezināms lietotājs')}</td><td>${escapeHtml(application.events?.title || 'Dzēsts pasākums')}</td><td>${formatAdminDate(application.events?.event_date)}</td><td><span class="status status-${application.status === 'approved' ? 'approved' : application.status === 'rejected' ? 'rejected' : 'pending'}">${application.status === 'approved' ? 'Apstiprināts' : application.status === 'rejected' ? 'Noraidīts' : 'Gaida'}</span></td><td>-</td></tr>
    `).join('') : adminEmptyRow(5, 'Pieteikumu nav.');

    const eventList = document.querySelector('[data-admin-events]');
    if (eventList) eventList.innerHTML = events.length ? events.map((event) => `
        <tr><td>${escapeHtml(event.title)}</td><td>${escapeHtml(event.profiles?.full_name || 'Nezināms lietotājs')}</td><td>${(event.event_applications || []).length}</td><td><span class="status status-${event.status === 'approved' ? 'approved' : event.status === 'rejected' ? 'rejected' : 'pending'}">${event.status === 'approved' ? 'Publicēts' : event.status === 'rejected' ? 'Noraidīts' : 'Gaida'}</span></td><td>${formatAdminDate(event.event_date)}</td></tr>
    `).join('') : adminEmptyRow(5, 'Pasākumu nav.');

    const reportList = document.querySelector('[data-admin-reports]');
    if (reportList) reportList.innerHTML = reports?.length ? reports.map((report) => `
        <tr><td><span class="status status-${report.priority === 'high' ? 'rejected' : report.priority === 'low' ? 'approved' : 'pending'}">${escapeHtml(report.priority)}</span></td><td>${escapeHtml(report.reason)}</td><td>${escapeHtml(report.events?.title || 'Dzēsts pasākums')}</td><td>${formatAdminDate(report.created_at.slice(0, 10))}</td><td>${escapeHtml(report.status)}</td><td><button class="table-button" type="button" data-report-action="resolved" data-report-id="${report.id}">Atrisināts</button> <button class="table-button table-button-danger" type="button" data-report-action="dismissed" data-report-id="${report.id}">Noraidīt</button></td></tr>
    `).join('') : adminEmptyRow(6, 'Atvērtu ziņojumu nav.');

    const auditList = document.querySelector('[data-admin-audit]');
    if (auditList) auditList.innerHTML = auditLogs?.length ? auditLogs.map((log) => `<tr><td>${escapeHtml(new Date(log.created_at).toLocaleString('lv-LV'))}</td><td>${escapeHtml(log.action)}</td><td>${escapeHtml(log.entity_type)}</td><td>${escapeHtml(JSON.stringify(log.details || {}))}</td></tr>`).join('') : adminEmptyRow(4, 'Audita ierakstu nav.');

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

    userList?.querySelectorAll('[data-user-action]').forEach((button) => {
        button.addEventListener('click', async () => {
            const action = button.dataset.userAction;
            const confirmation = action === 'ban' || action === 'demote';
            if (confirmation && !window.confirm('Vai tiešām vēlies veikt šo darbību?')) return;
            button.disabled = true;
            const rpcName = action === 'promote' || action === 'demote' ? 'admin_set_user_role' : 'admin_set_user_banned';
            const rpcArgs = rpcName === 'admin_set_user_role'
                ? { target_user_id: button.dataset.userId, target_role: action === 'promote' ? 'admin' : 'user' }
                : { target_user_id: button.dataset.userId, should_ban: action === 'ban' };
            const { error } = await supabaseClient.rpc(rpcName, rpcArgs);
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
            await supabaseClient.from('audit_logs').insert({ actor_id: currentUser.id, action: `${button.dataset.reportAction}_report`, entity_type: 'report', entity_id: button.dataset.reportId });
            await setupAdminDashboard(currentUser);
        });
    });
}

async function renderCustomEvents() {
    const list = document.querySelector('[data-custom-events]');
    const homeList = document.querySelector('[data-home-events]');
    if (!list && !homeList) {
        return;
    }

    const { data: approvedEvents, error } = await supabaseClient
        .from('events')
        .select('id, title, category, event_date, location, description, volunteer_roles, status, event_images(storage_path)')
        .in('status', ['approved', 'archived'])
        .order('event_date', { ascending: true });

    if (error) {
        if (list) list.innerHTML = `<p>${escapeHtml(error.message)}</p>`;
        if (homeList) homeList.innerHTML = `<p>${escapeHtml(error.message)}</p>`;
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
    if (list) list.innerHTML = approvedEvents.length ? approvedEvents.map((event) => `
        <div class="event-card${event.status === 'archived' ? ' event-card-deleted' : ''}" data-category="${escapeHtml(categoryKey(event.category))}" data-event-search="${escapeHtml([event.title, event.description, event.category, event.location, event.volunteer_roles].filter(Boolean).join(' '))}">
            <div class="card-badge">${escapeHtml(event.category)}</div>
            ${event.event_images?.[0] ? `<img class="event-image" src="${supabaseClient.storage.from('event-images').getPublicUrl(event.event_images[0].storage_path).data.publicUrl}" alt="${escapeHtml(event.title)}">` : ''}
            <h3>${escapeHtml(event.title)}</h3>
            <p class="card-desc">${escapeHtml(event.description)}</p>
            <div class="card-meta">
                <span>📅 ${escapeHtml(event.event_date)}</span>
                <span>📍 ${escapeHtml(event.location)}</span>
            </div>
            ${event.volunteer_roles ? `<p class="event-roles"><strong>Lomas:</strong> ${escapeHtml(event.volunteer_roles)}</p>` : ''}
            ${event.status === 'archived' ? '<p class="event-deleted-message">Dzēsts, vairs nav pieejams.</p>' : `<a href="event.html?id=${encodeURIComponent(event.id)}" class="btn-card">Skatīt pasākumu</a><a href="report.html?event=${encodeURIComponent(event.id)}" class="text-button">Ziņot par pasākumu</a>`}
        </div>
    `).join('') : '';
    if (homeList) homeList.innerHTML = availableEvents.length ? availableEvents.slice(0, 2).map((event) => `
        <article class="home-event-card">
            <span class="event-kind">${escapeHtml(event.category)}</span>
            <p class="event-date">${escapeHtml(event.event_date)}</p>
            <h3>${escapeHtml(event.title)}</h3>
            <p>${escapeHtml(event.description)}</p>
            ${event.volunteer_roles ? `<p class="event-roles"><strong>Lomas:</strong> ${escapeHtml(event.volunteer_roles)}</p>` : ''}
            <div><span>${escapeHtml(event.location)}</span><a href="event.html?id=${encodeURIComponent(event.id)}" aria-label="Skatīt ${escapeHtml(event.title)}">→</a></div>
            <a href="report.html?event=${encodeURIComponent(event.id)}" class="text-button">Ziņot par pasākumu</a>
        </article>
    `).join('') : '<p class="no-results">Apstiprinātu pasākumu pašlaik nav.</p>';
    document.dispatchEvent(new Event('voluntio:events-rendered'));
}

function setupEventFilters() {
    const search = document.querySelector('#searchInput');
    const category = document.querySelector('#categoryFilter');
    const section = document.querySelector('.events-grid-section');
    if (!search || !category || !section) return;

    const normalize = (value) => String(value || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim();
    const list = section.querySelector('.custom-events-grid');
    const filterEvents = () => {
        const query = normalize(search.value.trim());
        const selectedCategory = normalize(category.value);
        let visibleCount = 0;
        list.querySelectorAll('.event-card').forEach((card) => {
            const searchableText = normalize(card.dataset.eventSearch || card.textContent);
            const cardCategory = normalize(card.dataset.category || '');
            const matchesSearch = !query || searchableText.includes(query);
            const matchesCategory = !selectedCategory || cardCategory === selectedCategory;
            card.hidden = !(matchesSearch && matchesCategory);
            if (!card.hidden) visibleCount += 1;
        });

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
    search.addEventListener('input', filterEvents);
    category.addEventListener('change', filterEvents);
    document.addEventListener('voluntio:events-rendered', filterEvents);
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
    form.elements.fullName.value = currentUser.profile?.full_name || '';
    form.elements.email.value = currentUser.email || '';
    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const { error } = await supabaseClient.rpc('update_my_profile', { new_full_name: form.elements.fullName.value.trim() });
        showFormMessage(error ? error.message : 'Profils atjaunināts.', Boolean(error));
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
    const deleteButton = document.querySelector('[data-show-delete-account]');
    const deleteForm = document.querySelector('[data-delete-account-form]');
    const deleteMessage = document.querySelector('[data-delete-account-message]');
    deleteButton?.addEventListener('click', () => {
        deleteButton.hidden = true;
        deleteForm.hidden = false;
        deleteForm.elements.password.focus();
    });
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
            options: { data: { full_name: `${firstName} ${lastName}`, first_name: firstName, last_name: lastName, phone: form.elements.phone.value.trim() } }
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
        button.addEventListener('click', () => {
            const input = button.parentElement.querySelector('input');
            const revealed = input.type === 'text';
            input.type = revealed ? 'password' : 'text';
            button.classList.toggle('is-revealed', !revealed);
            button.textContent = revealed ? 'Rādīt' : 'Slēpt';
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
    const sourceLanguage = activeLanguage;
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
    const items = [...textNodes.map((node) => ({ node, text: node.nodeValue })), ...attributes.map(({ element, attribute }) => ({ element, attribute, text: element.getAttribute(attribute) }))];

    // Larger parallel batches keep dense pages as responsive as the homepage,
    // without reintroducing separator artifacts into translated content.
    for (let index = 0; index < items.length; index += 24) {
        const batch = items.slice(index, index + 24);
        const results = await Promise.all(batch.map(async (item) => {
            const original = item.text.trim();
            return original ? translateWithApi(original, sourceLanguage, targetLanguage) : '';
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
    // Initialize local cards before any remote Supabase request.
    setupEventFilters();
    const currentUser = await getCurrentUser();
    if (!await guardPage(currentUser)) {
        return;
    }
    updateAuthLinks(currentUser);
    setupPagePreferences();
    setupNavigation();
    setupLoginForm();
    setupRegistrationForm();
    setupProfilePage(currentUser);
    setupEventForm();
    setupApplicationForm();
    setupReportForm();
    setupEventDetail();
    setupAdminRequests(currentUser);
    setupAdminDashboard(currentUser);
    setupAdminFilters();
    setupHomeSummary();
    renderCustomEvents();
    setupFooterLinks();
});
