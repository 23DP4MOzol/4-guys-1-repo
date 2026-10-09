function setupEventChat(event, user) {
    const list = document.querySelector('[data-chat-list]');
    const form = document.querySelector('[data-chat-form]');
    const notice = document.querySelector('[data-chat-notice]');
    const status = document.querySelector('[data-chat-status]');
    if (!list || !form) return;
    let refreshing = false;
    let sending = false;
    let stopped = false;
    let loadFailed = false;
    const say = (text, error = false) => { status.textContent = text; status.classList.toggle('form-error', error); };
    const reasons = {
        sign_in: 'Pieslēdzies un pievienojies pasākumam, lai izmantotu čatu.',
        pending: 'Tu jau esi pieteicies. Čats būs pieejams pēc organizatora apstiprinājuma.',
        not_joined: 'Pievienojies pasākumam un sagaidi apstiprinājumu, lai izmantotu čatu.',
        rejected: 'Dalība nav apstiprināta vai ir pārtraukta. Čats nav pieejams.',
        muted: 'Nevar rakstīt pasākuma čatā - organizators ir apklusinājis tavu kontu. Ziņas joprojām vari lasīt.',
        ended: 'Pasākums ir beidzies vai atcelts. Tā čats ir slēgts un ziņas tiek dzēstas.'
    };
    form.hidden = true;
    const refresh = async () => {
        if (refreshing || stopped) return;
        refreshing = true;
        try {
            const result = user ? await supabaseClient.rpc('event_chat_access', { target_event_id: event.id })
                : { data: { can_read: false, can_write: false, reason: 'sign_in' } };
            if (result.error) throw result.error;
            if (stopped) return;
            if (loadFailed) { say(''); loadFailed = false; }
            const access = result.data;
            form.hidden = !access.can_write;
            notice.hidden = access.can_write;
            notice.textContent = reasons[access.reason] || '';
            if (!access.can_read) { list.innerHTML = ''; return; }
            const { data, error } = await supabaseClient.from('event_messages')
                .select('id, sender_id, message, created_at, profiles!event_messages_sender_id_fkey(full_name, avatar_path)')
                .eq('event_id', event.id).order('created_at', { ascending: false }).limit(100);
            if (error) throw error;
            if (stopped) return;
            const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 60;
            list.innerHTML = [...(data || [])].reverse().map(message => `<div class="chat-message">
                ${profileAvatarMarkup(message.profiles, 'event-person-avatar', message.profiles?.full_name)}
                <div class="chat-message-copy"><strong>${escapeHtml(message.profiles?.full_name || 'Lietotājs')}</strong>
                <time datetime="${escapeHtml(message.created_at)}">${escapeHtml(new Date(message.created_at).toLocaleString('lv-LV', { timeZone: 'Europe/Riga' }))}</time>
                <p>${escapeHtml(message.message)}</p></div>
                ${user?.id === event.creator_id ? `<button class="chat-delete" type="button" data-delete-message="${escapeHtml(message.id)}">Dzēst</button>` : ''}</div>`).join('') || '<p>Šeit vēl nav ziņu. Sāc sarunu!</p>';
            if (atBottom) list.scrollTop = list.scrollHeight;
        } catch (error) {
            loadFailed = true;
            form.hidden = true;
            list.innerHTML = '';
            say(`Čatu neizdevās ielādēt: ${error.message}`, true);
        } finally { refreshing = false; }
    };
    list.addEventListener('click', async (event) => {
        const button = event.target.closest('[data-delete-message]');
        if (!button || !window.confirm('Vai dzēst šo ziņu?')) return;
        button.disabled = true;
        try {
            const { error } = await supabaseClient.from('event_messages').delete().eq('id', button.dataset.deleteMessage);
            if (error) throw error;
            say('Ziņa dzēsta.'); await refresh();
        } catch (error) { button.disabled = false; say(`Ziņu neizdevās dzēst: ${error.message}`, true); }
    });
    form.addEventListener('submit', async (submitEvent) => {
        submitEvent.preventDefault();
        if (sending || form.hidden) return;
        const message = form.elements.message.value.trim();
        if (!message || message.length > 1000) { say('Ievadi ziņu no 1 līdz 1000 rakstzīmēm.', true); return; }
        sending = true;
        const button = form.querySelector('button'); button.disabled = true;
        try {
            const { error } = await supabaseClient.from('event_messages').insert({ event_id: event.id, sender_id: user.id, message });
            if (error) throw error;
            form.reset(); say('Ziņa nosūtīta.'); await refresh();
        } catch (error) { say(`Ziņu neizdevās nosūtīt: ${error.message}`, true); await refresh(); }
        finally { sending = false; button.disabled = false; }
    });
    const channel = supabaseClient.channel(`event-chat-${event.id}`)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'event_messages', filter: `event_id=eq.${event.id}` }, refresh)
        .subscribe();
    // Polling also catches approvals, muting, expiry and deployments without Realtime enabled.
    const timer = window.setInterval(() => { if (!document.hidden) refresh(); }, 10000);
    const onVisible = () => { if (!document.hidden) refresh(); };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('pagehide', () => {
        stopped = true; clearInterval(timer); document.removeEventListener('visibilitychange', onVisible);
        supabaseClient.removeChannel(channel);
    }, { once: true });
    return refresh();
}
