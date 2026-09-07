const supabaseClient = window.voluntioSupabase;

async function getCurrentUser() {
    const { data: { user } } = await supabaseClient.auth.getUser();
    if (!user) {
        return null;
    }

    const { data: profile } = await supabaseClient
        .from('profiles')
        .select('id, full_name, role')
        .eq('id', user.id)
        .single();

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

    document.querySelectorAll('a[href="admin.html"]').forEach((link) => {
        link.closest('li')?.classList.toggle('hidden-nav-item', !isAdmin);
    });

    if (!authButtons || !currentUser) {
        return;
    }

    const displayName = currentUser.profile?.full_name || currentUser.email.split('@')[0];
    authButtons.innerHTML = `
        <span class="user-greeting">Sveiks, ${escapeHtml(displayName)}</span>
        <button class="btn-login logout-button" type="button">Iziet</button>
    `;

    authButtons.querySelector('.logout-button').addEventListener('click', async () => {
        await supabaseClient.auth.signOut();
        window.location.href = 'index.html';
    });
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

    if (!form || !input || !preview) {
        return;
    }

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

        const { data: eventRecord, error } = await supabaseClient.from('events').insert({
            creator_id: currentUser.id,
            title: form.elements.title.value.trim(),
            category: form.elements.category.value,
            event_date: form.elements.date.value,
            location: form.elements.location.value.trim(),
            volunteer_roles: form.elements.roles.value.trim(),
            description: form.elements.description.value.trim(),
            status: 'pending'
        }).select('id').single();

        if (error) {
            showFormMessage(`Neizdevās iesniegt pasākumu: ${error.message}`, true);
            return;
        }

        for (let index = 0; index < croppedImages.length; index += 1) {
            const path = `${currentUser.id}/${eventRecord.id}/${index + 1}.jpg`;
            const upload = await supabaseClient.storage.from('event-images').upload(path, dataUrlToBlob(croppedImages[index]), {
                contentType: 'image/jpeg',
                upsert: false
            });
            if (upload.error) {
                showFormMessage(`Attēla augšupielāde neizdevās: ${upload.error.message}`, true);
                return;
            }
            const imageRecord = await supabaseClient.from('event_images').insert({
                event_id: eventRecord.id,
                storage_path: path,
                sort_order: index
            });
            if (imageRecord.error) {
                showFormMessage(`Attēla saglabāšana neizdevās: ${imageRecord.error.message}`, true);
                return;
            }
        }

        showFormMessage('Pasākuma pieprasījums nosūtīts adminam apstiprināšanai.');
        form.reset();
        preview.innerHTML = '';
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
        .select('id, title, event_date')
        .eq('status', 'approved')
        .order('event_date', { ascending: true });

    if (error) {
        showFormMessage(error.message, true);
        return;
    }

    select.innerHTML = events.length
        ? events.map((event) => `<option value="${event.id}">${escapeHtml(event.title)} - ${escapeHtml(event.event_date)}</option>`).join('')
        : '<option value="">Nav pieejamu pasākumu</option>';

    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const currentUser = await getCurrentUser();
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
        .select('id, title, event_date, creator_id, profiles(full_name), event_images(id)')
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
            <td><button class="table-button" type="button" data-approve-event="${request.id}">Apstiprināt</button></td>
        </tr>
    `).join('') : '<tr><td colspan="5">Jaunu pasākumu pieprasījumu nav.</td></tr>';

    list.querySelectorAll('[data-approve-event]').forEach((button) => {
        button.addEventListener('click', async () => {
            const { error: updateError } = await supabaseClient.from('events').update({
                status: 'approved',
                reviewed_by: currentUser.id,
                reviewed_at: new Date().toISOString()
            }).eq('id', button.dataset.approveEvent);
            if (updateError) {
                showFormMessage(updateError.message, true);
                return;
            }
            setupAdminRequests(currentUser);
        });
    });
}

async function renderCustomEvents() {
    const list = document.querySelector('[data-custom-events]');
    if (!list) {
        return;
    }

    const { data: approvedEvents, error } = await supabaseClient
        .from('events')
        .select('id, title, category, event_date, location, description, event_images(storage_path)')
        .eq('status', 'approved')
        .order('event_date', { ascending: true });

    if (error) {
        list.innerHTML = `<p>${escapeHtml(error.message)}</p>`;
        return;
    }

    list.innerHTML = approvedEvents.map((event) => `
        <div class="event-card">
            <div class="card-badge">${escapeHtml(event.category)}</div>
            ${event.event_images?.[0] ? `<img class="event-image" src="${supabaseClient.storage.from('event-images').getPublicUrl(event.event_images[0].storage_path).data.publicUrl}" alt="${escapeHtml(event.title)}">` : ''}
            <h3>${escapeHtml(event.title)}</h3>
            <p class="card-desc">${escapeHtml(event.description)}</p>
            <div class="card-meta">
                <span>📅 ${escapeHtml(event.event_date)}</span>
                <span>📍 ${escapeHtml(event.location)}</span>
            </div>
            <a href="pieteikties.html" class="btn-card">Pieteikties dalībai</a>
        </div>
    `).join('');
}

function setupLoginForm() {
    const form = document.querySelector('[data-login-form]');

    if (!form) {
        return;
    }

    form.addEventListener('submit', async (event) => {
        event.preventDefault();
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

function setupRegistrationForm() {
    const form = document.querySelector('[data-registration-form]');

    if (!form) {
        return;
    }

    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const { error } = await supabaseClient.auth.signUp({
            email: form.elements.email.value.trim(),
            password: form.elements.password.value,
            options: { data: { full_name: form.elements.name.value.trim() } }
        });
        if (error) {
            showFormMessage(error.message, true);
            return;
        }
        showFormMessage('Konts izveidots. Pārbaudi e-pastu, lai apstiprinātu kontu.');
    });
}

document.addEventListener('DOMContentLoaded', async () => {
    const currentUser = await getCurrentUser();
    if (!await guardPage(currentUser)) {
        return;
    }
    updateAuthLinks(currentUser);
    setupLoginForm();
    setupRegistrationForm();
    setupEventForm();
    setupApplicationForm();
    setupAdminRequests(currentUser);
    renderCustomEvents();
});
