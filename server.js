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
const informe = require('./informe');

ffmpeg.setFfmpegPath(ffmpegPath);

// DATA_DIR permite guardar los videos en un disco persistente (p. ej. un
// "Volume" de Railway montado en /data) para que sobrevivan a reinicios.
const DATA_DIR = process.env.DATA_DIR || __dirname;
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const OUTPUT_DIR = path.join(DATA_DIR, 'converted');
[UPLOAD_DIR, OUTPUT_DIR].forEach((dir) => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

const ALLOWED_FORMATS = ['mp4', 'avi', 'mov', 'mkv', 'webm', 'gif'];
// Tamaño máximo por video (ajustable con MAX_UPLOAD_GB). Lo que de verdad
// limita es el espacio libre en disco, que se revisa al iniciar cada subida.
const MAX_FILE_SIZE = (Number(process.env.MAX_UPLOAD_GB) || 50) * 1024 ** 3;
const MAX_FILE_LABEL = `${Math.round(MAX_FILE_SIZE / 1024 ** 3)} GB`;

// Varias conversiones a la vez, pero acotadas a los núcleos disponibles
// para no saturar el servidor cuando llegan muchos videos juntos.
// En contenedores (Railway, Render) os.cpus() muestra los núcleos de la
// máquina física, no los asignados: se lee el límite real del cgroup para no
// lanzar decenas de ffmpeg que se estorban entre sí y terminan más lentos.
function effectiveCpus() {
  try {
    const [quota, period] = fs.readFileSync('/sys/fs/cgroup/cpu.max', 'utf8').trim().split(/\s+/);
    if (quota !== 'max') return Math.max(1, Math.floor(Number(quota) / Number(period)));
  } catch {
    // sin cgroup v2: se usa lo que informa el sistema
  }
  return os.availableParallelism ? os.availableParallelism() : os.cpus().length;
}
const CPUS = effectiveCpus();
// Cada ffmpeg ya usa varios hilos: con pocos trabajos a la vez cada uno
// termina antes. MAX_JOBS permite ajustarlo desde las variables del hosting.
const CONCURRENCY = Math.max(1, Number(process.env.MAX_JOBS) || Math.min(3, Math.ceil(CPUS / 2)));
let active = 0;
let queueSeq = 0;
const queue = []; // { task, priority, seq } — menor prioridad = se atiende antes

function runNext() {
  if (active >= CONCURRENCY || queue.length === 0) return;
  active += 1;
  const { task } = queue.shift();
  task().finally(() => {
    active -= 1;
    runNext();
  });
}

// Prioridad 1 = lo que pidió el usuario (unir, comprimir, cortar…);
// prioridad 2 = vistas previas, que no deben hacer esperar a lo anterior.
const PRIORITY_USER = 1;
const PRIORITY_PREVIEW = 2;
function enqueue(task, priority = PRIORITY_USER) {
  queue.push({ task, priority, seq: queueSeq++ });
  queue.sort((a, b) => a.priority - b.priority || a.seq - b.seq);
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

function isValidId(id) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(String(id));
}

const partPath = (id) => path.join(UPLOAD_DIR, `${id}.part`);
const metaPath = (id) => path.join(UPLOAD_DIR, `${id}.json`);

function readMeta(id) {
  if (!isValidId(id)) return null;
  try {
    return JSON.parse(fs.readFileSync(metaPath(id), 'utf8'));
  } catch {
    return null;
  }
}

function writeMeta(id, meta) {
  const tmp = `${metaPath(id)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(meta));
  fs.renameSync(tmp, metaPath(id));
}

// Registra un video completo. Se guarda también en disco (.json) para que
// siga disponible si el servidor se reinicia.
function registerStoredFile(fileId, originalName) {
  const stored = { path: partPath(fileId), originalName };
  storedFiles.set(fileId, stored);
  const meta = readMeta(fileId) || {};
  writeMeta(fileId, { ...meta, fileName: originalName, purpose: 'store', done: true });
  return stored;
}

function getStoredFile(fileId) {
  let stored = storedFiles.get(String(fileId));
  if (!stored) {
    const meta = readMeta(fileId);
    if (meta && meta.done && meta.purpose === 'store') {
      stored = { path: partPath(fileId), originalName: meta.fileName };
      storedFiles.set(String(fileId), stored);
    }
  }
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
function enqueuePreviewJob(fileId, format, { canHevc = false, forceTranscode = false } = {}) {
  const stored = getStoredFile(fileId);
  const jobId = createJob(stored.originalName);
  const job = jobs.get(jobId);

  // Recodificar (lento): solo cuando el video no se puede reempaquetar.
  const transcode = async () => {
    job.status = 'processing';
    const outputName = `${safeBaseName(stored.originalName)}-preview-${jobId.slice(0, 8)}.${format}`;
    // Solo para mirar en la grilla: decodificación rápida y máx. 15 cuadros
    // por segundo (decodificar H.265 es lo más pesado de este paso).
    const command = ffmpeg(stored.path)
      .inputOptions('-skip_loop_filter', 'all', '-flags2', '+fast')
      .outputOptions([
        '-map', '0:v:0',
        '-map', '0:a:0?',
        '-vf', "fps='min(15,source_fps)',scale='min(960,iw)':-2:flags=bilinear,format=yuv420p",
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
  };

  // Camino rápido: la mayoría de los DVR graban H.264 (o H.265) dentro de
  // AVI/DAV/.264. Basta con pasarlo a MP4 sin recodificar: tarda segundos,
  // conserva la calidad original y no ocupa la CPU que necesitan las uniones.
  (async () => {
    if (format === 'mp4' && !forceTranscode) {
      const info = await probeMedia(stored.path);
      if (info.vcodec === 'h264' || (info.vcodec === 'hevc' && canHevc)) {
        job.status = 'processing';
        const outputName = `${safeBaseName(stored.originalName)}-preview-${jobId.slice(0, 8)}.mp4`;
        const command = ffmpeg(stored.path)
          .inputOptions('-fflags', '+genpts')
          .outputOptions(
            '-map', '0:v:0',
            '-map', '0:a:0?',
            '-c:v', 'copy',
            ...(info.vcodec === 'hevc' ? ['-tag:v', 'hvc1'] : []),
            ...(info.acodec === 'aac' ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '128k']),
            '-movflags', '+faststart'
          )
          .toFormat('mp4');
        try {
          await runCommand(command, path.join(OUTPUT_DIR, outputName), (p) => {
            job.progress = p;
          }, info.duration);
          job.remuxed = true;
          job.vcodec = info.vcodec;
          finishJob(job, outputName);
          return;
        } catch {
          job.status = 'queued';
          job.progress = 0;
        }
      }
    }
    enqueue(transcode, PRIORITY_PREVIEW);
  })();

  return jobId;
}

// ---------------------------------------------------------------------------
// Compresión: reduce el peso del video cuidando la calidad.
// CRF: menor = más calidad y más peso. 22 casi no se nota, 26 es el punto
// medio habitual y 29 ya se nota un poco, pero pesa muchísimo menos.
// ---------------------------------------------------------------------------

// Se usa el preset "veryfast": ~3-4 veces más rápido que "medium" y, bajando
// un punto el CRF, la calidad queda igual a cambio de algo más de peso.
const COMPRESSION_LEVELS = {
  alta: { crf: 21, maxHeight: 0, audioBitrate: '128k', preset: 'veryfast' },
  equilibrada: { crf: 25, maxHeight: 1080, audioBitrate: '96k', preset: 'veryfast' },
  // Rápida: 720p y máx. 15 cuadros por segundo (sin inventar cuadros si la
  // cámara graba a menos). Medido: 2-3 veces más rápido que "equilibrada" y
  // un archivo bastante más liviano; para cámaras de vigilancia se ve bien.
  rapida: { crf: 25, maxHeight: 720, audioBitrate: '64k', preset: 'veryfast', maxFps: 15 },
  maxima: { crf: 28, maxHeight: 720, audioBitrate: '64k', preset: 'superfast' },
  // Solo para casos excepcionales (adjuntar a un correo con límite, enviar con
  // mala señal): 480p, 10 cuadros por segundo y audio mono de baja calidad.
  extrema: { crf: 32, maxHeight: 480, audioBitrate: '32k', preset: 'superfast', fps: 10, mono: true },
  // Para "Cortar": mantiene la resolución y casi la calidad original.
  corte: { crf: 19, maxHeight: 0, audioBitrate: '128k', preset: 'veryfast' },
};

// Calidad del mosaico unido (CRF de H.264). Acepta también los niveles de
// compresión para "comprimir y unir" en un solo paso.
const MOSAIC_QUALITY_CRF = { alta: 20, normal: 23, comprimida: 27, equilibrada: 25, rapida: 25, maxima: 28, extrema: 32 };

function enqueueCompressJob(fileId, level, expectedDuration, start = 0, length = 0) {
  const stored = getStoredFile(fileId);
  const settings = COMPRESSION_LEVELS[level];
  const jobId = createJob(stored.originalName);
  const job = jobs.get(jobId);
  job.inputBytes = fs.statSync(stored.path).size;
  job.outputBytes = 0;

  enqueue(async () => {
    job.status = 'processing';
    const label = level === 'corte' ? 'corte' : `comprimido-${level}`;
    const outputName = `${safeBaseName(stored.originalName)}-${label}-${jobId.slice(0, 6)}.mp4`;
    const outputPath = path.join(OUTPUT_DIR, outputName);
    const filters = [];
    // Solo achica videos más grandes que el límite; nunca agranda.
    if (settings.fps) filters.push(`fps=${settings.fps}`);
    if (settings.maxFps) filters.push(`fps='min(${settings.maxFps},source_fps)'`);
    if (settings.maxHeight) filters.push(`scale=-2:'min(ih,${settings.maxHeight})':flags=bilinear`);
    filters.push('format=yuv420p');

    const command = ffmpeg(stored.path);
    // Recorte: "-ss" antes de la entrada busca rápido y, al recodificar, exacto.
    if (start > 0) command.inputOptions('-ss', String(round3(start)));
    if (length > 0) command.outputOptions('-t', String(round3(length)));
    command
      .outputOptions(
        '-map', '0:v:0',
        '-map', '0:a?',
        '-vf', filters.join(','),
        '-c:v', 'libx264',
        '-preset', settings.preset,
        '-crf', String(settings.crf),
        '-c:a', 'aac',
        '-b:a', settings.audioBitrate,
        ...(settings.mono ? ['-ac', '1'] : []),
        '-threads', '0',
        '-movflags', '+faststart'
      )
      .toFormat('mp4');

    try {
      // Los AVI de DVR a menudo no traen la duración en la cabecera: el
      // navegador la envía para poder mostrar el porcentaje.
      await runCommand(
        command,
        outputPath,
        (p) => {
          job.progress = p;
        },
        length || expectedDuration
      );
      finishJob(job, outputName);
      job.outputBytes = fs.statSync(outputPath).size;
    } catch (err) {
      job.status = 'error';
      job.error = `No se pudo comprimir: ${err.message}`;
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
// Recorte (start/end, en segundos de la línea de tiempo común): el video
// final va desde "start" hasta "end" y cada cámara se corta en el momento
// equivalente según su retraso, así todas quedan sincronizadas. Una cámara
// sin imagen en ese tramo aparece en negro; si termina antes, se pone negra
// en vez de congelarse en su último cuadro.
function cameraWindow(item, start) {
  const local = start - item.delay; // segundo de la cámara al inicio del video final
  return { seek: Math.max(0, local), pad: Math.max(0, -local) };
}

const round3 = (n) => Math.round(n * 1000) / 1000;

function buildMosaicPlan({ items, cols, rows, width, fps, audioCameras = [], start = 0, length = 0 }) {
  const cellW = even(width / cols);
  const cellH = even((cellW * 9) / 16);
  const inputs = [];
  const filters = [];
  const black = new Set();

  items.forEach((item, i) => {
    const { seek, pad } = cameraWindow(item, start);
    const outOfRange = length > 0 && item.duration > 0 && (seek >= item.duration || pad >= length);
    if (outOfRange) {
      // No hay imagen de esta cámara en el tramo elegido: celda negra.
      black.add(i);
      filters.push(`color=c=black:s=${cellW}x${cellH}:r=${fps}:d=${round3(length)},format=yuv420p,setsar=1[v${i}]`);
      return;
    }
    const inputIndex = inputs.length;
    // Cada cámara se achica mucho en el mosaico: decodificar en modo rápido
    // (sin el filtro de bloques) no se nota y ahorra tiempo.
    const options = ['-skip_loop_filter', 'all', '-flags2', '+fast'];
    if (seek > 0) options.push('-ss', String(round3(seek)));
    inputs.push({ path: item.path, options });

    let chain =
      `[${inputIndex}:v:0]setpts=PTS-STARTPTS,fps=${fps},` +
      `scale=${cellW}:${cellH}:force_original_aspect_ratio=decrease:flags=bilinear,` +
      `pad=${cellW}:${cellH}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,format=yuv420p`;
    const tpad = [];
    if (pad > 0) tpad.push(`start_duration=${round3(pad)}`);
    if (length > 0) tpad.push('stop_mode=add', `stop_duration=${round3(length)}`);
    if (tpad.length) chain += `,tpad=${tpad.join(':')}:color=black`;
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
    .filter((i) => i >= 0 && i < items.length && !black.has(i))
    .map((i) => {
      const { seek, pad } = cameraWindow(items[i], start);
      const options = [];
      if (seek > 0) options.push('-ss', String(round3(seek)));
      if (pad > 0) options.push('-itsoffset', String(round3(pad)));
      return { path: items[i].path, options, camera: i };
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

  // Descargar no usa CPU: no ocupa un lugar en la cola de procesamiento (si no,
  // una descarga lenta de Drive haría esperar a las uniones y compresiones).
  (async () => {
    job.status = 'processing';
    const fileId = crypto.randomUUID();
    const tempPath = partPath(fileId);

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
      if (total > MAX_FILE_SIZE) throw new Error(`el video supera el tamaño máximo permitido (${MAX_FILE_LABEL})`);
      job.originalName = fileNameFromResponse(response, response.url || url);

      const body = Readable.fromWeb(response.body);
      body.on('data', (chunk) => {
        job.bytes += chunk.length;
        if (job.bytes > MAX_FILE_SIZE) body.destroy(new Error(`el video supera el tamaño máximo permitido (${MAX_FILE_LABEL})`));
        if (total) job.progress = Math.min(99, Math.round((job.bytes / total) * 100));
      });
      await pipeline(body, fs.createWriteStream(tempPath));
      if (job.bytes === 0) throw new Error('el enlace no devolvió ningún dato');

      registerStoredFile(fileId, job.originalName);
      job.fileId = fileId;
      job.status = 'done';
      job.progress = 100;
    } catch (err) {
      fs.unlink(tempPath, () => {});
      job.status = 'error';
      job.error = `No se pudo descargar: ${err.message}`;
    }
  })();

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

// Datos básicos de un video leyendo la salida de "ffmpeg -i".
function probeMedia(filePath) {
  return new Promise((resolve) => {
    execFile(ffmpegPath, ['-hide_banner', '-i', filePath], (err, stdout, stderr) => {
      const text = stderr || '';
      const dur = text.match(/Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/);
      const video = text.match(/Stream #\S+.*?: Video: (\w+)[^\n]*?, (\d{2,5})x(\d{2,5})/);
      const fps = text.match(/Stream #\S+.*?: Video:[^\n]*?, ([\d.]+) (?:fps|tbr)/);
      const audio = text.match(/Stream #\S+.*?: Audio: (\w+)/);
      const format = text.match(/Input #0, ([\w,]+), from/);
      const vIndex = text.match(/Stream #0:(\d+)\S*: Video:/);
      resolve({
        format: format ? format[1] : null,
        vIndex: vIndex ? Number(vIndex[1]) : -1,
        duration: dur ? Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3]) : 0,
        vcodec: video ? video[1] : null,
        width: video ? Number(video[2]) : 0,
        height: video ? Number(video[3]) : 0,
        fps: fps ? Number(fps[1]) : 0,
        acodec: audio ? audio[1] : null,
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Unir partes (continuaciones) de una misma cámara en un solo video
// ---------------------------------------------------------------------------
// Si las partes son del mismo tipo y van seguidas, se pegan sin recodificar
// (muy rápido). Si son distintas, o hay huecos de tiempo entre ellas (según
// la hora del nombre), se recodifica y los huecos se rellenan con negro para
// que la cámara siga sincronizada con las demás.
function enqueueConcatJob(parts, offsets, name) {
  const jobId = createJob(name);
  const job = jobs.get(jobId);
  job.fileId = null;

  enqueue(async () => {
    job.status = 'processing';
    const fileId = crypto.randomUUID();
    const outPath = partPath(fileId);
    const listPath = path.join(UPLOAD_DIR, `${fileId}.txt`);
    try {
      const infos = await Promise.all(parts.map((p) => probeMedia(p.path)));
      const total = infos.reduce((sum, i) => sum + i.duration, 0);

      // Huecos entre partes (solo si se conoce la hora de inicio de cada una).
      const gaps = parts.map((_, i) => {
        if (!offsets || i === 0) return 0;
        const prevEnd = offsets[i - 1] + infos[i - 1].duration;
        const gap = offsets[i] - prevEnd;
        return gap > 1 ? Math.min(gap, 6 * 3600) : 0;
      });
      const hasGaps = gaps.some((g) => g > 0);
      const first = infos[0];
      // Para pegar el video sin recodificar, todas las partes deben tener el
      // mismo tipo de video y de archivo. El audio NO tiene que coincidir: se
      // procesa aparte (ver audioChain).
      const sameKind = infos.every(
        (i) =>
          i.vcodec === first.vcodec &&
          i.width === first.width &&
          i.height === first.height &&
          i.format === first.format &&
          i.vIndex === first.vIndex
      );
      const withAudio = infos.some((i) => i.acodec);
      // Audio de una parte: se lleva al mismo formato y se ajusta exactamente
      // a la duración de su video (relleno con silencio o recortado), para que
      // el audio de las partes siguientes no se corra. Si la parte no tiene
      // audio, se pone silencio de la misma duración.
      const audioChain = (i, inputIndex, label) => {
        const d = round3(infos[i].duration || 1);
        return infos[i].acodec
          ? `[${inputIndex}:a:0]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,apad,atrim=duration=${d},asetpts=PTS-STARTPTS[${label}]`
          : `anullsrc=r=48000:cl=stereo,atrim=duration=${d}[${label}]`;
      };
      const progress = (p) => {
        job.progress = p;
      };

      let done = false;
      // Solo H.264 se pega sin recodificar: así el MP4 resultante se abre en
      // cualquier reproductor (H.265 dentro de MP4 no abre en muchos).
      if (!hasGaps && sameKind && first.vcodec === 'h264') {
        // Camino rápido: pegar sin recodificar el video.
        // El video se pega sin recodificar; el audio de cada parte se toma de
        // su propio archivo y se une aparte (rápido: el audio pesa poco).
        fs.writeFileSync(listPath, parts.map((p) => `file '${p.path.replace(/'/g, "'\\''")}'`).join('\n'));
        const command = ffmpeg().input(listPath).inputOptions('-f', 'concat', '-safe', '0');
        const outputOptions = ['-map', '0:v:0', '-c:v', 'copy'];
        if (withAudio) {
          parts.forEach((p) => command.input(p.path));
          const chains = parts.map((_, i) => audioChain(i, i + 1, `a${i}`));
          const labels = parts.map((_, i) => `[a${i}]`).join('');
          outputOptions.push(
            '-filter_complex', `${chains.join(';')};${labels}concat=n=${parts.length}:v=0:a=1[outa]`,
            '-map', '[outa]',
            '-c:a', 'aac',
            '-b:a', '128k'
          );
        } else {
          outputOptions.push('-an');
        }
        outputOptions.push('-movflags', '+faststart');
        command.outputOptions(...outputOptions).toFormat('mp4');
        try {
          await runCommand(command, outPath, progress, total);
          // Se comprueba que el resultado dure lo esperado (si no, algo se
          // mezcló mal y se usa el camino seguro).
          const check = await probeMedia(outPath);
          done = Math.abs(check.duration - total) <= Math.max(2, total * 0.02);
        } catch {
          // Falló (partes incompatibles): se recodifica abajo.
        }
      }

      if (!done) {
        const W = Math.max(2, first.width - (first.width % 2)) || 1280;
        const H = Math.max(2, first.height - (first.height % 2)) || 720;
        const F = Math.round(first.fps) > 0 && first.fps <= 60 ? Math.round(first.fps) : 25;
        const command = ffmpeg();
        parts.forEach((p) => command.input(p.path));
        const filters = [];
        const labels = [];
        parts.forEach((_, i) => {
          if (gaps[i] > 0) {
            filters.push(`color=c=black:s=${W}x${H}:r=${F}:d=${round3(gaps[i])},format=yuv420p,setsar=1[gv${i}]`);
            if (withAudio) filters.push(`anullsrc=r=48000:cl=stereo,atrim=duration=${round3(gaps[i])}[ga${i}]`);
            labels.push(`[gv${i}]${withAudio ? `[ga${i}]` : ''}`);
          }
          filters.push(
            `[${i}:v:0]scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black,` +
              `setsar=1,fps=${F},format=yuv420p[v${i}]`
          );
          if (withAudio) filters.push(audioChain(i, i, `a${i}`));
          labels.push(`[v${i}]${withAudio ? `[a${i}]` : ''}`);
        });
        const n = labels.length;
        filters.push(`${labels.join('')}concat=n=${n}:v=1:a=${withAudio ? 1 : 0}[outv]${withAudio ? '[outa]' : ''}`);
        command.outputOptions(
          '-filter_complex', filters.join(';'),
          '-map', '[outv]',
          ...(withAudio ? ['-map', '[outa]', '-c:a', 'aac', '-b:a', '128k'] : ['-an']),
          '-c:v', 'libx264',
          '-preset', 'veryfast',
          '-crf', '20',
          '-threads', '0',
          '-movflags', '+faststart'
        );
        command.toFormat('mp4');
        await runCommand(command, outPath, progress, total + gaps.reduce((a, b) => a + b, 0));
      }

      registerStoredFile(fileId, name);
      // Copia descargable (enlace duro: no ocupa espacio extra).
      const outputName = `${safeBaseName(name)}-unido-${jobId.slice(0, 6)}.mp4`;
      try {
        fs.linkSync(outPath, path.join(OUTPUT_DIR, outputName));
      } catch {
        fs.copyFileSync(outPath, path.join(OUTPUT_DIR, outputName));
      }
      // Los datos se completan antes de marcar "listo" (el navegador consulta en paralelo).
      job.fileId = fileId;
      job.gaps = gaps.filter((g) => g > 0).length;
      job.duration = (await probeMedia(outPath)).duration;
      finishJob(job, outputName);
    } catch (err) {
      fs.unlink(outPath, () => {});
      job.status = 'error';
      job.error = `No se pudieron unir las partes: ${err.message}`;
    } finally {
      fs.unlink(listPath, () => {});
    }
  });

  return jobId;
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

    // fps 0 = igual que las cámaras (las de DVR suelen grabar a 12-15 cuadros
    // por segundo: no tiene sentido inventar cuadros hasta 25).
    if (!options.fps) {
      const rates = (await Promise.all(options.items.map((item) => probeMedia(item.path)))).map((i) => i.fps).filter((f) => f > 0);
      options.fps = Math.max(5, Math.min(25, Math.round(rates.length ? Math.max(...rates) : 25)));
    }
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
      // "rapida": cerca del doble de rápido, a cambio de un archivo más pesado.
      '-preset', options.speed === 'rapida' ? 'superfast' : 'veryfast',
      '-crf', String(MOSAIC_QUALITY_CRF[options.quality] || MOSAIC_QUALITY_CRF.normal),
      '-pix_fmt', 'yuv420p',
      '-r', String(options.fps),
      '-threads', '0',
      '-movflags', '+faststart',
    ];
    if (options.length > 0) outputOptions.push('-t', String(round3(options.length)));
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
        options.length || options.expectedDuration
      );
      finishJob(job, outputName);
      job.audioTracks = plan.audioInputs.map((input) => input.camera + 1);
      job.inputBytes = options.items.reduce((sum, item) => sum + fs.statSync(item.path).size, 0);
      job.outputBytes = fs.statSync(path.join(OUTPUT_DIR, outputName)).size;
    } catch (err) {
      job.status = 'error';
      job.error = `No se pudo unir los videos: ${err.message}`;
    }
  });

  return jobId;
}

// Subida en fragmentos: cada video se envía en pedazos de pocos MB en vez de
// una sola solicitud gigante (evita límites de proxies y permite mostrar el
// progreso). El estado de cada subida se guarda en disco (uploads/<id>.json)
// y cada fragmento se escribe en su posición exacta, así que:
//  - si se corta la conexión o el servidor se reinicia, el navegador consulta
//    qué partes ya llegaron y continúa desde ahí, sin empezar de nuevo;
//  - los fragmentos pueden llegar en paralelo y en cualquier orden.

// Junta rangos [inicio, fin) recibidos, fusionando los que se tocan.
function addRange(ranges, start, end) {
  const all = [...ranges, [start, end]].sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const [a, b] of all) {
    const last = merged[merged.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else merged.push([a, b]);
  }
  return merged;
}

const receivedBytes = (ranges) => ranges.reduce((sum, [a, b]) => sum + (b - a), 0);
const isComplete = (meta) => meta.size > 0 && meta.ranges.length === 1 && meta.ranges[0][0] === 0 && meta.ranges[0][1] >= meta.size;

// Subidas en curso (caché en memoria del .json en disco).
const uploadSessions = new Map(); // uploadId -> meta

function getUploadSession(id) {
  if (!isValidId(id)) return null;
  let meta = uploadSessions.get(id);
  if (!meta) {
    meta = readMeta(id);
    if (!meta || !fs.existsSync(partPath(id))) return null;
    uploadSessions.set(id, meta);
  }
  return meta;
}

// Termina la subida: la deja como video guardado o lanza la conversión.
function finalizeUpload(id, meta) {
  if (meta.purpose === 'store') {
    registerStoredFile(id, meta.fileName);
    uploadSessions.delete(id);
    return { done: true, fileId: id, fileName: meta.fileName };
  }
  if (!meta.jobId) {
    meta.jobId = enqueueConversionJob(partPath(id), meta.fileName, meta.format);
    meta.done = true;
    writeMeta(id, meta);
  }
  uploadSessions.delete(id);
  return { done: true, jobId: meta.jobId, fileName: meta.fileName };
}

const chunkUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 16 * 1024 * 1024 }, // margen amplio sobre el tamaño de fragmento del cliente
});

const app = express();

// Para el hosting: comprobación de salud (sin contraseña).
app.get('/healthz', (req, res) => res.send('ok'));
// Para la actualización automática del servidor propio: no reiniciar la app
// mientras sube o procesa videos.
app.get('/healthz/busy', (req, res) => {
  const working = [...jobs.values()].some((j) => j.status === 'processing' || j.status === 'queued');
  // Subida activa = recibió un trozo en los últimos 2 minutos (las abandonadas no cuentan).
  const uploading = [...uploadSessions.keys()].some((id) => {
    try {
      return Date.now() - fs.statSync(metaPath(id)).mtimeMs < 2 * 60 * 1000;
    } catch {
      return false;
    }
  });
  res.json({ busy: working || active > 0 || uploading });
});

// Contraseña opcional: si se define APP_PASSWORD (p. ej. en Render), el
// navegador la pide una vez y la recuerda. Sin la variable, la app es abierta.
const APP_PASSWORD = process.env.APP_PASSWORD || '';
if (APP_PASSWORD) {
  app.use((req, res, next) => {
    const header = req.headers.authorization || '';
    const [scheme, encoded] = header.split(' ');
    const given = scheme === 'Basic' && encoded ? Buffer.from(encoded, 'base64').toString().split(':').slice(1).join(':') : '';
    const a = Buffer.from(given);
    const b = Buffer.from(APP_PASSWORD);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return next();
    res.set('WWW-Authenticate', 'Basic realm="Visor Multicamara", charset="UTF-8"');
    res.status(401).send('Se necesita la contraseña (cualquier usuario).');
  });
}

// Va antes del parser JSON global: los informes traen imágenes y pesan más de 100 KB.
app.use('/api/informe', informe.router);
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
// ffmpeg para el navegador (WebAssembly): reempaqueta y une videos del DVR en
// el propio equipo del usuario, sin subirlos al servidor.
const FFMPEG_WASM = path.join(__dirname, 'node_modules', '@ffmpeg');
app.use('/vendor/ffmpeg', express.static(path.join(FFMPEG_WASM, 'ffmpeg', 'dist', 'umd'), { maxAge: '30d' }));
app.use('/vendor/ffmpeg-core', express.static(path.join(FFMPEG_WASM, 'core', 'dist', 'umd'), { maxAge: '30d' }));

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

  const size = Math.max(0, Math.trunc(Number(req.body.fileSize)) || 0);
  if (size > MAX_FILE_SIZE) {
    return res.status(413).json({ error: `El video supera el tamaño máximo permitido (${MAX_FILE_LABEL}).` });
  }
  // Avisa de entrada si no hay espacio, en vez de fallar a mitad de camino.
  try {
    const { bavail, bsize } = fs.statfsSync(UPLOAD_DIR);
    if (size && bavail * bsize < size * 1.05) {
      return res.status(507).json({
        error: `No hay espacio suficiente en el servidor (${(size / 1024 ** 3).toFixed(1)} GB necesarios, ${((bavail * bsize) / 1024 ** 3).toFixed(1)} GB libres).`,
      });
    }
  } catch {
    // statfs no disponible: se sigue sin la verificación
  }

  const uploadId = crypto.randomUUID();
  fs.closeSync(fs.openSync(partPath(uploadId), 'w'));
  const meta = { fileName, format, purpose, size, ranges: [], done: false };
  writeMeta(uploadId, meta);
  uploadSessions.set(uploadId, meta);

  res.json({ uploadId });
});

// Qué partes de una subida ya llegaron (para reanudarla).
app.get('/api/upload/:id/status', (req, res) => {
  const meta = getUploadSession(req.params.id);
  if (!meta) {
    const done = getStoredFile(req.params.id);
    if (done) return res.json({ done: true, fileId: req.params.id });
    return res.status(404).json({ error: 'Sesión de subida no encontrada o expirada.' });
  }
  res.json({ done: false, size: meta.size, ranges: meta.ranges, received: receivedBytes(meta.ranges) });
});

// El navegador avisa que envió todo; el servidor confirma que está completo.
app.post('/api/upload/complete', (req, res) => {
  const id = req.body && req.body.uploadId;
  const meta = getUploadSession(id);
  if (!meta) {
    if (getStoredFile(id)) return res.json({ done: true, fileId: id });
    return res.status(404).json({ error: 'Sesión de subida no encontrada o expirada.' });
  }
  if (!isComplete(meta)) {
    return res.status(409).json({ error: 'Faltan partes del video.', ranges: meta.ranges, size: meta.size });
  }
  res.json(finalizeUpload(id, meta));
});

app.post('/api/upload/chunk', chunkUpload.single('chunk'), async (req, res) => {
  const { uploadId } = req.body;
  const isLast = req.body.isLast === 'true';
  const meta = getUploadSession(uploadId);

  if (!meta) {
    return res.status(404).json({ error: 'Sesión de subida no encontrada o expirada.' });
  }
  if (!req.file || req.file.buffer.length === 0) {
    return res.status(400).json({ error: 'Fragmento vacío.' });
  }

  // Sin "offset" (cliente antiguo, secuencial) se escribe a continuación.
  const length = req.file.buffer.length;
  const offset =
    req.body.offset !== undefined ? Math.trunc(Number(req.body.offset)) : meta.ranges.length ? meta.ranges[meta.ranges.length - 1][1] : 0;
  if (!(offset >= 0) || offset + length > MAX_FILE_SIZE || (meta.size && offset + length > meta.size)) {
    return res.status(413).json({ error: `El video supera el tamaño máximo permitido (${MAX_FILE_LABEL}).` });
  }

  let handle;
  try {
    handle = await fs.promises.open(partPath(uploadId), 'r+');
    await handle.write(req.file.buffer, 0, length, offset);
  } catch (err) {
    const noSpace = err && err.code === 'ENOSPC';
    return res.status(noSpace ? 507 : 500).json({
      error: noSpace ? 'El servidor se quedó sin espacio en disco.' : 'Error al guardar el fragmento.',
    });
  } finally {
    if (handle) await handle.close();
  }

  meta.ranges = addRange(meta.ranges, offset, offset + length);
  writeMeta(uploadId, meta);

  // Cliente antiguo: el último fragmento cierra la subida.
  if (isLast && (!meta.size || isComplete(meta))) {
    if (!meta.size) meta.size = meta.ranges[meta.ranges.length - 1][1];
    return res.json(finalizeUpload(uploadId, meta));
  }
  res.json({ done: false, received: receivedBytes(meta.ranges) });
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

// Qué videos ya no están en el servidor (p. ej. tras un reinicio sin disco
// persistente), para que el navegador los vuelva a subir antes de procesar.
app.post('/api/files/check', (req, res) => {
  const ids = Array.isArray(req.body && req.body.fileIds) ? req.body.fileIds.slice(0, 50) : [];
  res.json({ missing: ids.filter((id) => !getStoredFile(id)) });
});

app.post('/api/concat', (req, res) => {
  const ids = Array.isArray(req.body && req.body.fileIds) ? req.body.fileIds : [];
  if (ids.length < 2 || ids.length > 50) {
    return res.status(400).json({ error: 'Elige entre 2 y 50 partes para unir.' });
  }
  const parts = [];
  for (const id of ids) {
    const stored = getStoredFile(id);
    if (!stored) {
      return res.status(404).json({ error: 'Una de las partes ya no está en el servidor.', code: 'FILE_MISSING', fileId: id });
    }
    parts.push(stored);
  }
  // offsets: segundos desde el inicio de la primera parte (de la hora del nombre).
  const raw = req.body.offsets;
  const offsets =
    Array.isArray(raw) && raw.length === ids.length && raw.every((n) => Number.isFinite(Number(n))) ? raw.map(Number) : null;
  const name = String((req.body && req.body.name) || parts[0].originalName).slice(0, 200);
  res.json({ jobId: enqueueConcatJob(parts, offsets, name) });
});

app.post('/api/compress', (req, res) => {
  const fileId = req.body && req.body.fileId;
  const level = req.body && req.body.level;
  if (!getStoredFile(fileId)) {
    return res.status(404).json({ error: 'Video no encontrado. Vuelve a subirlo.', code: 'FILE_MISSING', fileId });
  }
  if (!COMPRESSION_LEVELS[level]) {
    return res.status(400).json({ error: 'Nivel de compresión inválido.' });
  }
  const expectedDuration = Math.max(0, Number(req.body.expectedDuration) || 0);
  const start = Math.max(0, Number(req.body.start) || 0);
  const length = Math.max(0, Number(req.body.length) || 0);
  res.json({ jobId: enqueueCompressJob(fileId, level, expectedDuration, start, length) });
});

app.post('/api/preview', (req, res) => {
  const fileId = req.body && req.body.fileId;
  if (!getStoredFile(fileId)) {
    return res.status(404).json({ error: 'Video no encontrado. Vuelve a subirlo.', code: 'FILE_MISSING', fileId });
  }
  const format = req.body.format === 'webm' ? 'webm' : 'mp4';
  res.json({
    jobId: enqueuePreviewJob(fileId, format, {
      canHevc: req.body.canHevc === true,
      forceTranscode: req.body.transcode === true,
    }),
  });
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
      return res.status(404).json({
        error: 'Uno de los videos ya no está en el servidor. Vuelve a subirlo.',
        code: 'FILE_MISSING',
        fileId: raw && raw.fileId,
      });
    }
    const delay = Number(raw.delay) || 0;
    items.push({
      path: stored.path,
      delay: Math.max(-86400 * 7, Math.min(86400 * 7, round3(delay))),
      duration: Math.max(0, Number(raw.duration) || 0),
    });
  }

  const cols = Math.trunc(Number(body.cols));
  const rows = Math.trunc(Number(body.rows));
  if (!(cols >= 1 && rows >= 1 && cols <= 4 && rows <= 4 && cols * rows >= items.length)) {
    return res.status(400).json({ error: 'Distribución de cuadrícula inválida.' });
  }

  const width = Math.max(640, Math.min(3840, Math.trunc(Number(body.width)) || 1920));
  const fps = Number(body.fps) === 0 ? 0 : Math.max(5, Math.min(60, Math.trunc(Number(body.fps)) || 25));
  const audioIndex = Number.isInteger(body.audioIndex) ? body.audioIndex : -1;
  if (audioIndex >= items.length || audioIndex < AUDIO_ALL) {
    return res.status(400).json({ error: 'Opción de audio inválida.' });
  }
  const expectedDuration = Math.max(0, Number(body.expectedDuration) || 0);

  // Recorte opcional (segundos de la línea de tiempo común).
  const start = Math.max(0, Number(body.start) || 0);
  const end = Number(body.end) || 0;
  const length = end > start ? end - start : expectedDuration > 0 ? Math.max(0, expectedDuration - start) : 0;

  const quality = MOSAIC_QUALITY_CRF[body.quality] ? body.quality : 'normal';
  const speed = body.speed === 'rapida' ? 'rapida' : 'normal';
  const jobId = enqueueMosaicJob({ items, cols, rows, width, fps, audioIndex, expectedDuration, quality, start, length, speed });
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

  // ?name= permite descargar con un nombre amigable (p. ej. "ch1_….mp4").
  const wanted = typeof req.query.name === 'string' ? path.basename(req.query.name).replace(/[\\/:*?"<>|]/g, '_').slice(0, 180) : '';
  res.download(filePath, wanted || fileName);
});

app.use((err, req, res, next) => {
  res.status(400).json({ error: err.message });
});

// Limpia archivos sin uso hace más de FILE_TTL_HOURS (12 h por defecto) para
// no llenar el disco. Una subida en curso no se borra: cada fragmento que
// llega actualiza la fecha de su archivo.
const MAX_AGE_MS = (Number(process.env.FILE_TTL_HOURS) || 12) * 60 * 60 * 1000;
setInterval(() => {
  for (const id of uploadSessions.keys()) {
    if (!fs.existsSync(partPath(id))) uploadSessions.delete(id);
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
    console.log(`Núcleos disponibles: ${CPUS} · trabajos de video simultáneos: ${CONCURRENCY}`);
  });
}
