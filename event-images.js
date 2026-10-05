// Crop edits stay local until the event and its image references are saved together.
function createEventImageEditor(input, preview, onBusyChange) {
    let images = [];
    let busy = false;
    let locked = false;
    const dialog = document.createElement('dialog');
    dialog.className = 'image-crop-dialog';
    dialog.setAttribute('aria-labelledby', 'crop-title');
    dialog.innerHTML = `<h2 id="crop-title">Apgriezt attēlu</h2>
        <p>Velc attēlu vai tā stūra rokturus, lai izvēlētos vajadzīgo laukumu.</p>
        <canvas width="900" height="600" aria-label="Apgrieztā attēla priekšskatījums"></canvas>
        <input class="crop-compat-control" data-crop-zoom type="range" min="1" max="3" step="0.01" value="1" tabindex="-1" aria-hidden="true">
        <input class="crop-compat-control" data-crop-x type="range" min="0" max="100" value="50" tabindex="-1" aria-hidden="true">
        <input class="crop-compat-control" data-crop-y type="range" min="0" max="100" value="50" tabindex="-1" aria-hidden="true">
        <div class="crop-actions"><button type="button" class="btn-card" data-crop-cancel>Atcelt</button>
        <button type="button" class="btn-primary" data-crop-apply>Lietot apgriezumu</button></div>`;
    document.body.append(dialog);
    const canvas = dialog.querySelector('canvas');
    const zoom = dialog.querySelector('[data-crop-zoom]');
    const x = dialog.querySelector('[data-crop-x]');
    const y = dialog.querySelector('[data-crop-y]');
    let activeImage;
    let decodedImage;
    let cropBox = { x: 100, y: 50, width: 700, height: 500 };
    let pointerAction;
    const minCropSize = 120;

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
        const scale = Math.max(target.width / image.naturalWidth, target.height / image.naturalHeight);
        const renderedWidth = image.naturalWidth * scale;
        const renderedHeight = image.naturalHeight * scale;
        const offsetX = (target.width - renderedWidth) / 2;
        const offsetY = (target.height - renderedHeight) / 2;
        const context = target.getContext('2d');
        context.fillStyle = '#fff';
        context.fillRect(0, 0, target.width, target.height);
        context.drawImage(image, offsetX, offsetY, renderedWidth, renderedHeight);
        if (target === canvas) {
            context.fillStyle = 'rgba(0, 0, 0, .52)';
            context.fillRect(0, 0, target.width, cropBox.y);
            context.fillRect(0, cropBox.y + cropBox.height, target.width, target.height - cropBox.y - cropBox.height);
            context.fillRect(0, cropBox.y, cropBox.x, cropBox.height);
            context.fillRect(cropBox.x + cropBox.width, cropBox.y, target.width - cropBox.x - cropBox.width, cropBox.height);
            context.strokeStyle = '#fff'; context.lineWidth = 4;
            context.strokeRect(cropBox.x, cropBox.y, cropBox.width, cropBox.height);
            context.fillStyle = '#fff';
            [[cropBox.x, cropBox.y], [cropBox.x + cropBox.width, cropBox.y],
                [cropBox.x, cropBox.y + cropBox.height], [cropBox.x + cropBox.width, cropBox.y + cropBox.height]]
                .forEach(([handleX, handleY]) => context.fillRect(handleX - 12, handleY - 12, 24, 24));
        }
    };
    const cropValues = () => ({ box: { ...cropBox } });
    const canvasPoint = (event) => { const bounds = canvas.getBoundingClientRect(); return {
        x: (event.clientX - bounds.left) * canvas.width / bounds.width,
        y: (event.clientY - bounds.top) * canvas.height / bounds.height
    }; };
    const handleAt = (point) => {
        const handles = { nw: [cropBox.x, cropBox.y], ne: [cropBox.x + cropBox.width, cropBox.y], sw: [cropBox.x, cropBox.y + cropBox.height], se: [cropBox.x + cropBox.width, cropBox.y + cropBox.height] };
        return Object.entries(handles).find(([, [handleX, handleY]]) => Math.hypot(point.x - handleX, point.y - handleY) < 30)?.[0] || null;
    };
    const insideCrop = (point) => point.x >= cropBox.x && point.x <= cropBox.x + cropBox.width && point.y >= cropBox.y && point.y <= cropBox.y + cropBox.height;
    const redrawCrop = () => { if (decodedImage) drawCrop(decodedImage, canvas, cropValues()); };
    canvas.addEventListener('pointerdown', (event) => {
        const point = canvasPoint(event); const handle = handleAt(point);
        if (!handle && !insideCrop(point)) return;
        pointerAction = { type: handle || 'move', point, box: { ...cropBox } };
        canvas.setPointerCapture(event.pointerId);
    });
    canvas.addEventListener('pointermove', (event) => {
        if (!pointerAction) return;
        const point = canvasPoint(event); const start = pointerAction; const dx = point.x - start.point.x; const dy = point.y - start.point.y;
        let next = { ...start.box };
        if (start.type === 'move') { next.x += dx; next.y += dy; }
        if (start.type.includes('n')) { next.y += dy; next.height -= dy; }
        if (start.type.includes('s')) next.height += dy;
        if (start.type.includes('w')) { next.x += dx; next.width -= dx; }
        if (start.type.includes('e')) next.width += dx;
        if (next.width >= minCropSize && next.height >= minCropSize) cropBox = next;
        cropBox.x = Math.max(0, Math.min(canvas.width - cropBox.width, cropBox.x));
        cropBox.y = Math.max(0, Math.min(canvas.height - cropBox.height, cropBox.y));
        redrawCrop();
    });
    canvas.addEventListener('pointerup', () => { pointerAction = null; });
    dialog.addEventListener('input', () => { if (decodedImage) redrawCrop(); });
    dialog.querySelector('[data-crop-cancel]').addEventListener('click', () => dialog.close());
    dialog.addEventListener('close', () => { activeImage = null; decodedImage = null; setBusy(false); });
    dialog.querySelector('[data-crop-apply]').addEventListener('click', () => {
        try {
            const output = document.createElement('canvas');
            output.width = 900; output.height = Math.max(1, Math.round(900 * cropBox.height / cropBox.width));
            const sourceScale = Math.max(canvas.width / decodedImage.naturalWidth, canvas.height / decodedImage.naturalHeight);
            const sourceX = (cropBox.x - (canvas.width - decodedImage.naturalWidth * sourceScale) / 2) / sourceScale;
            const sourceY = (cropBox.y - (canvas.height - decodedImage.naturalHeight * sourceScale) / 2) / sourceScale;
            const sourceWidth = cropBox.width / sourceScale;
            const sourceHeight = cropBox.height / sourceScale;
            output.getContext('2d').drawImage(decodedImage, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, output.width, output.height);
            activeImage.crop = cropValues();
            activeImage.preview = output.toDataURL('image/jpeg', 0.86);
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
            cropBox = activeImage.crop?.box || { x: 100, y: 50, width: 700, height: 500 };
            zoom.value = 1; x.value = 50; y.value = 50;
            redrawCrop();
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
