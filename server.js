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
const MAX_FILES_PER_REQUEST = 20;

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

const upload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: MAX_FILE_SIZE, files: MAX_FILES_PER_REQUEST },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('video/')) {
      return cb(new Error('Todos los archivos deben ser videos.'));
    }
    cb(null, true);
  },
});

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/convert', upload.array('videos', MAX_FILES_PER_REQUEST), (req, res) => {
  const format = (req.body.format || 'mp4').toLowerCase();
  const files = req.files || [];

  if (files.length === 0) {
    return res.status(400).json({ error: 'No se recibió ningún archivo de video.' });
  }

  if (!ALLOWED_FORMATS.includes(format)) {
    files.forEach((f) => fs.unlink(f.path, () => {}));
    return res.status(400).json({ error: `Formato no soportado: ${format}` });
  }

  const createdJobs = files.map((file) => {
    const jobId = createJob(file.originalname);

    enqueue(async () => {
      const job = jobs.get(jobId);
      job.status = 'processing';

      const baseName = path.parse(file.originalname).name.replace(/[^a-zA-Z0-9_-]/g, '_');
      const outputName = `${baseName}-${Date.now()}-${jobId.slice(0, 8)}.${format}`;
      const outputPath = path.join(OUTPUT_DIR, outputName);

      try {
        await convert(file.path, outputPath, format, (percent) => {
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
        fs.unlink(file.path, () => {});
      }
    });

    return { jobId, fileName: file.originalname };
  });

  res.json({ jobs: createdJobs });
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
// cuando se procesan muchos videos seguidos.
const MAX_AGE_MS = 60 * 60 * 1000;
setInterval(() => {
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
