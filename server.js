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

const jobs = new Map(); // jobId -> { status, progress, downloadUrl, fileName, error }

function createJob(originalName) {
  const id = crypto.randomUUID();
  jobs.set(id, {
    id,
    originalName,
    status: 'queued', // queued | processing | done | error
    progress: 0,
    downloadUrl: null,
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

// Subida en fragmentos: cada video se envía en pedazos pequeños (unos pocos
// MB) en vez de una sola solicitud gigante. Esto evita el límite de tamaño
// de los proxies (como el de Codespaces/nginx) sin importar qué tan grande
// sea el video, y permite mostrar progreso de subida en tiempo real.
const uploadSessions = new Map(); // uploadId -> { stream, tempPath, fileName, format, bytesReceived, lastActivity }

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

  if (!fileName) {
    return res.status(400).json({ error: 'Falta el nombre del archivo.' });
  }
  if (!ALLOWED_FORMATS.includes(format)) {
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

// Limpia archivos convertidos de más de 1 hora para no llenar el disco
// cuando se procesan muchos videos seguidos, y cierra sesiones de subida
// abandonadas (el usuario cerró la pestaña a mitad de una subida).
const MAX_AGE_MS = 60 * 60 * 1000;
setInterval(() => {
  for (const [uploadId, session] of uploadSessions) {
    if (Date.now() - session.lastActivity > MAX_AGE_MS) {
      session.stream.destroy();
      fs.unlink(session.tempPath, () => {});
      uploadSessions.delete(uploadId);
    }
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor de conversión de video escuchando en http://localhost:${PORT}`);
  console.log(`Conversiones simultáneas permitidas: ${CONCURRENCY}`);
});
