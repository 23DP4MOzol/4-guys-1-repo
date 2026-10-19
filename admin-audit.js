function setupAdminAudit() {
    const dialog = document.querySelector('[data-audit-dialog]');
    if (!dialog) return;
    const list = dialog.querySelector('[data-user-audit]');
    const status = dialog.querySelector('[data-audit-status]');
    const more = dialog.querySelector('[data-audit-more]');
    const clear = dialog.querySelector('[data-audit-clear]');
    const titles = { events: 'Pasākums', event_applications: 'Pieteikums', event_messages: 'Čata ziņa', profiles: 'Profils', reports: 'Ziņojums', event_participant: 'Dalībnieks', audit: 'Audita žurnāls' };
    const actions = { INSERT: 'Izveidoja', UPDATE: 'Mainīja', DELETE: 'Dzēsa', event_participant_mute: 'Apklusināja dalībnieku', event_participant_unmute: 'Atļāva rakstīt čatā', event_participant_kick: 'Noņēma dalībnieku', cleared_user_audit: 'Notīrīja lietotāja žurnālu' };
    const fieldLabels = { title: 'nosaukumu', status: 'statusu', event_date: 'datumu', location: 'atrašanās vietu', description: 'aprakstu', role: 'lomu', is_banned: 'bloķēšanas statusu', banned_until: 'bloķēšanas termiņu', priority: 'prioritāti' };
    const overviewList = document.querySelector('[data-audit-overview-list]');
    const overviewCount = document.querySelector('[data-audit-overview-count]');
    const formatDetails = details => {
        if (!details || typeof details !== 'object') return 'Darbība veikta.';
        const parts = [];
        if (details.title) parts.push(`Nosaukums: ${details.title}`);
        if (details.status_from || details.status_to) parts.push(`Statuss: ${details.status_from || '—'} → ${details.status_to || '—'}`);
        if (details.role_from || details.role_to) parts.push(`Loma: ${details.role_from || '—'} → ${details.role_to || '—'}`);
        if (Array.isArray(details.changed_fields) && details.changed_fields.length) {
            parts.push(`Mainīts: ${details.changed_fields.map(field => fieldLabels[field] || 'dati').join(', ')}`);
        }
        if (details.deleted_count !== undefined) parts.push(`Notīrīto ierakstu skaits: ${details.deleted_count}`);
        if (details.reason) parts.push(`Iemesls: ${details.reason}`);
        return parts.join(' · ') || 'Darbība veikta.';
    };
    const renderOverview = async () => {
        if (!overviewList) return;
        const { data, error } = await supabaseClient.from('audit_logs').select('id, actor_id, action, entity_type, details, created_at')
            .order('created_at', { ascending: false }).order('id', { ascending: false }).range(0, 49);
        if (error) {
            overviewList.innerHTML = `<tr><td colspan="5">${escapeHtml(`Žurnālu neizdevās ielādēt: ${error.message}`)}</td></tr>`;
            return;
        }
        const logs = data || [];
        overviewCount.textContent = `${logs.length} ieraksti`;
        overviewList.innerHTML = logs.length ? logs.map(log => `<tr><td>${escapeHtml(new Date(log.created_at).toLocaleString('lv-LV', { timeZone: 'Europe/Riga' }))}</td>
            <td title="${escapeHtml(log.actor_id || '')}">${escapeHtml(log.actor_id ? `${log.actor_id.slice(0, 8)}...` : 'Sistēma')}</td>
            <td>${escapeHtml(actions[log.action] || log.action || 'Mainīja datus')}</td><td>${escapeHtml(titles[log.entity_type] || log.entity_type || 'Sistēmas objekts')}</td>
            <td>${escapeHtml(formatDetails(log.details))}</td></tr>`).join('') : '<tr><td colspan="5">Darbību nav.</td></tr>';
    };
    renderOverview().catch(error => { if (overviewList) overviewList.innerHTML = `<tr><td colspan="5">${escapeHtml(error.message)}</td></tr>`; });
    let selectedUser;
    let offset = 0;
    let generation = 0;
    let busy = false;
    const load = async (reset = false) => {
        const request = ++generation;
        const user = selectedUser;
        if (reset) { offset = 0; list.innerHTML = ''; }
        busy = true; more.disabled = true; clear.disabled = true;
        status.textContent = 'Ielādē darbības...';
        try {
            const { data, error } = await supabaseClient.from('audit_logs').select('id, action, entity_type, entity_id, details, created_at')
                .eq('actor_id', user).gte('created_at', new Date(Date.now() - 14 * 86400000).toISOString())
                .order('created_at', { ascending: false }).order('id', { ascending: false }).range(offset, offset + 49);
            if (request !== generation) return;
            if (error) throw error;
            const logs = data || [];
            list.insertAdjacentHTML('beforeend', logs.map(log => `<tr><td>${escapeHtml(new Date(log.created_at).toLocaleString('lv-LV', { timeZone: 'Europe/Riga' }))}</td>
                <td>${escapeHtml(actions[log.action] || 'Mainīja datus')}</td><td>${escapeHtml(titles[log.entity_type] || 'Sistēmas objekts')}</td>
                <td>${escapeHtml(formatDetails(log.details))}</td></tr>`).join(''));
            offset += logs.length;
            more.hidden = logs.length < 50;
            status.textContent = offset ? `Parādītas ${offset} darbības.` : 'Pēdējās 14 dienās darbību nav.';
        } catch (error) { if (request === generation) status.textContent = `Žurnālu neizdevās ielādēt: ${error.message}`; }
        finally { if (request === generation) { busy = false; more.disabled = false; clear.disabled = false; } }
    };
    document.addEventListener('click', event => {
        const button = event.target.closest('[data-user-audit-id]');
        if (!button) return;
        selectedUser = button.dataset.userAuditId;
        dialog.querySelector('[data-audit-user]').textContent = button.dataset.userAuditName;
        dialog.showModal(); load(true);
    });
    dialog.querySelector('[data-audit-close]').addEventListener('click', () => dialog.close());
    dialog.addEventListener('close', () => { generation++; });
    more.addEventListener('click', () => { if (!busy) load(); });
    clear.addEventListener('click', async () => {
        if (busy || !window.confirm('Neatgriezeniski dzēst šī lietotāja audita ierakstus?')) return;
        busy = true; clear.disabled = true; more.disabled = true;
        const user = selectedUser;
        try {
            const { error } = await supabaseClient.rpc('admin_clear_user_audit', { target_user_id: user });
            if (error) throw error;
            if (selectedUser === user) await load(true);
        } catch (error) { status.textContent = `Žurnālu neizdevās notīrīt: ${error.message}`; }
        finally { busy = false; clear.disabled = false; more.disabled = false; }
    });
}
document.addEventListener('DOMContentLoaded', setupAdminAudit);
