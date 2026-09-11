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
    document.dispatchEvent(new Event('voluntio:events-rendered'));
}

function setupEventFilters() {
    const search = document.querySelector('#searchInput');
    const category = document.querySelector('#categoryFilter');
    if (!search || !category) return;

    const normalize = (value) => String(value).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const filterEvents = () => {
        const query = normalize(search.value.trim());
        const selectedCategory = category.value;
        document.querySelectorAll('.events-grid .event-card').forEach((card) => {
            const title = normalize(card.querySelector('h3')?.textContent || '');
            const cardCategory = normalize(card.dataset.category || card.querySelector('.card-badge')?.textContent || '');
            const matchesSearch = !query || title.includes(query);
            const matchesCategory = !selectedCategory || cardCategory.includes(selectedCategory);
            card.hidden = !(matchesSearch && matchesCategory);
        });
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
    document.querySelector('[data-forgot-password]')?.addEventListener('click', async () => {
        const email = form.elements.email.value.trim();
        if (!email) {
            setFieldError(form, 'email', 'Vispirms ievadi savu e-pasta adresi.');
            form.elements.email.focus();
            return;
        }
        const { error } = await supabaseClient.auth.resetPasswordForEmail(email, { redirectTo: `${window.location.origin}${window.location.pathname.replace('login.html', 'login.html')}` });
        showFormMessage(error ? error.message : 'Paroles atjaunošanas saite ir nosūtīta uz tavu e-pastu.', Boolean(error));
    });
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
    document.body.classList.toggle('dark-mode', darkMode);
    controls.innerHTML = `<button class="nav-preference" type="button" data-theme-toggle>${darkMode ? 'Gaišs' : 'Tumšs'}</button><button class="nav-preference" type="button" data-language-toggle>EN</button>`;
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
            button.textContent = targetLanguage === 'en' ? 'LV' : 'EN';
            document.documentElement.lang = targetLanguage;
        } catch (error) {
            showFormMessage('Tulkojumu pašlaik neizdevās ielādēt.', true);
            button.textContent = activeLanguage === 'lv' ? 'EN' : 'LV';
        } finally {
            button.disabled = false;
        }
    });
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
    const currentUser = await getCurrentUser();
    if (!await guardPage(currentUser)) {
        return;
    }
    updateAuthLinks(currentUser);
    setupPagePreferences();
    setupNavigation();
    setupLoginForm();
    setupRegistrationForm();
    setupEventForm();
    setupApplicationForm();
    setupAdminRequests(currentUser);
    setupEventFilters();
    renderCustomEvents();
    setupFooterLinks();
});
