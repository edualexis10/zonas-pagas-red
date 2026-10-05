const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const express = require('express');
const multer = require('multer');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');

ffmpeg.setFfmpegPath(ffmpegPath);

const UPLOAD_DIR = path.join(__dirname, 'uploads');
const OUTPUT_DIR = path.join(__dirname, 'converted');
[UPLOAD_DIR, OUTPUT_DIR].forEach((dir) => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

const ALLOWED_FORMATS = ['mp4', 'avi', 'mov', 'mkv', 'webm', 'gif'];
const MAX_FILE_SIZE = 2 * 1024 * 1024 * 1024; // 2 GB por video

// Varias conversiones a la vez, pero acotadas a los núcleos disponibles
// para no saturar el servidor cuando llegan muchos videos juntos.
const CONCURRENCY = Math.max(1, os.cpus().length - 1);
let active = 0;
const queue = [];

function runNext() {
  if (active >= CONCURRENCY || queue.length === 0) return;
  active += 1;
  const task = queue.shift();
  task().finally(() => {
    active -= 1;
    runNext();
  });
}

function enqueue(task) {
  queue.push(task);
  runNext();
}

const jobs = new Map(); // jobId -> { status, progress, downloadUrl, mediaUrl, fileName, error }

function createJob(originalName) {
  const id = crypto.randomUUID();
  jobs.set(id, {
    id,
    originalName,
    status: 'queued', // queued | processing | done | error
    progress: 0,
    downloadUrl: null,
    mediaUrl: null,
    fileName: null,
    error: null,
  });
  return id;
}

const CODEC_BY_FORMAT = {
  mp4: { video: 'libx264', audio: 'aac' },
  mkv: { video: 'libx264', audio: 'aac' },
  mov: { video: 'libx264', audio: 'aac' },
  webm: { video: 'libvpx-vp9', audio: 'libopus' },
};

function buildCommand(inputPath, format, { fastRemux }) {
  const command = ffmpeg(inputPath);

  if (format === 'gif') {
    command.noAudio().outputOptions(['-vf', 'fps=10,scale=480:-1:flags=lanczos']);
    return command.toFormat('gif');
  }

  if (fastRemux) {
    // Copia los streams sin recodificar: casi instantáneo cuando el
    // video de entrada ya usa códecs compatibles con el contenedor destino.
    command.outputOptions(['-c', 'copy']);
  } else {
    const codecs = CODEC_BY_FORMAT[format];
    if (codecs) {
      command.videoCodec(codecs.video).audioCodec(codecs.audio);
    }
    // Multi-hilo + preset veryfast: prioriza velocidad de conversión.
    command.outputOptions(['-threads', '0']);
    if (codecs && codecs.video === 'libx264') {
      command.outputOptions(['-preset', 'veryfast']);
    }
  }

  if (format === 'mp4') {
    command.outputOptions(['-movflags', '+faststart']);
  }

  return command.toFormat(format);
}

function convert(inputPath, outputPath, format, onProgress) {
  return new Promise((resolve, reject) => {
    const tryRun = (fastRemux) => {
      const command = buildCommand(inputPath, format, { fastRemux });
      command
        .on('progress', (info) => {
          if (typeof info.percent === 'number') {
            onProgress(Math.min(99, Math.max(0, Math.round(info.percent))));
          }
        })
        .on('error', (err) => {
          if (fastRemux) {
            // El remux directo falló (códecs incompatibles): reintenta recodificando.
            tryRun(false);
          } else {
            reject(err);
          }
        })
        .on('end', () => resolve())
        .save(outputPath);
    };

    // Para mp4/mkv/mov intenta primero copiar los streams (mucho más rápido);
    // si el origen no es compatible, ffmpeg falla rápido y se recodifica.
    const canFastRemux = ['mp4', 'mkv', 'mov'].includes(format);
    tryRun(canFastRemux);
  });
}

function enqueueConversionJob(inputPath, originalName, format) {
  const jobId = createJob(originalName);

  enqueue(async () => {
    const job = jobs.get(jobId);
    job.status = 'processing';

    const baseName = path.parse(originalName).name.replace(/[^a-zA-Z0-9_-]/g, '_');
    const outputName = `${baseName}-${Date.now()}-${jobId.slice(0, 8)}.${format}`;
    const outputPath = path.join(OUTPUT_DIR, outputName);

    try {
      await convert(inputPath, outputPath, format, (percent) => {
        job.progress = percent;
      });
      job.status = 'done';
      job.progress = 100;
      job.fileName = outputName;
      job.downloadUrl = `/api/download/${encodeURIComponent(outputName)}`;
    } catch (err) {
      job.status = 'error';
      job.error = err.message || 'Error al convertir el video.';
    } finally {
      fs.unlink(inputPath, () => {});
    }
  });

  return jobId;
}

// Ejecuta un comando de ffmpeg reportando el progreso. Si se conoce la
// duración esperada (p. ej. el mosaico, con varias entradas), el porcentaje
// se calcula a partir del tiempo procesado; si no, se usa el que estima ffmpeg.
function runCommand(command, outputPath, onProgress, expectedDuration) {
  return new Promise((resolve, reject) => {
    command
      .on('progress', (info) => {
        let percent = null;
        if (expectedDuration > 0 && info.timemark) {
          percent = (timemarkToSeconds(info.timemark) / expectedDuration) * 100;
        } else if (typeof info.percent === 'number') {
          percent = info.percent;
        }
        if (percent !== null && Number.isFinite(percent)) {
          onProgress(Math.min(99, Math.max(0, Math.round(percent))));
        }
      })
      .on('error', (err) => reject(err))
      .on('end', () => resolve())
      .save(outputPath);
  });
}

function timemarkToSeconds(timemark) {
  const parts = String(timemark).split(':').map(Number);
  if (parts.some((n) => !Number.isFinite(n))) return 0;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

function finishJob(job, outputName) {
  job.status = 'done';
  job.progress = 100;
  job.fileName = outputName;
  job.downloadUrl = `/api/download/${encodeURIComponent(outputName)}`;
  job.mediaUrl = `/api/media/${encodeURIComponent(outputName)}`;
}

// ---------------------------------------------------------------------------
// Visor multicámara y mosaico
// ---------------------------------------------------------------------------

const MAX_CAMERAS = 8;
const AUDIO_ALL = -2; // audioIndex especial: cada cámara en su propia pista
// Videos subidos con purpose=store: se guardan tal cual para poder generar
// vistas previas reproducibles y luego unirlos en un mosaico sin resubirlos.
const storedFiles = new Map(); // fileId -> { path, originalName }

function getStoredFile(fileId) {
  const stored = storedFiles.get(String(fileId));
  if (!stored || !fs.existsSync(stored.path)) return null;
  return stored;
}

function safeBaseName(originalName) {
  return path.parse(originalName).name.replace(/[^a-zA-Z0-9_-]/g, '_') || 'video';
}

// Vista previa: recodifica a H.264/AAC en MP4 (lo que cualquier navegador
// reproduce) a máximo 720p y con preset ultrafast para que esté lista rápido.
// Se usa para formatos que el navegador no abre directamente (AVI, DAV,
// H.264/H.265 crudo de DVR, HEVC, etc.).
// Si el navegador no tiene H.264 (p. ej. algunas versiones de Chromium/Linux)
// se genera WebM VP8 en modo tiempo real.
function enqueuePreviewJob(fileId, format) {
  const stored = getStoredFile(fileId);
  const jobId = createJob(stored.originalName);

  enqueue(async () => {
    const job = jobs.get(jobId);
    job.status = 'processing';
    const outputName = `${safeBaseName(stored.originalName)}-preview-${jobId.slice(0, 8)}.${format}`;
    const command = ffmpeg(stored.path).outputOptions([
      '-map', '0:v:0',
      '-map', '0:a:0?',
      '-vf', "scale='min(1280,iw)':-2,format=yuv420p",
      '-threads', '0',
    ]);
    if (format === 'webm') {
      command
        .videoCodec('libvpx')
        .audioCodec('libopus')
        .outputOptions(['-deadline', 'realtime', '-cpu-used', '8', '-b:v', '2M'])
        .toFormat('webm');
    } else {
      command
        .videoCodec('libx264')
        .audioCodec('aac')
        .outputOptions(['-preset', 'ultrafast', '-crf', '26', '-movflags', '+faststart'])
        .toFormat('mp4');
    }

    try {
      await runCommand(command, path.join(OUTPUT_DIR, outputName), (p) => {
        job.progress = p;
      });
      finishJob(job, outputName);
    } catch (err) {
      job.status = 'error';
      job.error = `No se pudo leer el video: ${err.message}`;
    }
  });

  return jobId;
}

function even(n) {
  return Math.max(2, Math.round(n / 2) * 2);
}

// Construye las entradas y el filtro de ffmpeg para el mosaico. Cada cámara
// se escala a una celda 16:9 (con barras negras si su proporción es otra),
// se desplaza en el tiempo según su "retraso" y se ubica en la grilla con
// xstack. Las celdas vacías quedan en negro.
//  - retraso > 0: la cámara empieza más tarde (se rellena con negro al inicio).
//  - retraso < 0: se recorta el inicio de esa cámara.
// audioCameras: índices de las cámaras cuyo audio se incluye; cada una va en
// su propia pista (nunca se mezclan), y el reproductor permite elegir cuál oír.
function buildMosaicPlan({ items, cols, rows, width, fps, audioCameras = [] }) {
  const cellW = even(width / cols);
  const cellH = even((cellW * 9) / 16);
  const inputs = [];
  const filters = [];

  items.forEach((item, i) => {
    const inputOptions = [];
    if (item.delay < 0) inputOptions.push('-ss', String(-item.delay));
    inputs.push({ path: item.path, options: inputOptions });

    let chain =
      `[${i}:v:0]setpts=PTS-STARTPTS,fps=${fps},` +
      `scale=${cellW}:${cellH}:force_original_aspect_ratio=decrease,` +
      `pad=${cellW}:${cellH}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,format=yuv420p`;
    if (item.delay > 0) chain += `,tpad=start_duration=${item.delay}:color=black`;
    filters.push(`${chain}[v${i}]`);
  });

  if (items.length === 1) {
    filters.push('[v0]null[out]');
  } else {
    const layout = items
      .map((_, i) => `${(i % cols) * cellW}_${Math.floor(i / cols) * cellH}`)
      .join('|');
    const stackInputs = items.map((_, i) => `[v${i}]`).join('');
    filters.push(`${stackInputs}xstack=inputs=${items.length}:layout=${layout}:fill=black[out]`);
  }

  // El audio de cada cámara elegida se toma de una entrada extra del mismo
  // archivo, desplazada igual que su video para que quede sincronizado.
  const audioInputs = audioCameras
    .filter((i) => i >= 0 && i < items.length)
    .map((i) => {
      const item = items[i];
      const options = [];
      if (item.delay < 0) options.push('-ss', String(-item.delay));
      if (item.delay > 0) options.push('-itsoffset', String(item.delay));
      return { path: item.path, options, camera: i };
    });

  // El ancho/alto final cubre la grilla completa aunque falten cámaras.
  const outW = cellW * cols;
  const outH = cellH * rows;
  const usedRows = Math.ceil(items.length / cols);
  if (items.length > 1 && (usedRows < rows || items.length < cols)) {
    filters[filters.length - 1] = filters[filters.length - 1].replace('[out]', '[stack]');
    filters.push(`[stack]pad=${outW}:${outH}:0:0:color=black[out]`);
  } else if (items.length === 1 && (cols > 1 || rows > 1)) {
    filters[filters.length - 1] = `[v0]pad=${outW}:${outH}:0:0:color=black[out]`;
  }

  return { inputs, audioInputs, filter: filters.join(';'), outW, outH };
}

// ---------------------------------------------------------------------------
// Videos desde enlaces
// ---------------------------------------------------------------------------

// Convierte enlaces "para compartir" en enlaces de descarga directa.
function normalizeVideoUrl(raw) {
  let url;
  try {
    url = new URL(String(raw).trim());
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(url.protocol)) return null;

  const host = url.hostname.replace(/^www\./, '');
  if (host === 'drive.google.com' || host === 'docs.google.com') {
    const match = url.pathname.match(/\/d\/([^/]+)/);
    const id = match ? match[1] : url.searchParams.get('id');
    if (id) {
      return `https://drive.usercontent.google.com/download?id=${encodeURIComponent(id)}&export=download&confirm=t`;
    }
  }
  if (host === 'dropbox.com' || host.endsWith('.dropbox.com')) {
    url.searchParams.delete('dl');
    url.searchParams.set('raw', '1');
  }
  return url.toString();
}

function fileNameFromResponse(response, url) {
  const disposition = response.headers.get('content-disposition') || '';
  const match = disposition.match(/filename\*=UTF-8''([^;]+)/i) || disposition.match(/filename="?([^";]+)"?/i);
  if (match) {
    try {
      return path.basename(decodeURIComponent(match[1]));
    } catch {
      return path.basename(match[1]);
    }
  }
  const last = path.basename(new URL(url).pathname);
  return last && last.includes('.') ? decodeURIComponent(last) : 'video-enlace.mp4';
}

async function fetchVideo(url) {
  const response = await fetch(url, {
    redirect: 'follow',
    headers: { 'User-Agent': 'Mozilla/5.0 (VisorMulticamara)' },
  });
  if (!response.ok || !response.body) {
    if (response.status === 401 || response.status === 403 || response.status === 404) {
      throw new Error(
        `el archivo no es público o no existe (HTTP ${response.status}). Compártelo como "cualquier persona con el enlace".`
      );
    }
    throw new Error(`el enlace respondió con error HTTP ${response.status}`);
  }
  return response;
}

function driveConfirmUrl(html, baseUrl) {
  const form = html.match(/<form[^>]*id="download-form"[^>]*action="([^"]+)"[^>]*>([\s\S]*?)<\/form>/i);
  if (!form) return null;
  const target = new URL(form[1].replace(/&amp;/g, '&'), baseUrl);
  const inputRe = /<input[^>]*type="hidden"[^>]*name="([^"]+)"[^>]*value="([^"]*)"/gi;
  let m;
  while ((m = inputRe.exec(form[2]))) target.searchParams.set(m[1], m[2].replace(/&amp;/g, '&'));
  return target.toString();
}

// ---------------------------------------------------------------------------
// Carpetas públicas de Google Drive: lista sus videos (y los de sus
// subcarpetas, p. ej. una por canal del DVR) para cargarlos como cámaras.
// ---------------------------------------------------------------------------

const VIDEO_EXTS = ['mp4', 'm4v', 'mov', 'avi', 'mkv', 'webm', 'dav', '264', 'h264', '265', 'h265', 'hevc', 'flv', 'wmv', 'asf', 'mpg', 'mpeg', 'vob', 'ts', 'mts', 'm2ts', '3gp'];
const MAX_FOLDER_FILES = 200;

function driveFolderId(raw) {
  const match = String(raw || '').match(/drive\.google\.com\/(?:drive\/(?:u\/\d+\/)?folders\/|embeddedfolderview\?id=)([\w-]+)/);
  return match ? match[1] : null;
}

function decodeHtml(text) {
  return text
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

// Extrae archivos y subcarpetas de la vista "embeddedfolderview" de Drive.
function parseDriveFolderHtml(html) {
  const entries = [];
  const re = /<a href="([^"]+)"[^>]*>[\s\S]*?<div class="flip-entry-title">([\s\S]*?)<\/div>/g;
  let m;
  while ((m = re.exec(html))) {
    const href = decodeHtml(m[1]);
    const name = decodeHtml(m[2]).trim();
    const file = href.match(/\/file\/d\/([\w-]+)/);
    const folder = href.match(/\/folders\/([\w-]+)/);
    if (file) entries.push({ type: 'file', id: file[1], name });
    else if (folder) entries.push({ type: 'folder', id: folder[1], name });
  }
  return entries;
}

function looksLikeVideo(name) {
  const dot = name.lastIndexOf('.');
  if (dot < 0) return true; // los DVR a veces exportan sin extensión
  return VIDEO_EXTS.includes(name.slice(dot + 1).toLowerCase());
}

async function listDriveFolder(folderId, prefix = '', depth = 0, out = []) {
  const response = await fetch(`https://drive.google.com/embeddedfolderview?id=${encodeURIComponent(folderId)}`, {
    headers: { 'User-Agent': 'Mozilla/5.0 (VisorMulticamara)' },
  });
  const html = response.ok ? await response.text() : '';
  if (!html.includes('flip-entry') && depth === 0) {
    if (!response.ok || /ServiceLogin|accounts\.google\.com/.test(html)) {
      throw new Error('La carpeta no es pública. Compártela como "cualquier persona con el enlace".');
    }
  }

  const entries = parseDriveFolderHtml(html);
  for (const entry of entries) {
    if (out.length >= MAX_FOLDER_FILES) break;
    if (entry.type === 'file' && looksLikeVideo(entry.name)) {
      out.push({
        name: prefix + entry.name,
        url: `https://drive.google.com/file/d/${entry.id}/view`,
      });
    }
  }
  if (depth < 2) {
    for (const entry of entries) {
      if (out.length >= MAX_FOLDER_FILES) break;
      if (entry.type === 'folder') await listDriveFolder(entry.id, `${prefix}${entry.name}/`, depth + 1, out);
    }
  }
  return out;
}

// Descarga el video del enlace al servidor (con progreso) y lo registra como
// un archivo guardado más: luego sirve para la vista previa y el mosaico.
function enqueueImportJob(url) {
  const jobId = createJob(url);
  const job = jobs.get(jobId);
  job.fileId = null;
  job.bytes = 0;

  enqueue(async () => {
    job.status = 'processing';
    const fileId = crypto.randomUUID();
    const tempPath = path.join(UPLOAD_DIR, `${fileId}.part`);

    try {
      let response = await fetchVideo(url);
      let type = response.headers.get('content-type') || '';
      // Google Drive muestra una página de confirmación ("no se puede analizar
      // en busca de virus") para archivos grandes: se envía ese formulario.
      if (type.includes('text/html') && /google/.test(new URL(response.url || url).hostname)) {
        const confirmUrl = driveConfirmUrl(await response.text(), response.url || url);
        if (confirmUrl) {
          response = await fetchVideo(confirmUrl);
          type = response.headers.get('content-type') || '';
        }
      }
      if (type.includes('text/html')) {
        throw new Error(
          'el enlace abre una página web y no el video. Usa un enlace directo o comparte el archivo como público ("cualquier persona con el enlace").'
        );
      }

      const total = Number(response.headers.get('content-length')) || 0;
      if (total > MAX_FILE_SIZE) throw new Error('el video supera el tamaño máximo permitido (2 GB)');
      job.originalName = fileNameFromResponse(response, response.url || url);

      const body = Readable.fromWeb(response.body);
      body.on('data', (chunk) => {
        job.bytes += chunk.length;
        if (job.bytes > MAX_FILE_SIZE) body.destroy(new Error('el video supera el tamaño máximo permitido (2 GB)'));
        if (total) job.progress = Math.min(99, Math.round((job.bytes / total) * 100));
      });
      await pipeline(body, fs.createWriteStream(tempPath));
      if (job.bytes === 0) throw new Error('el enlace no devolvió ningún dato');

      storedFiles.set(fileId, { path: tempPath, originalName: job.originalName });
      job.fileId = fileId;
      job.status = 'done';
      job.progress = 100;
    } catch (err) {
      fs.unlink(tempPath, () => {});
      job.status = 'error';
      job.error = `No se pudo descargar: ${err.message}`;
    }
  });

  return jobId;
}

// Revisa (con ffmpeg) si el archivo tiene alguna pista de audio.
function hasAudioStream(filePath) {
  return new Promise((resolve) => {
    execFile(ffmpegPath, ['-hide_banner', '-i', filePath], (err, stdout, stderr) => {
      resolve(/Stream #\S+.*: Audio:/.test(stderr || ''));
    });
  });
}

async function resolveAudioCameras(items, audioIndex) {
  if (audioIndex === AUDIO_ALL) {
    const flags = await Promise.all(items.map((item) => hasAudioStream(item.path)));
    return items.map((_, i) => i).filter((i) => flags[i]);
  }
  if (audioIndex >= 0 && audioIndex < items.length && (await hasAudioStream(items[audioIndex].path))) {
    return [audioIndex];
  }
  return [];
}

function enqueueMosaicJob(options) {
  const jobId = createJob(`mosaico-${options.items.length}-camaras.mp4`);

  enqueue(async () => {
    const job = jobs.get(jobId);
    job.status = 'processing';

    const audioCameras = await resolveAudioCameras(options.items, options.audioIndex);
    const plan = buildMosaicPlan({ ...options, audioCameras });
    const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
    const outputName = `mosaico-${options.items.length}cam-${stamp}-${jobId.slice(0, 6)}.mp4`;
    const command = ffmpeg();

    plan.inputs.forEach((input) => {
      command.input(input.path);
      if (input.options.length) command.inputOptions(input.options);
    });
    plan.audioInputs.forEach((input) => {
      command.input(input.path);
      if (input.options.length) command.inputOptions(input.options);
    });

    const outputOptions = [
      '-filter_complex', plan.filter,
      '-map', '[out]',
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '23',
      '-pix_fmt', 'yuv420p',
      '-r', String(options.fps),
      '-threads', '0',
      '-movflags', '+faststart',
    ];
    if (plan.audioInputs.length) {
      plan.audioInputs.forEach((input, k) => {
        outputOptions.push(
          '-map', `${plan.inputs.length + k}:a:0`,
          // En MP4 el nombre de la pista se guarda como handler_name (lo muestra VLC).
          `-metadata:s:a:${k}`, `title=Cámara ${input.camera + 1}`,
          `-metadata:s:a:${k}`, `handler_name=Cámara ${input.camera + 1}`,
          `-disposition:a:${k}`, k === 0 ? 'default' : '0'
        );
      });
      outputOptions.push('-c:a', 'aac', '-b:a', '128k');
    } else {
      outputOptions.push('-an');
    }
    // Se pasan como argumentos sueltos para que fluent-ffmpeg no parta en dos
    // los valores con espacios (p. ej. "title=Cámara 1").
    command.outputOptions(...outputOptions).toFormat('mp4');

    try {
      await runCommand(
        command,
        path.join(OUTPUT_DIR, outputName),
        (p) => {
          job.progress = p;
        },
        options.expectedDuration
      );
      finishJob(job, outputName);
      job.audioTracks = plan.audioInputs.map((input) => input.camera + 1);
    } catch (err) {
      job.status = 'error';
      job.error = `No se pudo unir los videos: ${err.message}`;
    }
  });

  return jobId;
}

// Subida en fragmentos: cada video se envía en pedazos pequeños (unos pocos
// MB) en vez de una sola solicitud gigante. Esto evita el límite de tamaño
// de los proxies (como el de Codespaces/nginx) sin importar qué tan grande
// sea el video, y permite mostrar progreso de subida en tiempo real.
const uploadSessions = new Map(); // uploadId -> { stream, tempPath, fileName, format, purpose, bytesReceived, lastActivity }

const chunkUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 16 * 1024 * 1024 }, // margen amplio sobre el tamaño de fragmento del cliente
});

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/upload/init', (req, res) => {
  const fileName = req.body && req.body.fileName;
  const format = ((req.body && req.body.format) || 'mp4').toLowerCase();
  // purpose=store: solo guarda el video (visor multicámara / mosaico).
  const purpose = req.body && req.body.purpose === 'store' ? 'store' : 'convert';

  if (!fileName) {
    return res.status(400).json({ error: 'Falta el nombre del archivo.' });
  }
  if (purpose === 'convert' && !ALLOWED_FORMATS.includes(format)) {
    return res.status(400).json({ error: `Formato no soportado: ${format}` });
  }

  const uploadId = crypto.randomUUID();
  const tempPath = path.join(UPLOAD_DIR, `${uploadId}.part`);
  const stream = fs.createWriteStream(tempPath);

  uploadSessions.set(uploadId, {
    stream,
    tempPath,
    fileName,
    format,
    purpose,
    bytesReceived: 0,
    lastActivity: Date.now(),
  });

  res.json({ uploadId });
});

app.post('/api/upload/chunk', chunkUpload.single('chunk'), (req, res) => {
  const { uploadId } = req.body;
  const isLast = req.body.isLast === 'true';
  const session = uploadSessions.get(uploadId);

  if (!session) {
    return res.status(404).json({ error: 'Sesión de subida no encontrada o expirada.' });
  }
  if (!req.file || req.file.buffer.length === 0) {
    return res.status(400).json({ error: 'Fragmento vacío.' });
  }

  session.bytesReceived += req.file.buffer.length;
  session.lastActivity = Date.now();

  if (session.bytesReceived > MAX_FILE_SIZE) {
    session.stream.destroy();
    fs.unlink(session.tempPath, () => {});
    uploadSessions.delete(uploadId);
    return res.status(413).json({ error: 'El video supera el tamaño máximo permitido (2 GB).' });
  }

  session.stream.write(req.file.buffer, (err) => {
    if (err) {
      uploadSessions.delete(uploadId);
      return res.status(500).json({ error: 'Error al guardar el fragmento.' });
    }

    if (!isLast) {
      return res.json({ done: false, bytesReceived: session.bytesReceived });
    }

    session.stream.end(() => {
      uploadSessions.delete(uploadId);
      if (session.purpose === 'store') {
        storedFiles.set(uploadId, { path: session.tempPath, originalName: session.fileName });
        return res.json({ done: true, fileId: uploadId, fileName: session.fileName });
      }
      const jobId = enqueueConversionJob(session.tempPath, session.fileName, session.format);
      res.json({ done: true, jobId, fileName: session.fileName });
    });
  });
});

app.get('/api/jobs/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) {
    return res.status(404).json({ error: 'Trabajo no encontrado.' });
  }
  res.json(job);
});

app.post('/api/folder', async (req, res) => {
  const folderId = driveFolderId(req.body && req.body.url);
  if (!folderId) {
    return res.status(400).json({ error: 'No es un enlace de carpeta de Google Drive.' });
  }
  try {
    const files = await listDriveFolder(folderId);
    files.sort((a, b) => a.name.localeCompare(b.name, 'es', { numeric: true }));
    if (files.length === 0) {
      return res.status(404).json({ error: 'La carpeta no tiene videos (o no es pública).' });
    }
    res.json({ files });
  } catch (err) {
    res.status(502).json({ error: err.message || 'No se pudo leer la carpeta.' });
  }
});

app.post('/api/import', (req, res) => {
  if (driveFolderId(req.body && req.body.url)) {
    return res.status(400).json({
      error: 'Es un enlace de carpeta: pégalo en la barra de enlaces y se cargarán sus videos.',
    });
  }
  const url = normalizeVideoUrl(req.body && req.body.url);
  if (!url) {
    return res.status(400).json({ error: 'Enlace inválido. Debe empezar con http:// o https://' });
  }
  res.json({ jobId: enqueueImportJob(url) });
});

app.post('/api/preview', (req, res) => {
  const fileId = req.body && req.body.fileId;
  if (!getStoredFile(fileId)) {
    return res.status(404).json({ error: 'Video no encontrado. Vuelve a subirlo.' });
  }
  const format = req.body.format === 'webm' ? 'webm' : 'mp4';
  res.json({ jobId: enqueuePreviewJob(fileId, format) });
});

app.post('/api/mosaic', (req, res) => {
  const body = req.body || {};
  const rawItems = Array.isArray(body.items) ? body.items : [];

  if (rawItems.length === 0 || rawItems.length > MAX_CAMERAS) {
    return res.status(400).json({ error: `Envía entre 1 y ${MAX_CAMERAS} videos.` });
  }

  const items = [];
  for (const raw of rawItems) {
    const stored = getStoredFile(raw && raw.fileId);
    if (!stored) {
      return res.status(404).json({ error: 'Uno de los videos ya no está en el servidor. Vuelve a subirlo.' });
    }
    const delay = Number(raw.delay) || 0;
    items.push({ path: stored.path, delay: Math.max(-86400, Math.min(86400, Math.round(delay * 1000) / 1000)) });
  }

  const cols = Math.trunc(Number(body.cols));
  const rows = Math.trunc(Number(body.rows));
  if (!(cols >= 1 && rows >= 1 && cols <= 4 && rows <= 4 && cols * rows >= items.length)) {
    return res.status(400).json({ error: 'Distribución de cuadrícula inválida.' });
  }

  const width = Math.max(640, Math.min(3840, Math.trunc(Number(body.width)) || 1920));
  const fps = Math.max(5, Math.min(60, Math.trunc(Number(body.fps)) || 25));
  const audioIndex = Number.isInteger(body.audioIndex) ? body.audioIndex : -1;
  if (audioIndex >= items.length || audioIndex < AUDIO_ALL) {
    return res.status(400).json({ error: 'Opción de audio inválida.' });
  }
  const expectedDuration = Math.max(0, Number(body.expectedDuration) || 0);

  const jobId = enqueueMosaicJob({ items, cols, rows, width, fps, audioIndex, expectedDuration });
  res.json({ jobId });
});

// Sirve los videos procesados para reproducirlos en el navegador (con
// soporte de rangos para poder adelantar/retroceder).
app.get('/api/media/:fileName', (req, res) => {
  const fileName = path.basename(req.params.fileName);
  const filePath = path.join(OUTPUT_DIR, fileName);

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Archivo no encontrado.' });
  }

  res.sendFile(filePath);
});

app.get('/api/download/:fileName', (req, res) => {
  const fileName = path.basename(req.params.fileName);
  const filePath = path.join(OUTPUT_DIR, fileName);

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Archivo no encontrado.' });
  }

  res.download(filePath, fileName);
});

app.use((err, req, res, next) => {
  res.status(400).json({ error: err.message });
});

// Limpia archivos de más de 3 horas para no llenar el disco
// cuando se procesan muchos videos seguidos, y cierra sesiones de subida
// abandonadas (el usuario cerró la pestaña a mitad de una subida).
const MAX_AGE_MS = 3 * 60 * 60 * 1000;
setInterval(() => {
  for (const [uploadId, session] of uploadSessions) {
    if (Date.now() - session.lastActivity > MAX_AGE_MS) {
      session.stream.destroy();
      fs.unlink(session.tempPath, () => {});
      uploadSessions.delete(uploadId);
    }
  }

  for (const [fileId, stored] of storedFiles) {
    if (!fs.existsSync(stored.path)) storedFiles.delete(fileId);
  }

  for (const dir of [UPLOAD_DIR, OUTPUT_DIR]) {
    fs.readdir(dir, (err, entries) => {
      if (err) return;
      entries.forEach((entry) => {
        const filePath = path.join(dir, entry);
        fs.stat(filePath, (statErr, stats) => {
          if (statErr || !stats.isFile()) return;
          if (Date.now() - stats.mtimeMs > MAX_AGE_MS) {
            fs.unlink(filePath, () => {});
          }
        });
      });
    });
  }
}, 15 * 60 * 1000).unref();

module.exports = { app, buildMosaicPlan, normalizeVideoUrl, driveConfirmUrl, parseDriveFolderHtml, driveFolderId };

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`Servidor de video escuchando en http://localhost:${PORT}`);
    console.log(`Conversiones simultáneas permitidas: ${CONCURRENCY}`);
  });
}
