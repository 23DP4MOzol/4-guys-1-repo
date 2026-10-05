// Crop edits stay local until the event and its image references are saved together.
function createEventImageEditor(input, preview, onBusyChange) {
    let images = [];
    let busy = false;
    let locked = false;
    const dialog = document.createElement('dialog');
    dialog.className = 'image-crop-dialog';
    dialog.setAttribute('aria-labelledby', 'crop-title');
    dialog.innerHTML = `<h2 id="crop-title">Apgriezt attēlu</h2>
        <p>Izvēlies palielinājumu un attēla novietojumu.</p>
        <canvas width="900" height="600" aria-label="Apgrieztā attēla priekšskatījums"></canvas>
        <label>Palielinājums <input data-crop-zoom type="range" min="1" max="3" step="0.01" value="1"></label>
        <label>Horizontāli <input data-crop-x type="range" min="0" max="100" value="50"></label>
        <label>Vertikāli <input data-crop-y type="range" min="0" max="100" value="50"></label>
        <div class="crop-actions"><button type="button" class="btn-card" data-crop-cancel>Atcelt</button>
        <button type="button" class="btn-primary" data-crop-apply>Lietot apgriezumu</button></div>`;
    document.body.append(dialog);
    const canvas = dialog.querySelector('canvas');
    const zoom = dialog.querySelector('[data-crop-zoom]');
    const x = dialog.querySelector('[data-crop-x]');
    const y = dialog.querySelector('[data-crop-y]');
    let activeImage;
    let decodedImage;

    const updateControls = () => {
        input.disabled = busy || locked || images.length >= 5;
        preview.querySelectorAll('button').forEach((button) => { button.disabled = busy || locked; });
    };
    const setBusy = (value) => { busy = value; updateControls(); onBusyChange(value); };
    const render = () => {
        preview.innerHTML = images.map((image, index) => `<div class="image-preview-item">
            <img src="${escapeHtml(image.preview)}" alt="Pasākuma attēls ${index + 1}" width="900" height="600">
            <span>Attēls ${index + 1}</span><div class="image-preview-actions">
            <button type="button" class="btn-card" data-crop-image="${index}">Apgriezt</button>
            <button type="button" class="text-button" data-remove-image="${index}">Noņemt</button></div></div>`).join('');
        updateControls();
    };
    const decode = (source) => new Promise((resolve, reject) => {
        const image = new Image();
        if (!source.startsWith('blob:') && !source.startsWith('data:')) image.crossOrigin = 'anonymous';
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error('Attēlu neizdevās atvērt. Izvēlies derīgu JPG, PNG vai WebP failu.'));
        image.src = source;
    });
    const drawCrop = (image, target, crop) => {
        const scale = Math.max(target.width / image.naturalWidth, target.height / image.naturalHeight) * crop.zoom;
        const sourceWidth = target.width / scale;
        const sourceHeight = target.height / scale;
        const context = target.getContext('2d');
        context.fillStyle = '#fff';
        context.fillRect(0, 0, target.width, target.height);
        context.drawImage(image, (image.naturalWidth - sourceWidth) * crop.x / 100,
            (image.naturalHeight - sourceHeight) * crop.y / 100, sourceWidth, sourceHeight,
            0, 0, target.width, target.height);
    };
    const cropValues = () => ({ zoom: Number(zoom.value), x: Number(x.value), y: Number(y.value) });
    dialog.addEventListener('input', () => { if (decodedImage) drawCrop(decodedImage, canvas, cropValues()); });
    dialog.querySelector('[data-crop-cancel]').addEventListener('click', () => dialog.close());
    dialog.addEventListener('close', () => { activeImage = null; decodedImage = null; setBusy(false); });
    dialog.querySelector('[data-crop-apply]').addEventListener('click', () => {
        try {
            activeImage.crop = cropValues();
            activeImage.preview = canvas.toDataURL('image/jpeg', 0.86);
            activeImage.dataUrl = activeImage.preview;
            render();
            dialog.close();
        } catch (error) { showFormMessage(error.message, true); }
    });
    preview.addEventListener('click', async (event) => {
        if (busy || locked) return;
        const remove = event.target.closest('[data-remove-image]');
        if (remove) {
            const [removed] = images.splice(Number(remove.dataset.removeImage), 1);
            if (removed.source.startsWith('blob:')) URL.revokeObjectURL(removed.source);
            render();
            return;
        }
        const button = event.target.closest('[data-crop-image]');
        if (!button) return;
        setBusy(true);
        try {
            activeImage = images[Number(button.dataset.cropImage)];
            decodedImage = await decode(activeImage.source);
            const crop = activeImage.crop || { zoom: 1, x: 50, y: 50 };
            zoom.value = crop.zoom; x.value = crop.x; y.value = crop.y;
            drawCrop(decodedImage, canvas, crop);
            dialog.showModal();
        } catch (error) { setBusy(false); showFormMessage(error.message, true); }
    });
    input.addEventListener('change', async () => {
        if (busy || locked) return;
        const files = [...input.files];
        input.value = '';
        if (!files.length) return;
        if (images.length + files.length > 5) {
            showFormMessage('Pasākumam drīkst pievienot ne vairāk kā 5 attēlus.', true);
            return;
        }
        if (files.some((file) => !['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 10 * 1024 * 1024)) {
            showFormMessage('Izvēlies JPG, PNG vai WebP attēlus līdz 10 MB.', true);
            return;
        }
        setBusy(true);
        const added = [];
        try {
            for (const file of files) {
                const source = URL.createObjectURL(file);
                const image = { file, source, preview: source, crop: { zoom: 1, x: 50, y: 50 } };
                added.push(image);
                await decode(image.source);
                images.push(image);
                render();
            }
            showFormMessage('Attēli ir gatavi. Vari tos apgriezt pirms pasākuma saglabāšanas.');
        } catch (error) {
            images = images.filter((image) => !added.includes(image));
            render();
            added.forEach((image) => URL.revokeObjectURL(image.source));
            showFormMessage(error.message, true);
        } finally { setBusy(false); }
    });
    return {
        getImages: () => images,
        isBusy: () => busy,
        setLocked(value) { locked = value; updateControls(); },
        load(records) {
            images = [...records].sort((a, b) => a.sort_order - b.sort_order).map((record) => {
                const source = window.voluntioSupabase.storage.from('event-images').getPublicUrl(record.storage_path).data.publicUrl;
                return { storagePath: record.storage_path, source, preview: source };
            });
            render();
        }
    };
}

async function saveEventWithImages(client, userId, eventId, payload, images, originalPaths) {
    const bucket = client.storage.from('event-images');
    const uploaded = [];
    const paths = [];
    let commitRequested = false;
    try {
        for (const image of images) {
            if (!image.dataUrl) { paths.push(image.storagePath); continue; }
            const path = `${userId}/${eventId}/${crypto.randomUUID()}.jpg`;
            const uploadBody = image.dataUrl ? dataUrlToBlob(image.dataUrl) : image.file;
            const { error } = await bucket.upload(path, uploadBody, { contentType: image.dataUrl ? 'image/jpeg' : image.file.type, upsert: false });
            if (error) throw error;
            uploaded.push(path);
            paths.push(path);
        }
        commitRequested = true;
        const { data, error } = await client.rpc('save_event_with_images', {
            target_event_id: eventId, event_data: payload, image_paths: paths
        });
        if (error) {
            // A database error guarantees rollback. A lost network response does not.
            if (error.code && !String(error.code).startsWith('08')) commitRequested = false;
            if (error.code === 'PGRST202') throw new Error('Datubāzei nepieciešams atjauninājums: izpildi supabase-all.sql Supabase SQL redaktorā.');
            throw error;
        }
        if (data !== eventId) throw new Error('Neizdevās apstiprināt saglabāšanu. Mēģini vēlreiz.');
        const obsolete = originalPaths.filter((path) => !paths.includes(path));
        // The database is already committed; a storage cleanup failure must not undo it.
        if (obsolete.length) {
            try { await bucket.remove(obsolete); } catch (error) { console.warn('Unused image cleanup failed', error); }
        }
        return data;
    } catch (error) {
        if (!commitRequested && uploaded.length) {
            try { await bucket.remove(uploaded); } catch (cleanupError) { console.warn('Image cleanup failed', cleanupError); }
        }
        throw error;
    }
}
