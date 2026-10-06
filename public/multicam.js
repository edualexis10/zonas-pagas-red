const MAX_CAMERAS = 8;
const CHUNK_SIZE = 4 * 1024 * 1024; // 4 MB
const MIN_CHUNK_SIZE = 256 * 1024;
const NATIVE_TIMEOUT_MS = 6000;
const FRAME_STEP = 1 / 25;
// Extensiones que los navegadores no reproducen: se convierten en el servidor
// directamente, sin intentar abrirlas antes.
const SERVER_ONLY_EXT = ['avi', 'dav', '264', 'h264', '265', 'h265', 'hevc', 'flv', 'wmv', 'asf', 'mpg', 'mpeg', 'vob', 'ts', 'mts', 'm2ts', '3gp'];
const PREVIEW_FORMAT = document.createElement('video').canPlayType('video/mp4; codecs="avc1.42E01E"')
  ? 'mp4'
  : 'webm';
const AUDIO_ALL = -2;
const AUTO_LAYOUTS = [[1, 1], [1, 1], [2, 1], [2, 2], [2, 2], [3, 2], [3, 2], [4, 2], [4, 2]];

const $ = (id) => document.getElementById(id);
const gridEl = $('grid');
const fileInput = $('file-input');
const playBtn = $('play-btn');
const timeline = $('timeline');
const timeLabel = $('time-label');
const speedSelect = $('speed-select');
const fillCheck = $('fill-check');
const audioSelect = $('audio-select');
const mergeBtn = $('merge-btn');

let slots = []; // { id, file, sourceUrl, name, delay, duration, ready, video, tile, statusEl, url, objectUrl, fileIdPromise, audio }
let nextId = 1;
let clock = 0; // tiempo del visor (s); cada cámara muestra clock - delay
let playing = false;
let rate = 1;
let lastFrameTs = null;
let lastSync = 0;
let focusedId = null;
let layoutChoice = 'auto'; // 'auto' o 'CxR' (número de pantallas elegido)
let page = 0; // página de cámaras cuando hay más cámaras que pantallas
let pendingTarget = null; // índice de celda vacía donde agregar el próximo video

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

function formatTime(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(sec).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function extOf(name) {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
}

async function readJson(response) {
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    const err = new Error(`HTTP ${response.status}`);
    err.status = response.status;
    throw err;
  }
  const data = await response.json();
  if (!response.ok) {
    const err = new Error(data.error || `HTTP ${response.status}`);
    err.status = response.status;
    throw err;
  }
  return data;
}

function postJson(url, body) {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then(readJson);
}

function triggerDownload(url, fileName) {
  const a = $('download-helper');
  a.href = url;
  a.download = fileName || '';
  a.click();
}

// ---------------------------------------------------------------------------
// Subida en fragmentos (igual que el conversor: evita límites del proxy)
// ---------------------------------------------------------------------------

async function uploadStored(file, onProgress) {
  const { uploadId } = await postJson('/api/upload/init', { fileName: file.name, purpose: 'store' });
  let sent = 0;
  let fileId = null;

  async function sendRange(start, end, isLast) {
    const size = end - start;
    try {
      const formData = new FormData();
      formData.append('uploadId', uploadId);
      formData.append('isLast', String(isLast));
      formData.append('chunk', file.slice(start, end));
      const result = await fetch('/api/upload/chunk', { method: 'POST', body: formData }).then(readJson);
      sent += size;
      onProgress(Math.min(99, Math.round((sent / file.size) * 100)));
      if (result.done) fileId = result.fileId;
    } catch (err) {
      if (size <= MIN_CHUNK_SIZE || (err.status && err.status < 500 && err.status !== 413)) throw err;
      const mid = start + Math.floor(size / 2);
      await sendRange(start, mid, false);
      await sendRange(mid, end, isLast);
    }
  }

  if (file.size === 0) throw new Error('El archivo está vacío.');
  for (let offset = 0; offset < file.size; offset += CHUNK_SIZE) {
    const end = Math.min(offset + CHUNK_SIZE, file.size);
    await sendRange(offset, end, end >= file.size);
  }
  return fileId;
}

// Sube el original una sola vez y reutiliza el id (vista previa + mosaico).
function ensureUploaded(slot, onProgress) {
  if (!slot.fileIdPromise) {
    const task = slot.sourceUrl ? importUrl(slot, onProgress) : uploadStored(slot.file, onProgress);
    slot.fileIdPromise = task.catch((err) => {
      slot.fileIdPromise = null;
      throw err;
    });
  }
  return slot.fileIdPromise;
}

// El servidor descarga el video del enlace (Drive, Dropbox, directo).
async function importUrl(slot, onProgress) {
  const { jobId } = await postJson('/api/import', { url: slot.sourceUrl });
  const job = await waitForJob(jobId, (j) => {
    if (j.status === 'processing') onProgress(j.progress, j.bytes);
  });
  if (!slot.keepName && job.originalName && job.originalName !== slot.name) {
    slot.name = job.originalName;
    if (slot.labelEl) slot.labelEl.lastChild.textContent = slot.name;
  }
  return job.fileId;
}

function waitForJob(jobId, onProgress) {
  return new Promise((resolve, reject) => {
    const timer = setInterval(async () => {
      try {
        const job = await fetch(`/api/jobs/${jobId}`).then(readJson);
        if (job.status === 'done') {
          clearInterval(timer);
          resolve(job);
        } else if (job.status === 'error') {
          clearInterval(timer);
          reject(new Error(job.error || 'Error al procesar.'));
        } else {
          onProgress(job);
        }
      } catch (err) {
        clearInterval(timer);
        reject(err);
      }
    }, 800);
  });
}

// ---------------------------------------------------------------------------
// Cámaras
// ---------------------------------------------------------------------------

function addFiles(fileList) {
  const files = Array.from(fileList).filter((f) => f && f.size !== undefined);
  addSources(files.map((file) => ({ file, name: file.name })));
}

const FOLDER_RE = /drive\.google\.com\/(?:drive\/(?:u\/\d+\/)?folders\/|embeddedfolderview\?id=)/;

async function addUrls(text) {
  const urls = String(text)
    .split(/[\s,]+/)
    .map((u) => u.trim())
    .filter((u) => /^https?:\/\//i.test(u));
  const folders = urls.filter((u) => FOLDER_RE.test(u));
  const videos = urls.filter((u) => !FOLDER_RE.test(u));
  addSources(videos.map((url) => ({ sourceUrl: url, name: nameFromUrl(url) })));

  for (const folderUrl of folders) {
    await addFolder(folderUrl);
  }
  return urls.length;
}

// Carpeta de Drive: se listan sus videos y se reparten en las cámaras. Si son
// más de los que caben, se deja elegir cuáles cargar.
async function addFolder(folderUrl) {
  const submit = $('link-form').querySelector('button');
  submit.disabled = true;
  submit.textContent = 'Leyendo carpeta…';
  try {
    const { files } = await postJson('/api/folder', { url: folderUrl });
    const free = MAX_CAMERAS - slots.length;
    if (free <= 0) {
      alert(`Ya hay ${MAX_CAMERAS} cámaras cargadas. Quita alguna para agregar más.`);
      return;
    }
    const chosen = files.length <= free ? files : await pickFolderFiles(files, free);
    if (chosen.length) {
      addSources(chosen.map((f) => ({ sourceUrl: f.url, name: f.name, keepName: true })));
      if (layoutChoice !== 'auto' && chosen.length > 1) {
        // Ajusta las pantallas a la cantidad cargada.
        layoutChoice = 'auto';
        render();
      }
    }
  } catch (err) {
    alert(`No se pudo leer la carpeta: ${err.message}`);
  } finally {
    submit.disabled = false;
    submit.textContent = 'Cargar enlaces';
  }
}

function pickFolderFiles(files, max) {
  return new Promise((resolve) => {
    const modal = $('folder-modal');
    const list = $('folder-list');
    const addBtn = $('folder-add');
    list.innerHTML = '';
    files.forEach((file, i) => {
      const li = document.createElement('li');
      li.innerHTML = `<label><input type="checkbox" value="${i}" ${i < max ? 'checked' : ''} /> <span></span></label>`;
      li.querySelector('span').textContent = file.name;
      list.appendChild(li);
    });
    const checks = Array.from(list.querySelectorAll('input'));
    const update = () => {
      const n = checks.filter((c) => c.checked).length;
      $('folder-hint').textContent = `La carpeta tiene ${files.length} videos y caben ${max}. Elige cuáles ver (${n} de ${max}).`;
      checks.forEach((c) => {
        c.disabled = !c.checked && n >= max;
      });
      addBtn.disabled = n === 0;
    };
    list.onchange = update;
    update();
    modal.hidden = false;

    const close = (result) => {
      modal.hidden = true;
      $('folder-cancel').onclick = null;
      addBtn.onclick = null;
      resolve(result);
    };
    $('folder-cancel').onclick = () => close([]);
    addBtn.onclick = () => close(checks.filter((c) => c.checked).map((c) => files[Number(c.value)]));
  });
}

function nameFromUrl(url) {
  try {
    const u = new URL(url);
    const last = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || '');
    if (/\.[a-z0-9]{2,5}$/i.test(last)) return last;
    return `${u.hostname.replace(/^www\./, '')} (enlace)`;
  } catch {
    return 'enlace';
  }
}

function addSources(sources) {
  const free = MAX_CAMERAS - slots.length;
  if (sources.length > free) {
    alert(`Solo caben ${MAX_CAMERAS} cámaras. Se agregarán ${Math.max(0, free)} de ${sources.length} videos.`);
  }
  sources.slice(0, Math.max(0, free)).forEach((source) => {
    const slot = createSlot(source);
    if (pendingTarget !== null && pendingTarget < slots.length) {
      slots.splice(pendingTarget, 0, slot);
      pendingTarget += 1;
    } else {
      slots.push(slot);
    }
    loadSlot(slot);
  });
  pendingTarget = null;
  render();
}

function createSlot({ file = null, sourceUrl = null, name, keepName = false }) {
  const id = nextId++;
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  return {
    id,
    file,
    sourceUrl,
    name,
    keepName,
    delay: 0,
    duration: 0,
    ready: false,
    video,
    tile: null,
    statusEl: null,
    objectUrl: null,
    fileIdPromise: null,
    audio: false,
  };
}

function setSlotStatus(slot, text, isError) {
  slot.statusText = text;
  slot.statusError = !!isError;
  if (slot.statusEl) {
    slot.statusEl.textContent = text || '';
    slot.statusEl.hidden = !text;
    slot.statusEl.classList.toggle('error', !!isError);
  }
}

// Enlaces que el navegador no puede reproducir directo (páginas para compartir).
function isShareLink(url) {
  return /(^|\.)(drive|docs)\.google\.com$|(^|\.)dropbox\.com$|(^|\.)1drv\.ms$|(^|\.)onedrive\.live\.com$/i.test(
    new URL(url).hostname
  );
}

function loadSlot(slot) {
  if (SERVER_ONLY_EXT.includes(extOf(slot.name)) || (slot.sourceUrl && isShareLink(slot.sourceUrl))) {
    loadViaServer(slot);
    return;
  }

  setSlotStatus(slot, 'Abriendo…');
  const src = slot.sourceUrl || (slot.objectUrl = URL.createObjectURL(slot.file));
  const video = slot.video;
  let settled = false;

  const fallback = () => {
    if (settled) return;
    settled = true;
    cleanup();
    video.removeAttribute('src');
    video.load();
    loadViaServer(slot);
  };
  const ok = () => {
    // Algunos navegadores "abren" HEVC sin poder decodificarlo: sin ancho de video.
    if (settled) return;
    if (!video.videoWidth) return fallback();
    settled = true;
    cleanup();
    markReady(slot);
  };
  const timer = setTimeout(fallback, NATIVE_TIMEOUT_MS);
  function cleanup() {
    clearTimeout(timer);
    video.removeEventListener('loadeddata', ok);
    video.removeEventListener('error', fallback);
  }
  video.addEventListener('loadeddata', ok);
  video.addEventListener('error', fallback);
  video.src = src;
}

async function loadViaServer(slot) {
  try {
    const verb = slot.sourceUrl ? 'Descargando enlace' : 'Subiendo para convertir';
    setSlotStatus(slot, `${verb}…`);
    const fileId = await ensureUploaded(slot, (pct, bytes) => {
      if (slot.removed) return;
      const detail = pct ? `${pct}%` : bytes ? `${(bytes / 1048576).toFixed(1)} MB` : '';
      setSlotStatus(slot, `${verb}… ${detail}`);
    });
    if (slot.removed) return;
    setSlotStatus(slot, 'Convirtiendo para reproducir…');
    const { jobId } = await postJson('/api/preview', { fileId, format: PREVIEW_FORMAT });
    const job = await waitForJob(jobId, (j) => {
      if (slot.removed) return;
      setSlotStatus(slot, j.status === 'queued' ? 'En cola…' : `Convirtiendo para reproducir… ${j.progress}%`);
    });
    if (slot.removed) return;
    slot.video.addEventListener('loadeddata', () => markReady(slot), { once: true });
    slot.video.addEventListener(
      'error',
      () => setSlotStatus(slot, 'No se pudo reproducir este video.', true),
      { once: true }
    );
    slot.video.src = job.mediaUrl;
  } catch (err) {
    setSlotStatus(slot, err.message || 'Error al cargar el video.', true);
  }
}

function markReady(slot) {
  if (slot.removed) return;
  slot.ready = true;
  slot.duration = Number.isFinite(slot.video.duration) ? slot.video.duration : 0;
  setSlotStatus(slot, '');
  syncAll(true);
  updateTimeline();
  updateMergeState();
}

function removeSlot(id) {
  const idx = slots.findIndex((s) => s.id === id);
  if (idx < 0) return;
  const [slot] = slots.splice(idx, 1);
  slot.removed = true;
  slot.video.pause();
  slot.video.removeAttribute('src');
  slot.video.load();
  if (slot.objectUrl) URL.revokeObjectURL(slot.objectUrl);
  if (focusedId === id) focusedId = null;
  render();
  updateTimeline();
}

function moveSlot(id, dir) {
  const idx = slots.findIndex((s) => s.id === id);
  const to = idx + dir;
  if (idx < 0 || to < 0 || to >= slots.length) return;
  [slots[idx], slots[to]] = [slots[to], slots[idx]];
  render();
}

function setAudio(id) {
  slots.forEach((s) => {
    s.audio = s.id === id ? !s.audio : false;
    s.video.muted = !s.audio;
  });
  render();
}

// ---------------------------------------------------------------------------
// Grilla
// ---------------------------------------------------------------------------

function currentLayout() {
  if (focusedId !== null) return [1, 1];
  if (layoutChoice !== 'auto') return layoutChoice.split('x').map(Number);
  return AUTO_LAYOUTS[Math.max(slots.length, 4)] || [4, 2];
}

// En pantallas angostas (celular vertical) las columnas se reducen para que
// cada cámara no quede diminuta: 4 → 2×2, 6 → 2×3, 8 → 2×4.
function displayLayout() {
  const [cols, rows] = currentLayout();
  const portrait = window.matchMedia('(max-width: 700px) and (orientation: portrait)').matches;
  if (portrait && cols > 2) return [2, Math.ceil((cols * rows) / 2)];
  return [cols, rows];
}

// Distribución para el mosaico: la elegida, o la mínima que quepa.
function mergeLayout() {
  if (layoutChoice !== 'auto') {
    const [c, r] = layoutChoice.split('x').map(Number);
    if (c * r >= slots.length) return [c, r];
  }
  return AUTO_LAYOUTS[slots.length] || [4, 2];
}

function render() {
  const [cols, rows] = displayLayout();
  const perPage = cols * rows;
  gridEl.style.setProperty('--cols', cols);
  gridEl.style.setProperty('--rows', rows);
  gridEl.classList.toggle('fill', fillCheck.checked);
  gridEl.innerHTML = '';

  // Si hay más cámaras que pantallas, se muestran por páginas.
  const pages = focusedId !== null ? 1 : Math.max(1, Math.ceil(slots.length / perPage));
  page = Math.min(page, pages - 1);
  const start = focusedId !== null ? 0 : page * perPage;
  const visible = focusedId !== null ? slots.filter((s) => s.id === focusedId) : slots.slice(start, start + perPage);
  slots.forEach((s) => {
    s.shown = visible.includes(s);
  });

  for (let i = 0; i < perPage; i++) {
    const slot = visible[i];
    if (slot) {
      gridEl.appendChild(buildTile(slot, slots.indexOf(slot)));
    } else if (focusedId === null) {
      gridEl.appendChild(buildEmptyTile(start + i));
    }
  }

  $('pager').hidden = pages <= 1;
  $('page-label').textContent = `Cámaras ${start + 1}–${Math.min(start + perPage, slots.length)} de ${slots.length}`;
  $('page-prev').disabled = page === 0;
  $('page-next').disabled = page >= pages - 1;
  document.querySelectorAll('#screens button').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.layout === layoutChoice);
  });

  // Lista de audio para el mosaico: nunca se mezclan las cámaras.
  const previous = audioSelect.value;
  audioSelect.innerHTML = '<option value="-1">Sin audio</option>';
  slots.forEach((s, i) => {
    const opt = document.createElement('option');
    opt.value = String(i);
    opt.textContent = `Solo cámara ${i + 1} · ${s.name}`;
    audioSelect.appendChild(opt);
  });
  if (slots.length > 1) {
    const opt = document.createElement('option');
    opt.value = String(AUDIO_ALL);
    opt.textContent = 'Todas, en pistas separadas (eliges en el reproductor)';
    audioSelect.appendChild(opt);
  }
  const audioSlot = slots.findIndex((s) => s.audio);
  const keep = previous === String(AUDIO_ALL) ? slots.length > 1 : Number(previous) < slots.length;
  audioSelect.value = audioSlot >= 0 ? String(audioSlot) : keep ? previous : '-1';
  updateAudioHint();

  updateMergeState();
}

function updateAudioHint() {
  const value = Number(audioSelect.value);
  let text = '';
  if (value === AUDIO_ALL) {
    text =
      '🎧 Cada cámara queda en su propia pista de audio, sin mezclarse. En VLC: menú Audio → Pista de audio → elige la cámara. En el reproductor de Windows: botón de idioma/audio.';
  } else if (value >= 0) {
    text = `🎧 El video descargado tendrá solo el audio de la cámara ${value + 1}. Puedes probar cuál se escucha mejor con el botón 🔇/🔊 de cada cámara.`;
  }
  $('audio-hint').textContent = text;
}

function buildEmptyTile(index) {
  const tile = document.createElement('div');
  tile.className = 'tile empty';
  if (index >= MAX_CAMERAS) {
    tile.classList.add('disabled');
    return tile;
  }
  tile.innerHTML = `<span>+ Cámara ${index + 1}</span><small>Clic o arrastra un video</small>`;
  tile.addEventListener('click', () => {
    pendingTarget = Math.min(index, slots.length);
    fileInput.click();
  });
  return tile;
}

function buildTile(slot, index) {
  const tile = document.createElement('div');
  tile.className = 'tile';
  if (slot.audio) tile.classList.add('has-audio');

  tile.appendChild(slot.video);

  const status = document.createElement('div');
  status.className = 'tile-status';
  slot.statusEl = status;
  setSlotStatus(slot, slot.statusText, slot.statusError);
  tile.appendChild(status);

  const bar = document.createElement('div');
  bar.className = 'tile-bar';
  bar.innerHTML = `
    <span class="cam-label" title="${escapeHtml(slot.sourceUrl || slot.name)}">CAM ${index + 1} · <span>${escapeHtml(slot.name)}</span></span>
    <span class="tile-tools">
      <label title="Retraso en segundos: positivo = esta cámara empieza después; negativo = se recorta su inicio">
        ⏱<input type="number" step="0.1" value="${slot.delay}" class="delay-input" />s
      </label>
      <button type="button" data-act="audio" title="Escuchar el audio de esta cámara">${slot.audio ? '🔊' : '🔇'}</button>
      <button type="button" data-act="left" title="Mover antes">◀</button>
      <button type="button" data-act="right" title="Mover después">▶</button>
      <button type="button" data-act="focus" title="Ampliar / volver a la grilla">${focusedId === slot.id ? '▦' : '⤢'}</button>
      <button type="button" data-act="remove" title="Quitar">✕</button>
    </span>
  `;
  tile.appendChild(bar);
  slot.labelEl = bar.querySelector('.cam-label');

  const delayInput = bar.querySelector('.delay-input');
  delayInput.addEventListener('change', () => {
    slot.delay = Number(delayInput.value) || 0;
    updateTimeline();
    syncAll(true);
  });
  bar.querySelectorAll('button').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const act = btn.dataset.act;
      if (act === 'audio') setAudio(slot.id);
      if (act === 'left') moveSlot(slot.id, -1);
      if (act === 'right') moveSlot(slot.id, 1);
      if (act === 'remove') removeSlot(slot.id);
      if (act === 'focus') toggleFocus(slot.id);
    });
  });
  slot.video.ondblclick = () => toggleFocus(slot.id);
  // En pantallas táctiles no hay "hover": un toque muestra/oculta los botones.
  tile.addEventListener('click', (e) => {
    if (e.target.closest('.tile-tools')) return;
    if (window.matchMedia('(hover: none), (max-width: 700px)').matches) tile.classList.toggle('show-tools');
  });

  // Al reinsertar el elemento en el DOM se pausa: lo reanudamos si corresponde.
  if (playing) requestAnimationFrame(() => syncAll(true));
  return tile;
}

function toggleFocus(id) {
  focusedId = focusedId === id ? null : id;
  render();
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------------------------------------------------------------------------
// Reproducción sincronizada
// ---------------------------------------------------------------------------

function totalDuration() {
  return slots.reduce((max, s) => (s.ready ? Math.max(max, s.delay + s.duration) : max), 0);
}

function updateTimeline() {
  const total = totalDuration();
  timeline.max = String(total);
  if (clock > total) clock = total;
  timeline.value = String(clock);
  timeLabel.textContent = `${formatTime(clock)} / ${formatTime(total)}`;
}

// Ajusta cada video a "clock - retraso". Con force=true salta siempre a la
// posición exacta (al buscar); si no, solo corrige cuando se desfasa.
function syncAll(force) {
  slots.forEach((slot) => {
    if (!slot.ready) return;
    const v = slot.video;
    const target = clock - slot.delay;
    const inRange = target >= 0 && target < slot.duration - 0.05;
    const clamped = Math.max(0, Math.min(target, Math.max(0, slot.duration - 0.05)));

    if (Math.abs(v.playbackRate - rate) > 0.001) v.playbackRate = rate;

    if (playing && inRange && slot.shown) {
      const tolerance = 0.3 * Math.max(1, rate);
      if (force || Math.abs(v.currentTime - target) > tolerance) v.currentTime = target;
      if (v.paused) v.play().catch(() => {});
    } else {
      if (!v.paused) v.pause();
      if (force || Math.abs(v.currentTime - clamped) > 0.05) v.currentTime = clamped;
    }
  });
}

function tick(ts) {
  if (playing) {
    if (lastFrameTs !== null) clock += ((ts - lastFrameTs) / 1000) * rate;
    const total = totalDuration();
    if (clock >= total) {
      clock = total;
      setPlaying(false);
    }
    if (ts - lastSync > 250) {
      lastSync = ts;
      syncAll(false);
    }
    timeline.value = String(clock);
    timeLabel.textContent = `${formatTime(clock)} / ${formatTime(total)}`;
  }
  lastFrameTs = ts;
  requestAnimationFrame(tick);
}

function setPlaying(value) {
  const anyReady = slots.some((s) => s.ready);
  playing = value && anyReady;
  if (playing && clock >= totalDuration() - 0.05) clock = 0;
  playBtn.textContent = playing ? '⏸' : '▶';
  syncAll(true);
}

function seek(time) {
  clock = Math.max(0, Math.min(time, totalDuration()));
  updateTimeline();
  syncAll(true);
}

// ---------------------------------------------------------------------------
// Captura y mosaico
// ---------------------------------------------------------------------------

function snapshot() {
  const ready = slots.filter((s) => s.ready);
  if (ready.length === 0) return;
  const [cols, rows] = mergeLayout();
  const cellW = 640;
  const cellH = 360;
  const canvas = document.createElement('canvas');
  canvas.width = cols * cellW;
  canvas.height = rows * cellH;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  slots.forEach((slot, i) => {
    if (!slot.ready || !slot.video.videoWidth) return;
    const x = (i % cols) * cellW;
    const y = Math.floor(i / cols) * cellH;
    const scale = Math.min(cellW / slot.video.videoWidth, cellH / slot.video.videoHeight);
    const w = slot.video.videoWidth * scale;
    const h = slot.video.videoHeight * scale;
    ctx.drawImage(slot.video, x + (cellW - w) / 2, y + (cellH - h) / 2, w, h);
  });

  try {
    canvas.toDataURL();
  } catch {
    alert('No se puede capturar: alguna cámara viene de un enlace de otro sitio que no lo permite.');
    return;
  }

  canvas.toBlob((blob) => {
    const url = URL.createObjectURL(blob);
    triggerDownload(url, `captura-${formatTime(clock).replace(/:/g, '-')}.png`);
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }, 'image/png');
}

function updateMergeState() {
  mergeBtn.disabled = slots.length === 0 || mergeBtn.dataset.busy === '1';
  updateCompressOptions();
}

// ---------------------------------------------------------------------------
// Comprimir
// ---------------------------------------------------------------------------

const compressBtn = $('compress-btn');
const compressTarget = $('compress-target');
const COMPRESS_HINTS = {
  alta: 'Casi no se nota diferencia. Útil cuando el video viene sin comprimir o muy pesado desde el DVR.',
  equilibrada: 'Recomendado: la imagen se ve prácticamente igual y suele pesar entre la mitad y un tercio. Si el video supera 1080p se baja a 1080p.',
  extrema: 'Compresión extrema: 480p, 10 cuadros por segundo y audio básico. Solo para casos excepcionales (adjuntar a un correo con límite de tamaño, enviar con mala señal). Se pierde detalle: patentes y rostros lejanos pueden no leerse.',
  maxima: 'Pesa mucho menos (ideal para WhatsApp o correo), pero se baja a 720p y se nota un poco en detalles finos como patentes lejanas.',
};

function formatBytes(bytes) {
  if (!bytes) return '0 MB';
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function updateCompressOptions() {
  const previous = compressTarget.value;
  compressTarget.innerHTML =
    '<option value="merge">Todas unidas en un solo video (mosaico)</option>' +
    '<option value="all">Todas, cada una por separado</option>';
  slots.forEach((s, i) => {
    const opt = document.createElement('option');
    opt.value = String(s.id);
    opt.textContent = `Cámara ${i + 1} · ${s.name}`;
    compressTarget.appendChild(opt);
  });
  if ([...compressTarget.options].some((o) => o.value === previous)) compressTarget.value = previous;
  compressBtn.disabled = slots.length === 0 || compressBtn.dataset.busy === '1';
  $('compress-extreme-btn').disabled = compressBtn.disabled;
  const hint = COMPRESS_HINTS[compressBtn.dataset.level || $('compress-level').value];
  $('compress-hint').textContent =
    compressTarget.value === 'merge'
      ? `${hint} Se unen todas las cámaras en un solo archivo (misma distribución, retrasos y audio de "Unir en un solo video"), comprimido en un solo paso.`
      : hint;
}

// Ancho total del mosaico según el nivel: más compresión, menos resolución.
const MERGE_WIDTH_BY_LEVEL = { alta: 1920, equilibrada: 1920, maxima: 1280, extrema: 960 };
const MERGE_FPS_BY_LEVEL = { extrema: 10 };

function compressMerged(level) {
  const row = addCompressRow(`Mosaico unido · ${slots.length} cámaras`);
  return merge({
    quality: level,
    width: Math.min(Number($('width-select').value), MERGE_WIDTH_BY_LEVEL[level]),
    fps: MERGE_FPS_BY_LEVEL[level],
    report: (text, pct, type) => row.set(text, pct, type),
    onDone: (job, audioNote) => {
      const saved = job.inputBytes ? Math.min(99, Math.round((1 - job.outputBytes / job.inputBytes) * 100)) : 0;
      const sizes = `${formatBytes(job.inputBytes)} → ${formatBytes(job.outputBytes)}${saved > 0 ? ` (−${saved}%)` : ''}`;
      row.set(`✅ ${sizes} · ${audioNote}`, 100, 'success');
      const link = document.createElement('a');
      link.className = 'btn success';
      link.href = job.downloadUrl;
      link.setAttribute('download', job.fileName);
      link.textContent = '⬇ Descargar video unido';
      row.li.appendChild(link);
    },
  });
}

function addCompressRow(name) {
  const li = document.createElement('li');
  li.className = 'compress-item';
  li.innerHTML = `
    <div class="compress-item-head">
      <span class="compress-item-name"></span>
      <span class="compress-item-state">En espera…</span>
    </div>
    <div class="progress-track"><div class="progress-fill"></div></div>
  `;
  li.querySelector('.compress-item-name').textContent = name;
  $('compress-list').appendChild(li);
  const stateEl = li.querySelector('.compress-item-state');
  const fillEl = li.querySelector('.progress-fill');
  return {
    li,
    set(text, pct, type) {
      stateEl.textContent = text;
      stateEl.className = `compress-item-state ${type || ''}`;
      if (pct !== null && pct !== undefined) fillEl.style.width = `${pct}%`;
      fillEl.classList.toggle('error', type === 'error');
    },
  };
}

async function compressSlot(slot, level, row, autoDownload) {
  try {
    const fileId = await ensureUploaded(slot, (pct) => row.set(`Subiendo… ${pct || 0}%`, (pct || 0) * 0.3));
    const { jobId } = await postJson('/api/compress', { fileId, level, expectedDuration: slot.duration || 0 });
    const job = await waitForJob(jobId, (j) => {
      if (j.status === 'queued') row.set('En cola…', 30);
      else row.set(`Comprimiendo… ${j.progress}%`, 30 + j.progress * 0.7);
    });
    const saved = job.inputBytes ? Math.min(99, Math.round((1 - job.outputBytes / job.inputBytes) * 100)) : 0;
    const summary =
      saved > 0
        ? `${formatBytes(job.inputBytes)} → ${formatBytes(job.outputBytes)} (−${saved}%)`
        : `${formatBytes(job.inputBytes)} → ${formatBytes(job.outputBytes)} (el original ya estaba bien comprimido)`;
    row.set(`✅ ${summary}`, 100, 'success');
    const link = document.createElement('a');
    link.className = 'btn success';
    link.href = job.downloadUrl;
    link.setAttribute('download', job.fileName);
    link.textContent = '⬇ Descargar comprimido';
    row.li.appendChild(link);
    if (autoDownload) triggerDownload(job.downloadUrl, job.fileName);
  } catch (err) {
    row.set(err.message || 'Error al comprimir.', 100, 'error');
  }
}

async function compress(levelOverride) {
  const level = levelOverride || $('compress-level').value;
  // Mientras se muestra el resultado, la explicación corresponde al nivel usado.
  compressBtn.dataset.level = level;
  const target = compressTarget.value;
  const chosen = target === 'all' || target === 'merge' ? slots.slice() : slots.filter((s) => String(s.id) === target);
  if (chosen.length === 0) return;

  compressBtn.dataset.busy = '1';
  updateCompressOptions();
  $('compress-list').innerHTML = '';
  if (target === 'merge') {
    await compressMerged(level);
    delete compressBtn.dataset.busy;
    updateCompressOptions();
    return;
  }
  // El servidor las procesa en paralelo según sus núcleos disponibles.
  await Promise.all(
    chosen.map((slot) =>
      compressSlot(slot, level, addCompressRow(`Cámara ${slots.indexOf(slot) + 1} · ${slot.name}`), chosen.length === 1)
    )
  );
  delete compressBtn.dataset.busy;
  updateCompressOptions();
}

function setMergeStatusDefault(text, pct, type) {
  $('merge-status').hidden = false;
  const textEl = $('merge-status-text');
  textEl.textContent = text;
  textEl.className = `merge-status-text ${type || ''}`;
  if (pct !== null && pct !== undefined) $('merge-progress').style.width = `${pct}%`;
  $('merge-progress').classList.toggle('error', type === 'error');
}

// opts (para "comprimir y unir"): quality, width, report(texto, %, tipo) y
// onDone(job). Sin opts usa lo elegido en la sección "Unir en un solo video".
async function merge(opts = {}) {
  if (slots.length === 0) return;
  const setMergeStatus = opts.report || setMergeStatusDefault;
  const current = slots.slice();
  const download = $('merge-download');
  if (!opts.report) download.hidden = true;
  mergeBtn.dataset.busy = '1';
  updateMergeState();

  try {
    // Sube los originales que aún no estén en el servidor (en paralelo).
    const progress = current.map(() => 0);
    const report = () => {
      const avg = Math.round(progress.reduce((a, b) => a + b, 0) / current.length);
      setMergeStatus(`Subiendo / descargando videos… ${avg}%`, avg * 0.3);
    };
    report();
    const fileIds = await Promise.all(
      current.map((slot, i) =>
        ensureUploaded(slot, (pct) => {
          progress[i] = pct;
          report();
        }).then((id) => {
          progress[i] = 100;
          report();
          return id;
        })
      )
    );

    const [cols, rows] = mergeLayout();
    // Solo sirve para mostrar el progreso: si falta alguna duración, se omite.
    const expectedDuration = current.every((s) => s.ready && s.duration)
      ? current.reduce((max, s) => Math.max(max, s.delay + s.duration), 0)
      : 0;
    const { jobId } = await postJson('/api/mosaic', {
      items: current.map((slot, i) => ({ fileId: fileIds[i], delay: slot.delay })),
      cols,
      rows,
      width: opts.width || Number($('width-select').value),
      fps: opts.fps || Number($('fps-select').value),
      quality: opts.quality || $('quality-select').value,
      audioIndex: Number(audioSelect.value),
      expectedDuration,
    });

    setMergeStatus('Uniendo videos…', 30);
    const job = await waitForJob(jobId, (j) => {
      if (j.status === 'queued') setMergeStatus('En cola…', 30);
      else setMergeStatus(`Uniendo videos… ${j.progress}%`, 30 + j.progress * 0.7);
    });

    const tracks = job.audioTracks || [];
    const audioNote =
      Number(audioSelect.value) === -1
        ? 'sin audio'
        : tracks.length === 0
          ? 'sin audio (la cámara elegida no tiene sonido)'
          : tracks.length === 1
            ? `audio de la cámara ${tracks[0]}`
            : `audio en pistas separadas: cámaras ${tracks.join(', ')}`;
    if (opts.onDone) {
      opts.onDone(job, audioNote);
    } else {
      setMergeStatus(`¡Listo! ${job.fileName} — ${audioNote}`, 100, 'success');
      download.href = job.downloadUrl;
      download.setAttribute('download', job.fileName);
      download.hidden = false;
    }
    triggerDownload(job.downloadUrl, job.fileName);
  } catch (err) {
    setMergeStatus(err.message || 'Error al unir los videos.', 100, 'error');
  } finally {
    delete mergeBtn.dataset.busy;
    updateMergeState();
  }
}

// ---------------------------------------------------------------------------
// Eventos
// ---------------------------------------------------------------------------

const linkInput = $('link-input');
$('link-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = linkInput.value;
  linkInput.value = '';
  if ((await addUrls(text)) === 0) {
    linkInput.value = text;
    alert('Pega al menos un enlace que empiece con http:// o https://');
  }
});
linkInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    $('link-form').requestSubmit();
  }
});

fileInput.addEventListener('change', () => {
  addFiles(fileInput.files);
  fileInput.value = '';
});
fileInput.addEventListener('cancel', () => {
  pendingTarget = null;
});

$('clear-btn').addEventListener('click', () => {
  slots.slice().forEach((s) => removeSlot(s.id));
  setPlaying(false);
  clock = 0;
  updateTimeline();
});

playBtn.addEventListener('click', () => setPlaying(!playing));
$('back-btn').addEventListener('click', () => seek(clock - 10));
$('fwd-btn').addEventListener('click', () => seek(clock + 10));
$('frame-back-btn').addEventListener('click', () => {
  setPlaying(false);
  seek(clock - FRAME_STEP);
});
$('frame-fwd-btn').addEventListener('click', () => {
  setPlaying(false);
  seek(clock + FRAME_STEP);
});
timeline.addEventListener('input', () => seek(Number(timeline.value)));
speedSelect.addEventListener('change', () => {
  rate = Number(speedSelect.value);
  syncAll(true);
});
$('screens').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-layout]');
  if (!btn) return;
  layoutChoice = btn.dataset.layout;
  focusedId = null;
  page = 0;
  render();
  syncAll(true);
});
$('page-prev').addEventListener('click', () => {
  page = Math.max(0, page - 1);
  render();
  syncAll(true);
});
$('page-next').addEventListener('click', () => {
  page += 1;
  render();
  syncAll(true);
});
// Al girar el celular cambia la cantidad de columnas.
window.matchMedia('(max-width: 700px) and (orientation: portrait)').addEventListener('change', () => {
  render();
  syncAll(true);
});
fillCheck.addEventListener('change', render);
audioSelect.addEventListener('change', updateAudioHint);
$('snapshot-btn').addEventListener('click', snapshot);
// Pantalla completa real si el navegador la permite; en iPhone (que no la
// permite para elementos de la página) se usa una vista a pantalla completa.
function setPseudoFullscreen(on) {
  document.body.classList.toggle('pseudo-full', on);
  $('exit-full').hidden = !on;
  render();
  syncAll(true);
}
$('fullscreen-btn').addEventListener('click', () => {
  if (document.fullscreenElement) {
    document.exitFullscreen();
  } else if (document.fullscreenEnabled && gridEl.requestFullscreen) {
    gridEl.requestFullscreen().catch(() => setPseudoFullscreen(true));
  } else {
    setPseudoFullscreen(true);
  }
});
$('exit-full').addEventListener('click', () => setPseudoFullscreen(false));
mergeBtn.addEventListener('click', () => merge());
compressBtn.addEventListener('click', () => compress());
$('compress-extreme-btn').addEventListener('click', () => {
  const ok = confirm(
    'Compresión extrema: el video queda en 480p y a 10 cuadros por segundo. Pesa muy poco, pero se pierde detalle (patentes o rostros lejanos pueden no leerse).\n\n¿Continuar?'
  );
  if (ok) compress('extrema');
});
$('compress-level').addEventListener('change', () => {
  delete compressBtn.dataset.level;
  updateCompressOptions();
});
compressTarget.addEventListener('change', updateCompressOptions);

document.addEventListener('keydown', (e) => {
  if (e.target.matches('input, select, textarea')) return;
  if (e.code === 'Space') {
    e.preventDefault();
    setPlaying(!playing);
  } else if (e.key === 'ArrowLeft') seek(clock - 10);
  else if (e.key === 'ArrowRight') seek(clock + 10);
  else if (e.key === ',') {
    setPlaying(false);
    seek(clock - FRAME_STEP);
  } else if (e.key === '.') {
    setPlaying(false);
    seek(clock + FRAME_STEP);
  } else if (e.key === 'Escape' && document.body.classList.contains('pseudo-full')) setPseudoFullscreen(false);
  else if (e.key === 'Escape' && focusedId !== null) toggleFocus(focusedId);
});

const overlay = $('drop-overlay');
let dragDepth = 0;
document.addEventListener('dragenter', (e) => {
  if (!e.dataTransfer || !Array.from(e.dataTransfer.types).includes('Files')) return;
  dragDepth += 1;
  overlay.hidden = false;
});
document.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) overlay.hidden = true;
});
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  overlay.hidden = true;
  if (e.dataTransfer && e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
});

render();
updateTimeline();
requestAnimationFrame(tick);
