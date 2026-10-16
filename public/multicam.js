const MAX_CAMERAS = 8;
const CHUNK_SIZE = 8 * 1024 * 1024; // 8 MB (si un proxy lo rechaza, se parte en trozos más chicos)
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
// ¿El navegador reproduce H.265/HEVC? (Chrome/Edge con aceleración, Safari):
// así el servidor puede entregar el video tal cual, sin recodificarlo.
let CAN_HEVC = !!document.createElement('video').canPlayType('video/mp4; codecs="hvc1.1.6.L93.B0"');
const IS_FIREFOX = /Firefox\//.test(navigator.userAgent);
// canPlayType a veces responde "no" aunque la tarjeta gráfica sí decodifica
// H.265: se pregunta también con MediaCapabilities.
if (!CAN_HEVC && navigator.mediaCapabilities && navigator.mediaCapabilities.decodingInfo) {
  navigator.mediaCapabilities
    .decodingInfo({
      type: 'file',
      video: { contentType: 'video/mp4; codecs="hvc1.1.6.L93.B0"', width: 1920, height: 1080, bitrate: 4000000, framerate: 25 },
    })
    .then((r) => {
      if (r.supported) CAN_HEVC = true;
    })
    .catch(() => {});
}
// Firefox nunca reproduce H.265; los demás (Chrome, Edge, Safari) se prueba
// directamente: si no lo logran, recién ahí se usa el servidor.
const TRY_HEVC_LOCALLY = () => CAN_HEVC || !IS_FIREFOX;
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
let trim = null; // { start, end } en segundos de la línea de tiempo común
let clockBase = null; // hora real (ms) del segundo 0, si se sincronizó por nombre
let tray = []; // cámaras sacadas de la pantalla ("Disponibles"): no se ven ni se unen
let movingId = null; // cámara elegida con ✥ esperando que se toque su nuevo lugar
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
    err.data = data;
    throw err;
  }
  return data;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Errores pasajeros: sin conexión, servidor reiniciándose, proxy caído…
// (507 = sin espacio en disco: reintentar no sirve).
function isTransient(err) {
  return !err.status || err.status === 408 || err.status === 429 || (err.status >= 500 && err.status !== 507);
}

// Reintenta mientras el error sea pasajero, esperando cada vez más (hasta
// 30 s entre intentos, ~20 minutos en total) para aguantar cortes de red o
// reinicios del servidor sin perder el trabajo.
async function withRetry(fn, onWait) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!isTransient(err) || attempt >= 45) throw err;
      const wait = Math.min(30000, 2000 * 2 ** Math.min(attempt, 4));
      if (onWait) onWait(err, wait);
      await sleep(wait);
    }
  }
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

// Partes del archivo que el servidor todavía no tiene, en trozos de CHUNK_SIZE.
function missingChunks(size, ranges) {
  const chunks = [];
  let pos = 0;
  const gaps = [];
  for (const [a, b] of ranges) {
    if (a > pos) gaps.push([pos, a]);
    pos = Math.max(pos, b);
  }
  if (pos < size) gaps.push([pos, size]);
  for (const [a, b] of gaps) {
    for (let o = a; o < b; o += CHUNK_SIZE) chunks.push([o, Math.min(o + CHUNK_SIZE, b)]);
  }
  return chunks;
}

// Sube un video de cualquier tamaño. Envía 4 trozos a la vez; si se corta la
// conexión o el servidor se reinicia, reintenta solo y continúa desde lo que
// el servidor ya recibió. Si el servidor perdió la subida (p. ej. se borró su
// disco al reiniciarse), la empieza de nuevo automáticamente.
async function uploadStored(file, onProgress) {
  if (file.size === 0) throw new Error('El archivo está vacío.');
  for (let attempt = 0; attempt < 3; attempt++) {
    const { uploadId } = await withRetry(() =>
      postJson('/api/upload/init', { fileName: file.name, purpose: 'store', fileSize: file.size })
    );
    try {
      return await uploadParts(file, uploadId, onProgress);
    } catch (err) {
      if (err.status === 404) continue;
      throw err;
    }
  }
  throw new Error('No se pudo completar la subida después de varios intentos.');
}

async function uploadParts(file, uploadId, onProgress) {
  let ranges = [];
  for (;;) {
    const pending = missingChunks(file.size, ranges);
    let confirmed = file.size - pending.reduce((sum, [a, b]) => sum + (b - a), 0);
    const report = (note) => {
      const pct = Math.min(99, Math.floor((confirmed / file.size) * 100));
      onProgress(pct, confirmed, note);
    };
    report();

    // Envía un trozo; si un proxy lo rechaza por grande (413 sin respuesta del
    // servidor), lo parte en dos.
    const sendChunk = async (a, b) => {
      try {
        await withRetry(
          () => {
            const formData = new FormData();
            formData.append('uploadId', uploadId);
            formData.append('offset', String(a));
            formData.append('chunk', file.slice(a, b));
            return fetch('/api/upload/chunk', { method: 'POST', body: formData }).then(readJson);
          },
          (err, wait) => report(`sin conexión con el servidor, reintentando en ${Math.round(wait / 1000)} s…`)
        );
        confirmed += b - a;
        report();
      } catch (err) {
        if (err.status === 413 && !err.data && b - a > MIN_CHUNK_SIZE) {
          const mid = a + Math.floor((b - a) / 2);
          await sendChunk(a, mid);
          await sendChunk(mid, b);
          return;
        }
        throw err;
      }
    };

    const queue = pending.slice();
    const worker = async () => {
      while (queue.length) {
        const [a, b] = queue.shift();
        await sendChunk(a, b);
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);

    try {
      const result = await withRetry(() => postJson('/api/upload/complete', { uploadId }));
      onProgress(100, file.size);
      return result.fileId;
    } catch (err) {
      // Faltan partes (p. ej. el servidor se reinició y perdió las últimas):
      // se envían solo esas.
      if (err.status === 409 && err.data && err.data.ranges) {
        ranges = err.data.ranges;
        continue;
      }
      throw err;
    }
  }
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
  const job = await runServerJob(
    () => postJson('/api/import', { url: slot.sourceUrl }),
    (j) => {
      if (j.status === 'processing') onProgress(j.progress, j.bytes);
    }
  );
  if (!slot.keepName && job.originalName && job.originalName !== slot.name) {
    slot.name = job.originalName;
    if (slot.labelEl) slot.labelEl.lastChild.textContent = slot.name;
  }
  return job.fileId;
}

// Consulta el avance de un trabajo del servidor. Si se pierde la conexión
// sigue intentando (hasta ~10 minutos seguidos); si el servidor se reinició y
// ya no conoce el trabajo, avisa con code = 'JOB_LOST' para relanzarlo.
async function waitForJob(jobId, onProgress) {
  let failingSince = null;
  for (;;) {
    await sleep(failingSince ? 3000 : 800);
    let job;
    try {
      job = await fetch(`/api/jobs/${jobId}`).then(readJson);
      failingSince = null;
    } catch (err) {
      if (err.status === 404) {
        const lost = new Error('El servidor se reinició y perdió el trabajo.');
        lost.code = 'JOB_LOST';
        throw lost;
      }
      if (!isTransient(err)) throw err;
      failingSince = failingSince || Date.now();
      if (Date.now() - failingSince > 10 * 60 * 1000) throw new Error('Se perdió la conexión con el servidor.');
      continue;
    }
    if (job.status === 'done') return job;
    if (job.status === 'error') throw new Error(job.error || 'Error al procesar.');
    onProgress(job);
  }
}

// Lanza un trabajo en el servidor y espera el resultado. Si el servidor se
// reinicia a mitad, lo vuelve a lanzar (hasta 2 veces).
async function runServerJob(start, onProgress) {
  for (let attempt = 0; ; attempt++) {
    const { jobId } = await withRetry(start);
    try {
      return await waitForJob(jobId, onProgress);
    } catch (err) {
      if (err.code !== 'JOB_LOST' || attempt >= 2) throw err;
    }
  }
}

// Ejecuta fn(fileId) con el video de la cámara ya en el servidor. Si el
// servidor dice que ese video ya no existe (se reinició o se borró), lo vuelve
// a subir y repite.
async function withFile(slot, onProgress, fn) {
  for (let attempt = 0; ; attempt++) {
    const fileId = await ensureUploaded(slot, onProgress);
    try {
      return await fn(fileId);
    } catch (err) {
      if (attempt >= 1 || !(err.data && err.data.code === 'FILE_MISSING')) throw err;
      slot.fileIdPromise = null;
    }
  }
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
    // Siempre se deja elegir qué cámaras ver; las demás quedan en "Disponibles".
    const picked = await pickFolderFiles(files, Math.max(0, free));
    if (!picked) return;
    const { chosen, rest } = picked;
    const toSource = (f) => ({ sourceUrl: f.url, name: f.name, keepName: true });
    if (rest.length) addSources(rest.map(toSource), { toTray: true });
    if (chosen.length) {
      addSources(chosen.map(toSource));
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
      li.innerHTML = `<label><input type="checkbox" value="${i}" ${i < Math.min(max, 4) ? 'checked' : ''} /> <span></span></label>`;
      li.querySelector('span').textContent = file.name;
      list.appendChild(li);
    });
    const checks = Array.from(list.querySelectorAll('input'));
    const update = () => {
      const n = checks.filter((c) => c.checked).length;
      $('folder-hint').textContent =
        max === 0
          ? `La carpeta tiene ${files.length} videos. La pantalla ya está llena: todos quedarán en "Disponibles".`
          : `La carpeta tiene ${files.length} videos. Marca los que quieres ver ahora (${n} de máximo ${max}). Los demás quedan en "Disponibles" por si los necesitas.`;
      checks.forEach((c) => {
        c.disabled = !c.checked && n >= max;
      });
      addBtn.textContent = n ? `Ver ${n} cámara${n === 1 ? '' : 's'}` : 'Guardar en Disponibles';
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
    $('folder-cancel').onclick = () => close(null);
    $('folder-all').onclick = () => {
      checks.forEach((c, i) => {
        c.checked = i < max;
      });
      update();
    };
    $('folder-none').onclick = () => {
      checks.forEach((c) => {
        c.checked = false;
      });
      update();
    };
    addBtn.onclick = () =>
      close({
        chosen: checks.filter((c) => c.checked).map((c) => files[Number(c.value)]),
        rest: checks.filter((c) => !c.checked).map((c) => files[Number(c.value)]),
      });
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

// Agrega videos a la pantalla. Los que no caben (o si se pide con
// { toTray: true }) quedan en "Disponibles" sin cargarse, para no gastar
// descargas ni conversiones en cámaras que quizá no se usen.
function addSources(sources, { toTray = false } = {}) {
  // Continuaciones (varias partes del mismo canal): se unen de inmediato, sin
  // preparar cada parte por separado para verla (eso era trabajo doble).
  if (!toTray && autoJoinEnabled()) {
    const { singles, groups } = groupContinuations(sources);
    groups.forEach(startGroupJoin);
    sources = singles;
  }
  const free = toTray ? 0 : Math.max(0, MAX_CAMERAS - slots.length);
  const extra = sources.slice(free);
  if (extra.length) {
    extra.forEach((source) => tray.push(createSlot(source)));
    if (!toTray) {
      alert(
        `Solo caben ${MAX_CAMERAS} cámaras en pantalla. ${extra.length} quedaron en "Disponibles": agrégalas cuando quieras sacando otra.`
      );
    }
  }
  sources.slice(0, free).forEach((source) => {
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
  renderTray();
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
  slot.loaded = true;
  if (!slot.mediaUrl && (SERVER_ONLY_EXT.includes(extOf(slot.name)) || (slot.sourceUrl && isShareLink(slot.sourceUrl)))) {
    // Videos del DVR en el equipo: se pasan a MP4 aquí mismo, sin subirlos.
    if (slot.file && LocalFF.canUse([slot.file])) loadLocally(slot);
    else {
      if (slot.file) slot.serverReason = whyServer({ skip: slot.file.size > LocalFF.MAX_BYTES ? 'size' : 'browser' }, slot.file);
      loadViaServer(slot);
    }
    return;
  }

  setSlotStatus(slot, 'Abriendo…');
  const src = slot.mediaUrl || slot.sourceUrl || (slot.objectUrl = URL.createObjectURL(slot.file));
  const video = slot.video;
  let settled = false;

  const fallback = () => {
    if (settled) return;
    settled = true;
    cleanup();
    video.removeAttribute('src');
    video.load();
    if (slot.localMp4 && !slot.serverReason) {
      slot.serverReason =
        slot.localCodec === 'hevc'
          ? 'este equipo no tiene decodificador H.265 para el navegador; se convierte en el servidor'
          : 'este navegador no pudo reproducirlo directamente';
    }
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

async function loadLocally(slot) {
  try {
    setSlotStatus(slot, 'Preparando en tu equipo…');
    const result = await LocalFF.toMp4(slot.file, {
      canHevc: TRY_HEVC_LOCALLY(),
      onProgress: (pct) => {
        if (!slot.removed) setSlotStatus(slot, `Preparando en tu equipo… ${pct}%`);
      },
    });
    if (slot.removed) return;
    if (result.skip) {
      // Formato que este navegador no puede mostrar sin convertir: lo hace el servidor.
      slot.serverReason = whyServer(result, slot.file);
      return loadViaServer(slot);
    }
    slot.localMp4 = result.blob;
    slot.localCodec = result.info.vcodec;
    slot.mediaUrl = URL.createObjectURL(result.blob);
    if (result.info.vcodec === 'h264') slot.mp4 = { url: slot.mediaUrl, name: mp4Name(slot.name) };
    // Si el navegador no logra reproducirlo, loadSlot recurre al servidor.
    loadSlot(slot);
  } catch (err) {
    if (slot.removed) return;
    slot.serverReason = 'no se pudo preparar en tu equipo';
    loadViaServer(slot);
  }
}

const CODEC_NAMES = { hevc: 'H.265', h264: 'H.264', mpeg4: 'MPEG-4', mjpeg: 'MJPEG', vp9: 'VP9', av1: 'AV1' };

// Motivo (para mostrarlo en la cámara) por el que hay que usar el servidor.
function whyServer(result, file) {
  if (result.skip === 'size') return `archivo de ${formatBytes(file.size)}: muy grande para prepararlo en el navegador`;
  if (result.skip === 'browser') return 'este navegador no puede procesar videos localmente';
  if (result.skip === 'codec') {
    const name = CODEC_NAMES[result.codec] || String(result.codec).toUpperCase();
    if (result.codec === 'hevc') {
      return IS_FIREFOX
        ? 'video H.265: Firefox no lo reproduce. Ábrelo en Chrome o Edge para verlo sin subirlo'
        : 'video H.265: este navegador no lo reproduce';
    }
    return `video ${name}: hay que convertirlo`;
  }
  return 'formato no reconocido';
}

// Las cámaras que necesitan el servidor se suben y preparan de a una: así la
// primera queda lista pronto, en vez de avanzar todas lentamente a la vez.
let serverLoadChain = Promise.resolve();
function oneAtATime(fn) {
  const run = serverLoadChain.then(fn, fn);
  serverLoadChain = run.catch(() => {});
  return run;
}

async function loadViaServer(slot, forceTranscode = false) {
  const reason = slot.serverReason ? ` (${slot.serverReason})` : '';
  try {
    const verb = slot.sourceUrl ? 'Descargando enlace' : 'Subiendo para convertir';
    const onUpload = (pct, bytes, note) => {
      if (slot.removed) return;
      const detail = pct ? `${pct}%` : bytes ? `${(bytes / 1048576).toFixed(1)} MB` : '';
      setSlotStatus(slot, `${verb}… ${detail}${note ? ` (${note})` : reason}`);
    };
    // La subida va de a una cámara (comparten la conexión); la conversión en
    // el servidor puede ir en paralelo con la subida de la siguiente.
    if (!slot.fileIdPromise && slot.file) {
      setSlotStatus(slot, `En espera: se sube una cámara a la vez${reason}`);
      await oneAtATime(() => (slot.removed ? null : ensureUploaded(slot, onUpload).catch(() => null)));
      if (slot.removed) return;
    }
    setSlotStatus(slot, `${verb}…${reason}`);
    const job = await withFile(slot, onUpload, (fileId) => {
      if (slot.removed) return null;
      setSlotStatus(slot, 'Preparando para reproducir…');
      return runServerJob(
        () => postJson('/api/preview', { fileId, format: PREVIEW_FORMAT, canHevc: CAN_HEVC, transcode: forceTranscode }),
        (j) => {
          if (slot.removed) return;
          setSlotStatus(slot, j.status === 'queued' ? 'En cola…' : `Convirtiendo para reproducir… ${j.progress}%`);
        }
      );
    });
    if (!job) return;
    if (slot.removed) return;
    // Si el video reempaquetado (sin recodificar) no se puede ver en este
    // navegador, se pide la versión recodificada.
    const retry = () => {
      if (job.remuxed && !forceTranscode) {
        slot.video.removeAttribute('src');
        slot.video.load();
        loadViaServer(slot, true);
      } else {
        setSlotStatus(slot, 'No se pudo reproducir este video.', true);
      }
    };
    slot.video.addEventListener(
      'loadeddata',
      () => (slot.video.videoWidth ? markReady(slot) : retry()),
      { once: true }
    );
    slot.video.addEventListener('error', retry, { once: true });
    // Si se reempaquetó un H.264 sin recodificar, ese MP4 ya es el video
    // completo en calidad original: queda listo para descargar.
    if (job.remuxed && job.vcodec === 'h264') slot.mp4 = { url: job.downloadUrl, name: mp4Name(slot.name) };
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
  queueBackgroundUpload(slot);
  syncAll(true);
  updateTimeline();
  updateMergeState();
}

function removeSlot(id) {
  const list = slots.some((s) => s.id === id) ? slots : tray;
  const idx = list.findIndex((s) => s.id === id);
  if (idx < 0) return;
  const [slot] = list.splice(idx, 1);
  slot.removed = true;
  slot.video.pause();
  slot.video.removeAttribute('src');
  slot.video.load();
  if (slot.objectUrl) URL.revokeObjectURL(slot.objectUrl);
  if (focusedId === id) focusedId = null;
  render();
  renderTray();
  updateTimeline();
}

// Saca la cámara de la pantalla sin borrarla: queda en "Disponibles" con su
// video ya cargado, lista para volver.
function moveToTray(id) {
  const idx = slots.findIndex((s) => s.id === id);
  if (idx < 0) return;
  const [slot] = slots.splice(idx, 1);
  slot.video.pause();
  slot.audio = false;
  slot.video.muted = true;
  if (focusedId === id) focusedId = null;
  tray.push(slot);
  render();
  renderTray();
  updateTimeline();
  syncAll(true);
}

// Devuelve una cámara de "Disponibles" a la pantalla (en la posición dada).
function activateFromTray(id, atIndex = slots.length) {
  const idx = tray.findIndex((s) => s.id === id);
  if (idx < 0) return false;
  if (slots.length >= MAX_CAMERAS) {
    alert(`Ya hay ${MAX_CAMERAS} cámaras en pantalla. Saca una (botón ⤓) para poner esta.`);
    return false;
  }
  const [slot] = tray.splice(idx, 1);
  slots.splice(Math.min(atIndex, slots.length), 0, slot);
  if (!slot.loaded) loadSlot(slot);
  render();
  renderTray();
  updateTimeline();
  syncAll(true);
  return true;
}

// Mueve una cámara a otra posición de la grilla. Si ahí había otra cámara,
// intercambian lugares; si la celda estaba vacía, pasa al final.
function placeSlot(id, targetIndex) {
  const from = slots.findIndex((s) => s.id === id);
  if (from >= 0) {
    if (targetIndex >= slots.length) {
      const [slot] = slots.splice(from, 1);
      slots.push(slot);
    } else if (targetIndex !== from) {
      [slots[from], slots[targetIndex]] = [slots[targetIndex], slots[from]];
    }
  } else if (tray.some((s) => s.id === id)) {
    // Desde "Disponibles" sobre una cámara: entra en su lugar y la otra sale.
    if (targetIndex < slots.length && slots.length >= MAX_CAMERAS) {
      const replaced = slots[targetIndex];
      moveToTray(replaced.id);
    }
    activateFromTray(id, targetIndex);
    return;
  }
  render();
  syncAll(true);
}

function setMoving(id) {
  movingId = movingId === id ? null : id;
  const banner = $('move-banner');
  if (movingId !== null) {
    const slot = slots.find((s) => s.id === movingId);
    banner.textContent = `Toca el lugar donde quieres poner CAM ${slots.indexOf(slot) + 1} (o toca ✥ otra vez para cancelar).`;
  }
  banner.hidden = movingId === null;
  render();
}

function renderTray() {
  if (typeof renderConcatList === 'function') renderConcatList();
  const section = $('tray');
  const items = $('tray-items');
  section.hidden = tray.length === 0;
  items.innerHTML = '';
  tray.forEach((slot) => {
    const chip = document.createElement('div');
    chip.className = 'chip';
    chip.draggable = true;
    chip.innerHTML = `
      <span class="chip-name"></span>
      <button type="button" data-act="add" title="Mostrar en pantalla">➕ Mostrar</button>
      <button type="button" data-act="delete" title="Eliminar del todo">🗑</button>
    `;
    chip.querySelector('.chip-name').textContent = slot.name;
    chip.title = slot.loaded ? 'Ya cargada' : 'Se cargará al mostrarla';
    chip.querySelector('[data-act="add"]').onclick = () => activateFromTray(slot.id);
    chip.querySelector('[data-act="delete"]').onclick = () => removeSlot(slot.id);
    chip.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/x-cam', String(slot.id));
      e.dataTransfer.effectAllowed = 'move';
    });
    items.appendChild(chip);
  });
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

// Permite soltar ahí una cámara arrastrada (de la grilla o de "Disponibles").
function makeDropTarget(tile, index) {
  tile.addEventListener('dragover', (e) => {
    if (!Array.from(e.dataTransfer.types).includes('text/x-cam')) return;
    e.preventDefault();
    e.stopPropagation();
    tile.classList.add('drop-target');
  });
  tile.addEventListener('dragleave', () => tile.classList.remove('drop-target'));
  tile.addEventListener('drop', (e) => {
    const id = Number(e.dataTransfer.getData('text/x-cam'));
    if (!id) return;
    e.preventDefault();
    e.stopPropagation();
    tile.classList.remove('drop-target');
    placeSlot(id, index);
  });
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
    if (movingId !== null) {
      const id = movingId;
      setMoving(id);
      placeSlot(id, index);
      return;
    }
    pendingTarget = Math.min(index, slots.length);
    fileInput.click();
  });
  makeDropTarget(tile, index);
  return tile;
}

function buildTile(slot, index) {
  const tile = document.createElement('div');
  tile.className = 'tile';
  if (slot.audio) tile.classList.add('has-audio');
  if (movingId === slot.id) tile.classList.add('moving');
  else if (movingId !== null) tile.classList.add('move-candidate');

  tile.appendChild(slot.video);

  const status = document.createElement('div');
  status.className = 'tile-status';
  slot.statusEl = status;
  setSlotStatus(slot, slot.statusText, slot.statusError);
  tile.appendChild(status);

  const bar = document.createElement('div');
  bar.className = 'tile-bar';
  bar.innerHTML = `
    <span class="cam-label" title="${escapeHtml(slot.sourceUrl || slot.name)}"><span class="drag-handle" draggable="true" title="Arrastra para mover esta cámara">⠿</span> CAM ${index + 1} · <span>${escapeHtml(slot.name)}</span></span>
    <span class="tile-tools">
      <label title="Retraso en segundos: positivo = esta cámara empieza después; negativo = se recorta su inicio">
        ⏱<input type="number" step="0.1" value="${slot.delay}" class="delay-input" />s
      </label>
      <button type="button" data-act="audio" title="Escuchar el audio de esta cámara">${slot.audio ? '🔊' : '🔇'}</button>
      <button type="button" data-act="move" title="Mover: toca este botón y luego el lugar de destino">✥</button>
      <button type="button" data-act="left" title="Mover antes">◀</button>
      <button type="button" data-act="right" title="Mover después">▶</button>
      <button type="button" data-act="focus" title="Ampliar / volver a la grilla">${focusedId === slot.id ? '▦' : '⤢'}</button>
      <button type="button" data-act="mp4" title="Descargar esta cámara en MP4">⬇MP4</button>
      <button type="button" data-act="append" title="Agregar la continuación de esta cámara (otro video que sigue después)">🎞+</button>
      <button type="button" data-act="tray" title="Sacar de la pantalla (queda en Disponibles)">⤓</button>
      <button type="button" data-act="remove" title="Eliminar del todo">🗑</button>
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
      if (act === 'tray') moveToTray(slot.id);
      if (act === 'append') pickContinuation(slot);
      if (act === 'mp4') downloadMp4(slot);
      if (act === 'move') setMoving(slot.id);
      if (act === 'focus') toggleFocus(slot.id);
    });
  });
  slot.video.ondblclick = () => toggleFocus(slot.id);
  // En pantallas táctiles no hay "hover": un toque muestra/oculta los botones.
  tile.addEventListener('click', (e) => {
    if (e.target.closest('.tile-tools')) return;
    if (movingId !== null && movingId !== slot.id) {
      const id = movingId;
      setMoving(id);
      placeSlot(id, slots.indexOf(slot));
      return;
    }
    if (window.matchMedia('(hover: none), (max-width: 700px)').matches) tile.classList.toggle('show-tools');
  });

  const handle = bar.querySelector('.drag-handle');
  handle.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('text/x-cam', String(slot.id));
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setDragImage(tile, 20, 20);
    tile.classList.add('dragging');
  });
  handle.addEventListener('dragend', () => tile.classList.remove('dragging'));
  makeDropTarget(tile, slots.indexOf(slot));

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

function timeText(total) {
  const base = `${formatTime(clock)} / ${formatTime(total)}`;
  return clockBase !== null ? `🕒 ${formatClock(clock)}  ·  ${base}` : base;
}

function updateTimeline() {
  const total = totalDuration();
  timeline.max = String(total);
  if (clock > total) clock = total;
  timeline.value = String(clock);
  timeLabel.textContent = timeText(total);
  paintTrimRange(total);
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
    // Con recorte, la reproducción se detiene al final del tramo.
    if (trim && clock >= trim.end && clock - ((ts - (lastFrameTs || ts)) / 1000) * rate < trim.end) {
      clock = trim.end;
      setPlaying(false);
    }
    timeline.value = String(clock);
    timeLabel.textContent = timeText(total);
  }
  lastFrameTs = ts;
  requestAnimationFrame(tick);
}

function setPlaying(value) {
  const anyReady = slots.some((s) => s.ready);
  playing = value && anyReady;
  if (playing && trim && (clock < trim.start || clock >= trim.end - 0.05)) clock = trim.start;
  else if (playing && clock >= totalDuration() - 0.05) clock = 0;
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
  if (typeof renderConcatList === 'function') renderConcatList();
  updateCompressOptions();
  if (typeof updateTrimUI === 'function' && $('trim-hint')) updateTrimUI();
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

function addCompressRow(name, list = $('compress-list')) {
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
  list.appendChild(li);
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

// Tramo de esta cámara que corresponde al recorte común (en segundos de la
// propia cámara). null = la cámara no tiene imagen en ese tramo.
function cameraRange(slot) {
  if (!trim) return { start: 0, length: 0 };
  const start = Math.max(0, trim.start - slot.delay);
  const end = Math.min(slot.duration || Infinity, trim.end - slot.delay);
  if (end <= start) return null;
  return { start, length: end - start };
}

async function compressSlot(slot, level, row, autoDownload) {
  const range = cameraRange(slot);
  if (!range) {
    row.set('Sin imagen en el tramo elegido: se omite.', 100, 'error');
    return;
  }
  try {
    const job = await withFile(
      slot,
      (pct, bytes, note) => row.set(`Subiendo… ${pct || 0}%${note ? ` (${note})` : ''}`, (pct || 0) * 0.3),
      (fileId) =>
        runServerJob(
          () =>
            postJson('/api/compress', {
              fileId,
              level,
              expectedDuration: slot.duration || 0,
              start: range.start,
              length: range.length,
            }),
          (j) => {
            const verb = level === 'corte' ? 'Cortando' : 'Comprimiendo';
            if (j.status === 'queued') row.set('En cola…', 30);
            else row.set(`${verb}… ${j.progress}%`, 30 + j.progress * 0.7);
          }
        )
    );
    const saved = job.inputBytes ? Math.min(99, Math.round((1 - job.outputBytes / job.inputBytes) * 100)) : 0;
    const summary =
      level === 'corte'
        ? `tramo de ${formatTime(range.length || slot.duration)} · ${formatBytes(job.outputBytes)}`
        : saved > 0
        ? `${formatBytes(job.inputBytes)} → ${formatBytes(job.outputBytes)} (−${saved}%)`
        : `${formatBytes(job.inputBytes)} → ${formatBytes(job.outputBytes)} (el original ya estaba bien comprimido)`;
    row.set(`✅ ${summary}`, 100, 'success');
    const link = document.createElement('a');
    link.className = 'btn success';
    link.href = job.downloadUrl;
    link.setAttribute('download', job.fileName);
    link.textContent = level === 'corte' ? '⬇ Descargar corte' : '⬇ Descargar comprimido';
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
    const uploadAll = () =>
      Promise.all(
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
    let fileIds = await uploadAll();
    // Si el servidor perdió algún video (se reinició), se vuelve a subir.
    const reuploadMissing = async () => {
      const { missing } = await withRetry(() => postJson('/api/files/check', { fileIds }));
      if (!missing.length) return;
      current.forEach((slot, i) => {
        if (missing.includes(fileIds[i])) slot.fileIdPromise = null;
      });
      setMergeStatus('Algunos videos se perdieron en el servidor; volviendo a subirlos…', 5);
      fileIds = await uploadAll();
    };
    await reuploadMissing();

    const [cols, rows] = mergeLayout();
    // Solo sirve para mostrar el progreso: si falta alguna duración, se omite.
    const expectedDuration = current.every((s) => s.ready && s.duration)
      ? current.reduce((max, s) => Math.max(max, s.delay + s.duration), 0)
      : 0;
    const mosaicBody = () => ({
      items: current.map((slot, i) => ({ fileId: fileIds[i], delay: slot.delay, duration: slot.duration || 0 })),
      start: trim ? trim.start : 0,
      end: trim ? trim.end : 0,
      cols,
      rows,
      width: opts.width || Number($('width-select').value),
      fps: opts.fps || Number($('fps-select').value),
      quality: opts.quality || $('quality-select').value,
      speed: $('speed-merge-select').value,
      audioIndex: Number(audioSelect.value),
      expectedDuration,
    });

    setMergeStatus('Uniendo videos…', 30);
    const onMergeProgress = (j) => {
      if (j.status === 'queued') setMergeStatus('En cola…', 30);
      else setMergeStatus(`Uniendo videos… ${j.progress}%`, 30 + j.progress * 0.7);
    };
    let job;
    for (let attempt = 0; ; attempt++) {
      try {
        job = await runServerJob(() => postJson('/api/mosaic', mosaicBody()), onMergeProgress);
        break;
      } catch (err) {
        // El servidor perdió algún video (reinicio): se vuelve a subir y se repite.
        if (attempt >= 2 || !(err.data && err.data.code === 'FILE_MISSING')) throw err;
        await reuploadMissing();
      }
    }

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
// Recorte y sincronización por hora del nombre
// ---------------------------------------------------------------------------

function pad2(n) {
  return String(n).padStart(2, '0');
}

// Hora real (HH:MM:SS) de un segundo de la línea de tiempo.
function formatClock(t) {
  const d = new Date(clockBase + Math.round(t * 1000));
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

// Texto para los campos Desde/Hasta: hora real si se sincronizó por nombre,
// si no tiempo del video (h:mm:ss).
function formatTrimField(t) {
  if (clockBase !== null) return formatClock(t);
  const s = Math.round(t);
  return `${pad2(Math.floor(s / 3600))}:${pad2(Math.floor((s % 3600) / 60))}:${pad2(s % 60)}`;
}

// Acepta "1:23", "01:23:45", "83" (segundos) o, con hora real, "09:35:00".
function parseTrimField(text) {
  const parts = String(text).trim().split(/[:.,h m]+/).filter(Boolean).map(Number);
  if (!parts.length || parts.some((n) => !Number.isFinite(n) || n < 0)) return null;
  const secs = parts.reduce((acc, n) => acc * 60 + n, 0);
  if (clockBase === null) return secs;
  // Hora del día: se convierte a segundos desde el inicio de la grabación.
  const hms = parts.length === 2 ? secs * 60 : secs;
  const base = new Date(clockBase);
  const baseSecs = base.getHours() * 3600 + base.getMinutes() * 60 + base.getSeconds() + base.getMilliseconds() / 1000;
  let t = hms - baseSecs;
  if (t < -60) t += 86400; // pasó la medianoche
  return Math.max(0, t);
}

function paintTrimRange(total) {
  if (!trim || !total) {
    timeline.style.background = '';
    return;
  }
  const a = (trim.start / total) * 100;
  const b = (trim.end / total) * 100;
  timeline.style.background = `linear-gradient(to right, #334155 ${a}%, #f59e0b ${a}%, #f59e0b ${b}%, #334155 ${b}%)`;
  timeline.style.borderRadius = '999px';
  timeline.style.height = '6px';
}

function setTrim(start, end) {
  const total = totalDuration();
  start = Math.max(0, Math.min(start ?? 0, total));
  end = Math.max(0, Math.min(end ?? total, total));
  trim = end - start >= 0.5 ? { start, end } : null;
  updateTrimUI();
  updateTimeline();
}

function updateTrimUI() {
  const has = !!trim;
  const startEl = $('trim-start');
  const endEl = $('trim-end');
  if (document.activeElement !== startEl) startEl.value = has ? formatTrimField(trim.start) : '';
  if (document.activeElement !== endEl) endEl.value = has ? formatTrimField(trim.end) : '';
  startEl.placeholder = clockBase !== null ? 'hh:mm:ss (hora)' : '00:00:00';
  endEl.placeholder = startEl.placeholder;
  const text = has
    ? `Tramo: ${formatTrimField(trim.start)} → ${formatTrimField(trim.end)} (${formatTime(trim.end - trim.start)}). ` +
      'Se usa al reproducir, al unir, al comprimir y al cortar.'
    : 'Sin recorte: se usa el video completo. Marca el inicio y el fin mientras miras, o escribe los tiempos.';
  $('trim-hint').textContent = text;
  const ready = slots.length > 0 && slots.some((s) => s.ready);
  $('trim-cut-btn').disabled = !ready || $('trim-cut-btn').dataset.busy === '1';
  $('trim-merge-btn').disabled = !ready || mergeBtn.dataset.busy === '1';
  // Aviso en "Unir" y "Comprimir" para que se note que hay un recorte activo.
  document.querySelectorAll('.trim-badge').forEach((el) => el.remove());
  if (has) {
    ['merge-section-head', 'compress-section-head'].forEach((id) => {
      const head = $(id);
      if (!head) return;
      const badge = document.createElement('span');
      badge.className = 'trim-badge';
      badge.textContent = `✂ Solo el tramo ${formatTrimField(trim.start)} → ${formatTrimField(trim.end)}`;
      head.appendChild(badge);
    });
  }
}

// Busca la hora de inicio en el nombre del archivo del DVR. Formatos:
//  - 20261006093000 (AAAAMMDDhhmmss)
//  - 261005-050000-074700 (AAMMDD-inicio-fin)
//  - ch1_261006093000_261006095000 (AAMMDDhhmmss)
function startTimeFromName(name) {
  const valid = (y, mo, d, h, mi, se) => mo >= 1 && mo <= 12 && d >= 1 && d <= 31 && h < 24 && mi < 60 && se < 60;
  const make = (y, mo, d, h, mi, se) => (valid(y, mo, d, h, mi, se) ? new Date(y, mo - 1, d, h, mi, se).getTime() : null);
  let m = name.match(/(?<!\d)(20\d{2})(\d{2})(\d{2})[_-]?(\d{2})(\d{2})(\d{2})(?!\d)/);
  if (m) {
    const t = make(+m[1], +m[2], +m[3], +m[4], +m[5], +m[6]);
    if (t) return t;
  }
  m = name.match(/(?<!\d)(\d{2})(\d{2})(\d{2})[-_](\d{2})(\d{2})(\d{2})[-_]\d{6}(?!\d)/);
  if (m) {
    const t = make(2000 + +m[1], +m[2], +m[3], +m[4], +m[5], +m[6]);
    if (t) return t;
  }
  m = name.match(/(?<!\d)(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?!\d)/);
  if (m) {
    const t = make(2000 + +m[1], +m[2], +m[3], +m[4], +m[5], +m[6]);
    if (t) return t;
  }
  return null;
}

function syncByNames() {
  const found = slots.map((s) => ({ slot: s, t: startTimeFromName(s.name) }));
  const ok = found.filter((f) => f.t !== null);
  const hint = $('sync-hint');
  if (ok.length === 0) {
    hint.textContent = '⚠ Ningún nombre de archivo trae la hora de inicio. Ajusta el retraso (⏱) de cada cámara a mano.';
    return;
  }
  const base = Math.min(...ok.map((f) => f.t));
  ok.forEach(({ slot, t }) => {
    slot.delay = Math.round((t - base) / 100) / 10;
  });
  clockBase = base;
  const missing = found.filter((f) => f.t === null).map((f) => `CAM ${slots.indexOf(f.slot) + 1}`);
  hint.textContent =
    `✅ Sincronizadas ${ok.length} cámara(s) desde las ${formatClock(0)}.` +
    (missing.length ? ` ⚠ Sin hora en el nombre: ${missing.join(', ')} (ajusta su ⏱ a mano).` : '');
  render();
  updateTrimUI();
  updateTimeline();
  syncAll(true);
}

async function cutEachCamera() {
  const btn = $('trim-cut-btn');
  const list = $('trim-list');
  list.innerHTML = '';
  btn.dataset.busy = '1';
  updateTrimUI();
  await Promise.all(
    slots.map((slot, i) => compressSlot(slot, 'corte', addCompressRow(`Cámara ${i + 1} · ${slot.name}`, list), false))
  );
  delete btn.dataset.busy;
  updateTrimUI();
}

$('sync-names-btn').addEventListener('click', syncByNames);
$('trim-mark-start').addEventListener('click', () => setTrim(clock, trim && trim.end > clock ? trim.end : totalDuration()));
$('trim-mark-end').addEventListener('click', () => setTrim(trim && trim.start < clock ? trim.start : 0, clock));
$('trim-clear').addEventListener('click', () => setTrim(0, 0));
['trim-start', 'trim-end'].forEach((id) => {
  const el = $(id);
  el.addEventListener('change', () => {
    const start = parseTrimField($('trim-start').value || '0');
    const end = $('trim-end').value ? parseTrimField($('trim-end').value) : totalDuration();
    const bad = start === null || end === null || end <= start;
    el.classList.toggle('invalid', bad);
    if (!bad) setTrim(start, end);
  });
});
$('trim-cut-btn').addEventListener('click', cutEachCamera);
$('trim-merge-btn').addEventListener('click', () => {
  $('merge-section-head').scrollIntoView({ behavior: 'smooth', block: 'start' });
  merge();
});

// ---------------------------------------------------------------------------
// Unir continuaciones (varias partes de una misma cámara)
// ---------------------------------------------------------------------------

// Nombre del canal sin fechas/horas, para reconocer las partes de una misma
// cámara: "ch1_261006093000_261006095000.avi" → "ch1".
function channelKey(name) {
  const key = name
    .replace(/\s*\(\+\d+ partes?\)$/, '')
    .replace(/\.[a-z0-9]{2,5}$/i, '')
    .replace(/(?<!\d)20\d{12}(?!\d)/g, '')
    .replace(/(?<!\d)\d{6}[-_]\d{6}([-_]\d{6})?(?!\d)/g, '')
    .replace(/(?<!\d)\d{12}(?!\d)/g, '')
    .replace(/\d{9,}/g, '')
    .replace(/[\s_\-.]+/g, ' ')
    .trim()
    .toLowerCase();
  return /[a-z0-9]/.test(key) ? key : null;
}

function concatOrder(parts) {
  const times = parts.map((p) => startTimeFromName(p.name));
  const allTimed = times.every((t) => t !== null);
  const ordered = parts
    .map((p, i) => ({ p, t: times[i], i }))
    .sort((a, b) => (allTimed ? a.t - b.t : a.p.name.localeCompare(b.p.name, 'es', { numeric: true })));
  return { ordered: ordered.map((o) => o.p), times: allTimed ? ordered.map((o) => o.t) : null };
}

function addConcatRow(name) {
  return addCompressRow(name, $('concat-list'));
}

// Une las partes en un solo video y lo deja en "base" (la cámara que queda en
// pantalla). Las demás partes se quitan porque ya quedaron dentro.
async function joinParts(base, others) {
  const { ordered, times } = concatOrder([base, ...others]);
  const first = ordered[0];
  const concatRow = addConcatRow(`${first.name} + ${ordered.length - 1} parte(s)`);
  // El avance se ve también en la cámara misma mientras se une.
  const row = {
    li: concatRow.li,
    set(text, pct, type) {
      concatRow.set(text, pct, type);
      if (slots.includes(base) && !base.ready && type !== 'success') setSlotStatus(base, `🎞 ${text}`, type === 'error');
    },
  };
  const fillGaps = $('concat-gaps').checked && times;
  // Partes que están en este equipo: se intenta unir aquí, sin subirlas.
  if (ordered.every((s) => s.file) && LocalFF.canUse(ordered.map((s) => s.file))) {
    try {
      const done = await joinPartsLocally(base, ordered, times, fillGaps, row);
      if (done) return true;
    } catch {
      // se intenta en el servidor
    }
  }
  try {
    const progress = ordered.map(() => 0);
    const fileIds = await Promise.all(
      ordered.map((slot, i) =>
        ensureUploaded(slot, (pct) => {
          progress[i] = pct || 0;
          const avg = Math.round(progress.reduce((a, b) => a + b, 0) / ordered.length);
          row.set(`Subiendo partes… ${avg}%`, avg * 0.4);
        })
      )
    );
    const offsets = fillGaps ? times.map((t) => (t - times[0]) / 1000) : undefined;
    const name = `${first.name.replace(/\s*\(\+\d+ partes?\)$/, '')} (+${ordered.length - 1} parte${ordered.length > 2 ? 's' : ''})`;
    const job = await runServerJob(
      () => postJson('/api/concat', { fileIds, offsets, name }),
      (j) => row.set(j.status === 'queued' ? 'En cola…' : `Uniendo partes… ${j.progress}%`, 40 + j.progress * 0.6)
    );

    // Las otras partes ya están dentro del video unido.
    ordered.filter((s) => s !== base).forEach((s) => removeSlot(s.id));
    base.name = name;
    base.file = null;
    base.sourceUrl = null;
    base.keepName = true;
    base.fileIdPromise = Promise.resolve(job.fileId);
    base.mediaUrl = job.mediaUrl;
    base.mp4 = { url: job.downloadUrl, name: mp4Name(name) };
    base.ready = false;
    base.duration = 0;
    if (clockBase !== null && times) base.delay = Math.round((times[0] - clockBase) / 100) / 10;
    if (slots.includes(base)) loadSlot(base);
    else base.loaded = false;
    render();
    renderTray();
    updateTimeline();

    const gapNote = job.gaps ? ` · ${job.gaps} hueco(s) rellenado(s) con negro` : '';
    row.set(`✅ ${ordered.length} partes unidas · ${formatTime(job.duration || 0)}${gapNote}`, 100, 'success');
    const link = document.createElement('a');
    link.className = 'btn success';
    link.href = job.downloadUrl;
    link.setAttribute('download', job.fileName);
    link.textContent = '⬇ Descargar video unido';
    row.li.appendChild(link);
    return true;
  } catch (err) {
    row.set(err.message || 'Error al unir las partes.', 100, 'error');
    return false;
  }
}

// --- Descargar en MP4 ---

function mp4Name(name) {
  const clean = String(name).replace(/\s*\(\+(\d+) partes?\)$/, '_unido_$1').replace(/\.[a-z0-9]{2,5}(?=(_unido_\d+)?$)/i, '');
  return `${clean}.mp4`;
}

function withName(url, name) {
  return `${url}${url.includes('?') ? '&' : '?'}name=${encodeURIComponent(name)}`;
}

// MP4 compatible con cualquier reproductor (H.264 + AAC), en calidad original.
// - Si ya existe (video MP4 propio, reempaquetado sin recodificar o unido), se
//   descarga al instante.
// - Si no (p. ej. el DVR grabó en H.265), se convierte en el servidor.
async function downloadMp4(slot, { auto = true } = {}) {
  if (slot.mp4) {
    if (auto) triggerDownload(slot.mp4.url.startsWith('blob:') ? slot.mp4.url : withName(slot.mp4.url, slot.mp4.name), slot.mp4.name);
    return slot.mp4;
  }
  if (slot.file && /\.mp4$/i.test(slot.name) && slot.ready && slot.objectUrl) {
    slot.mp4 = { url: slot.objectUrl, name: slot.name };
    return downloadMp4(slot, { auto });
  }
  if (slot.mp4Promise) return slot.mp4Promise;
  const show = (text, isError) => {
    if (slots.includes(slot)) setSlotStatus(slot, text, isError);
  };
  const keepReady = slot.ready;
  slot.mp4Promise = (async () => {
    try {
      const job = await withFile(
        slot,
        (pct) => show(`⬇ MP4: subiendo… ${pct || 0}%`),
        (fileId) =>
          runServerJob(
            () => postJson('/api/compress', { fileId, level: 'corte', expectedDuration: slot.duration || 0 }),
            (j) => show(j.status === 'queued' ? '⬇ MP4: en cola…' : `⬇ MP4: convirtiendo… ${j.progress}%`)
          )
      );
      slot.mp4 = { url: job.downloadUrl, name: mp4Name(slot.name) };
      if (keepReady) show('');
      if (auto) triggerDownload(withName(slot.mp4.url, slot.mp4.name), slot.mp4.name);
      return slot.mp4;
    } catch (err) {
      show(`⬇ MP4: ${err.message || 'no se pudo convertir'}`, true);
      throw err;
    } finally {
      slot.mp4Promise = null;
    }
  })();
  return slot.mp4Promise;
}

async function downloadAllMp4() {
  const btn = $('mp4-all-btn');
  btn.disabled = true;
  const list = $('compress-list');
  list.innerHTML = '';
  for (const [i, slot] of slots.entries()) {
    const row = addCompressRow(`Cámara ${i + 1} · ${slot.name}`, list);
    row.set(slot.mp4 ? 'Listo' : 'Preparando MP4…', slot.mp4 ? 100 : 30);
    try {
      const mp4 = await downloadMp4(slot, { auto: false });
      row.set(`✅ ${mp4.name}`, 100, 'success');
      const link = document.createElement('a');
      link.className = 'btn success';
      link.href = mp4.url.startsWith('blob:') ? mp4.url : withName(mp4.url, mp4.name);
      link.setAttribute('download', mp4.name);
      link.textContent = '⬇ Descargar MP4';
      row.li.appendChild(link);
    } catch (err) {
      row.set(err.message || 'No se pudo convertir.', 100, 'error');
    }
  }
  btn.disabled = false;
}

$('mp4-all-btn').addEventListener('click', downloadAllMp4);

// --- Unir en el equipo (sin subir) ---

async function joinPartsLocally(base, ordered, times, fillGaps, row) {
  row.set('Revisando partes en tu equipo…', 5);
  const files = ordered.map((s) => s.file);
  const infos = await LocalFF.probe(files);
  // Huecos de tiempo entre partes: rellenarlos requiere recodificar → servidor.
  if (fillGaps && infos.length === files.length) {
    for (let i = 1; i < files.length; i++) {
      const gap = (times[i] - times[i - 1]) / 1000 - (infos[i - 1].duration || 0);
      if (gap > 1) return false;
    }
  }
  row.set('Uniendo en tu equipo…', 10);
  const result = await LocalFF.concat(files, { onProgress: (pct) => row.set(`Uniendo en tu equipo… ${pct}%`, 10 + pct * 0.9) });
  if (!result) return false;

  const name = `${ordered[0].name.replace(/\s*\(\+\d+ partes?\)$/, '')} (+${ordered.length - 1} parte${ordered.length > 2 ? 's' : ''})`;
  ordered.filter((s) => s !== base).forEach((s) => removeSlot(s.id));
  const file = new File([result.blob], mp4Name(name), { type: 'video/mp4' });
  base.name = name;
  base.file = file;
  base.sourceUrl = null;
  base.keepName = true;
  base.fileIdPromise = null; // se subirá solo si hace falta (mosaico, comprimir)
  base.mediaUrl = URL.createObjectURL(result.blob);
  base.mp4 = { url: base.mediaUrl, name: file.name };
  base.ready = false;
  base.duration = 0;
  if (clockBase !== null && times) base.delay = Math.round((times[0] - clockBase) / 100) / 10;
  if (slots.includes(base)) loadSlot(base);
  else base.loaded = false;
  render();
  renderTray();
  updateTimeline();

  row.set(`✅ ${ordered.length} partes unidas en tu equipo · ${formatTime(result.duration)} (sin subir nada)`, 100, 'success');
  const link = document.createElement('a');
  link.className = 'btn success';
  link.href = base.mediaUrl;
  link.setAttribute('download', file.name);
  link.textContent = '⬇ Descargar video unido';
  row.li.appendChild(link);
  return true;
}

// --- Subida en segundo plano ---
// Mientras se mira, cada cámara se va subiendo (de a una) para que "Unir" y
// "Comprimir" empiecen enseguida en vez de esperar la subida.

const bgUploadQueue = [];
let bgUploading = false;

function bgUploadEnabled() {
  const box = $('bg-upload');
  return box && box.checked;
}

function queueBackgroundUpload(slot) {
  if (!bgUploadEnabled() || slot.fileIdPromise || (!slot.file && !slot.sourceUrl) || bgUploadQueue.includes(slot)) return;
  bgUploadQueue.push(slot);
  pumpBackgroundUploads();
}

async function pumpBackgroundUploads() {
  if (bgUploading) return;
  bgUploading = true;
  while (bgUploadQueue.length && bgUploadEnabled()) {
    const slot = bgUploadQueue.shift();
    if (slot.removed || slot.fileIdPromise || (!slot.file && !slot.sourceUrl)) continue;
    try {
      await ensureUploaded(slot, () => {});
    } catch {
      // se reintentará cuando se use
    }
  }
  bgUploading = false;
}

(() => {
  const box = $('bg-upload');
  try {
    box.checked = localStorage.getItem('bgUpload') !== '0';
  } catch {
    // sin almacenamiento
  }
  box.addEventListener('change', () => {
    try {
      localStorage.setItem('bgUpload', box.checked ? '1' : '0');
    } catch {
      // sin almacenamiento
    }
    if (box.checked) slots.forEach(queueBackgroundUpload);
  });
})();

// --- Unir al cargar ---

function autoJoinEnabled() {
  const box = $('concat-onload');
  return !box || box.checked;
}

// Separa los videos que son continuaciones (mismo canal, 2 o más partes) de
// los sueltos.
function groupContinuations(sources) {
  const byKey = new Map();
  sources.forEach((src) => {
    const key = channelKey(src.name);
    if (!key) return;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(src);
  });
  const grouped = new Set();
  const groups = [];
  byKey.forEach((list) => {
    if (list.length < 2) return;
    list.forEach((src) => grouped.add(src));
    groups.push(list);
  });
  return { singles: sources.filter((src) => !grouped.has(src)), groups };
}

// Crea una sola cámara para el grupo y une sus partes enseguida. Si la unión
// falla, las partes quedan como cámaras sueltas para no perder nada.
function startGroupJoin(group) {
  const partSlots = group.map((src) => createSlot(src));
  const { ordered } = concatOrder(partSlots);
  const base = ordered[0];
  const others = ordered.slice(1);
  base.loaded = true; // no se prepara para ver hasta que esté unida
  if (slots.length < MAX_CAMERAS) slots.push(base);
  else tray.push(base);
  setSlotStatus(base, `🎞 Uniendo ${ordered.length} partes…`);
  $('concat-hint').textContent = `Uniendo automáticamente ${ordered.length} partes de "${channelKey(base.name)}" al cargar.`;
  render();
  renderTray();
  joinParts(base, others).then((ok) => {
    if (ok) return;
    if (slots.includes(base)) loadSlot(base);
    else base.loaded = false;
    others.forEach((slot) => tray.push(slot));
    renderTray();
  });
}

$('concat-onload').checked = (() => {
  try {
    return localStorage.getItem('concatOnLoad') !== '0';
  } catch {
    return true;
  }
})();
$('concat-onload').addEventListener('change', () => {
  try {
    localStorage.setItem('concatOnLoad', $('concat-onload').checked ? '1' : '0');
  } catch {
    // sin almacenamiento: solo dura esta visita
  }
});

// Botón 🎞+ de una cámara: elegir los archivos que siguen después.
let continuationBase = null;
function pickContinuation(slot) {
  continuationBase = slot;
  $('append-input').click();
}

$('append-input').addEventListener('change', async () => {
  const base = continuationBase;
  const files = Array.from($('append-input').files);
  $('append-input').value = '';
  continuationBase = null;
  if (!base || !files.length) return;
  const parts = files.map((file) => createSlot({ file, name: file.name }));
  $('concat-section-head').scrollIntoView({ behavior: 'smooth', block: 'start' });
  await joinParts(base, parts);
});

function renderConcatList() {
  const list = $('concat-choices');
  if (!list) return;
  const checked = new Set(Array.from(list.querySelectorAll('input:checked')).map((c) => Number(c.value)));
  list.innerHTML = '';
  [...slots, ...tray].forEach((slot) => {
    const li = document.createElement('li');
    const where = slots.includes(slot) ? `CAM ${slots.indexOf(slot) + 1}` : 'Disponible';
    li.innerHTML = `<label><input type="checkbox" value="${slot.id}" ${checked.has(slot.id) ? 'checked' : ''} /> <b></b> <span></span></label>`;
    li.querySelector('b').textContent = where;
    li.querySelector('span').textContent = slot.name;
    list.appendChild(li);
  });
  $('concat-empty').hidden = slots.length + tray.length > 0;
}

async function joinSelected() {
  const ids = Array.from($('concat-choices').querySelectorAll('input:checked')).map((c) => Number(c.value));
  const chosen = [...slots, ...tray].filter((s) => ids.includes(s.id));
  if (chosen.length < 2) {
    alert('Marca al menos 2 videos: la primera parte y su continuación.');
    return;
  }
  const base = chosen.find((s) => slots.includes(s)) || chosen[0];
  await joinParts(base, chosen.filter((s) => s !== base));
  if (!slots.includes(base)) activateFromTray(base.id);
}

// Agrupa por canal todas las cámaras (en pantalla y en Disponibles) y une las
// partes de cada una. Devuelve cuántos grupos se unieron.
async function joinAllByChannel() {
  const groups = new Map();
  const unknown = [];
  [...slots, ...tray].forEach((slot) => {
    const key = channelKey(slot.name);
    if (!key) return unknown.push(slot.name);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(slot);
  });
  const toJoin = [...groups.values()].filter((g) => g.length > 1);
  const note = $('concat-hint');
  if (!toJoin.length) {
    note.textContent =
      '⚠ No encontré partes del mismo canal (nombres como ch1_…, ch1_…). Marca a mano los videos que van juntos y pulsa "Unir seleccionadas".';
    return 0;
  }
  note.textContent = `Encontré ${toJoin.length} cámara(s) con continuaciones: ${toJoin
    .map((g) => `${channelKey(g[0].name)} (${g.length} partes)`)
    .join(', ')}.${unknown.length ? ` Sin canal reconocible: ${unknown.length} video(s).` : ''}`;
  for (const group of toJoin) {
    const base = group.find((s) => slots.includes(s)) || group[0];
    await joinParts(base, group.filter((s) => s !== base));
    if (!slots.includes(base) && slots.length < MAX_CAMERAS) activateFromTray(base.id);
  }
  return toJoin.length;
}

$('append-input').accept = fileInput.accept;
$('concat-auto-btn').addEventListener('click', () => joinAllByChannel());
$('concat-selected-btn').addEventListener('click', joinSelected);
$('concat-and-merge-btn').addEventListener('click', async () => {
  await joinAllByChannel();
  $('merge-section-head').scrollIntoView({ behavior: 'smooth', block: 'start' });
  await merge();
});

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
  [...slots, ...tray].forEach((s) => removeSlot(s.id));
  ['concat-list', 'trim-list', 'compress-list'].forEach((id) => {
    $(id).innerHTML = '';
  });
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
  } else if (e.key === 'Escape' && movingId !== null) setMoving(movingId);
  else if (e.key === 'Escape' && document.body.classList.contains('pseudo-full')) setPseudoFullscreen(false);
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
