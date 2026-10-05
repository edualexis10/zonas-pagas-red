const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
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
function buildMosaicPlan({ items, cols, rows, width, fps, audioIndex }) {
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

  // El audio de la cámara elegida se toma de una entrada extra del mismo
  // archivo, desplazada igual que su video, para no romper el mosaico si esa
  // cámara no tiene pista de audio (el "?" la vuelve opcional).
  let audioInput = null;
  if (audioIndex >= 0 && audioIndex < items.length) {
    const item = items[audioIndex];
    const options = [];
    if (item.delay < 0) options.push('-ss', String(-item.delay));
    if (item.delay > 0) options.push('-itsoffset', String(item.delay));
    audioInput = { path: item.path, options };
  }

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

  return { inputs, audioInput, filter: filters.join(';'), outW, outH };
}

function enqueueMosaicJob(options) {
  const jobId = createJob(`mosaico-${options.items.length}-camaras.mp4`);

  enqueue(async () => {
    const job = jobs.get(jobId);
    job.status = 'processing';

    const plan = buildMosaicPlan(options);
    const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
    const outputName = `mosaico-${options.items.length}cam-${stamp}-${jobId.slice(0, 6)}.mp4`;
    const command = ffmpeg();

    plan.inputs.forEach((input) => {
      command.input(input.path);
      if (input.options.length) command.inputOptions(input.options);
    });
    if (plan.audioInput) {
      command.input(plan.audioInput.path);
      if (plan.audioInput.options.length) command.inputOptions(plan.audioInput.options);
    }

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
    if (plan.audioInput) {
      outputOptions.push('-map', `${plan.inputs.length}:a:0?`, '-c:a', 'aac', '-b:a', '128k');
    } else {
      outputOptions.push('-an');
    }
    command.outputOptions(outputOptions).toFormat('mp4');

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

module.exports = { app, buildMosaicPlan };

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`Servidor de video escuchando en http://localhost:${PORT}`);
    console.log(`Conversiones simultáneas permitidas: ${CONCURRENCY}`);
  });
}
