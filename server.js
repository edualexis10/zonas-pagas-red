const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const { pipeline } = require('stream/promises');
const { Readable } = require('stream');
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

const upload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: 500 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('video/')) {
      return cb(new Error('El archivo debe ser un video.'));
    }
    cb(null, true);
  },
});

const PYTHON_BIN = process.env.PYTHON_BIN || 'python3';
const ANALYZE_SCRIPT = path.join(__dirname, 'passenger-counter', 'analyze.py');
const PREVIEW_SCRIPT = path.join(__dirname, 'passenger-counter', 'preview_frame.py');

const uploadCounterVideo = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: 500 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('video/')) {
      return cb(new Error('El archivo debe ser un video.'));
    }
    cb(null, true);
  },
});

function extractGoogleDriveFileId(url) {
  const patterns = [/\/file\/d\/([a-zA-Z0-9_-]+)/, /[?&]id=([a-zA-Z0-9_-]+)/];
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return match[1];
  }
  return null;
}

async function downloadGoogleDriveFile(fileId, destPath) {
  const baseUrl = `https://drive.google.com/uc?export=download&id=${fileId}`;
  let response = await fetch(baseUrl);
  const cookies = response.headers.get('set-cookie') || '';
  const contentType = response.headers.get('content-type') || '';

  if (contentType.includes('text/html')) {
    // Archivos grandes (>100MB) muestran una interstitial de "no se pudo
    // escanear por virus" con un formulario hacia drive.usercontent.google.com
    // que incluye un token "confirm" y un "uuid" por sesión.
    const html = await response.text();
    const confirmMatch = html.match(/name="confirm"\s+value="([^"]+)"/);
    const uuidMatch = html.match(/name="uuid"\s+value="([^"]+)"/);
    if (!confirmMatch) {
      throw new Error(
        'No se pudo descargar desde Google Drive. Verifica que el enlace sea público ("Cualquier persona con el enlace puede ver").'
      );
    }
    const params = new URLSearchParams({
      id: fileId,
      export: 'download',
      confirm: confirmMatch[1],
    });
    if (uuidMatch) params.set('uuid', uuidMatch[1]);
    response = await fetch(`https://drive.usercontent.google.com/download?${params}`, {
      headers: { cookie: cookies },
    });
  }

  if (!response.ok || !response.body) {
    throw new Error(`Google Drive respondió con error (HTTP ${response.status}).`);
  }

  await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(destPath));
}

async function downloadDirectFile(url, destPath) {
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`No se pudo descargar el archivo (HTTP ${response.status}).`);
  }
  await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(destPath));
}

async function downloadVideoFromUrl(url, destPath) {
  const driveId = extractGoogleDriveFileId(url);
  if (driveId) {
    await downloadGoogleDriveFile(driveId, destPath);
  } else {
    await downloadDirectFile(url, destPath);
  }
}

// Resuelve el archivo de video subido o descargado desde un enlace a una
// ruta en disco con extensión reconocida. Lanza con { status, error } si
// no hay ni archivo ni enlace, o si la descarga falla.
async function resolveVideoPath(req) {
  if (req.file) {
    const ext = path.extname(req.file.originalname) || '.mp4';
    const videoPath = `${req.file.path}${ext}`;
    fs.renameSync(req.file.path, videoPath);
    return videoPath;
  }

  if (!req.body.videoUrl) {
    const err = new Error('Debes subir un video o pegar un enlace (videoUrl).');
    err.status = 400;
    throw err;
  }

  const videoPath = path.join(UPLOAD_DIR, `${crypto.randomUUID()}.mp4`);
  try {
    await downloadVideoFromUrl(req.body.videoUrl, videoPath);
  } catch (downloadErr) {
    fs.unlink(videoPath, () => {});
    const err = new Error(downloadErr.message);
    err.status = 400;
    err.publicMessage = 'No se pudo descargar el video desde el enlace.';
    throw err;
  }
  return videoPath;
}

// Cargar YOLOv8/torch consume ~900MB de RAM por proceso; correr varios
// análisis en paralelo puede tumbar el contenedor por falta de memoria.
// Esta cola fuerza a que se procesen de a uno, sin importar cuántas
// cámaras se manden a analizar al mismo tiempo desde el frontend.
let analyzeQueue = Promise.resolve();
function runAnalyzeExclusive(task) {
  const run = analyzeQueue.then(task, task);
  analyzeQueue = run.then(
    () => {},
    () => {}
  );
  return run;
}

function execFilePromise(command, args, options) {
  return new Promise((resolve, reject) => {
    execFile(command, args, options, (err, stdout, stderr) => {
      if (err) {
        err.stdout = stdout;
        err.stderr = stderr;
        return reject(err);
      }
      resolve({ stdout, stderr });
    });
  });
}

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/convert', upload.single('video'), (req, res) => {
  const format = (req.body.format || 'mp4').toLowerCase();

  if (!req.file) {
    return res.status(400).json({ error: 'No se recibió ningún archivo de video.' });
  }

  if (!ALLOWED_FORMATS.includes(format)) {
    fs.unlink(req.file.path, () => {});
    return res.status(400).json({ error: `Formato no soportado: ${format}` });
  }

  const inputPath = req.file.path;
  const baseName = path.parse(req.file.originalname).name.replace(/[^a-zA-Z0-9_-]/g, '_');
  const outputName = `${baseName}-${Date.now()}.${format}`;
  const outputPath = path.join(OUTPUT_DIR, outputName);

  const command = ffmpeg(inputPath);

  if (format === 'mp4') {
    command.videoCodec('libx264').audioCodec('aac').outputOptions(['-movflags +faststart']);
  } else if (format === 'webm') {
    command.videoCodec('libvpx-vp9').audioCodec('libopus');
  } else if (format === 'gif') {
    command.noAudio().outputOptions(['-vf', 'fps=10,scale=480:-1:flags=lanczos']);
  }

  command
    .toFormat(format)
    .on('error', (err) => {
      fs.unlink(inputPath, () => {});
      res.status(500).json({ error: `Error al convertir el video: ${err.message}` });
    })
    .on('end', () => {
      fs.unlink(inputPath, () => {});
      res.json({
        message: 'Conversión completada.',
        downloadUrl: `/api/download/${encodeURIComponent(outputName)}`,
        fileName: outputName,
      });
    })
    .save(outputPath);
});

app.get('/api/download/:fileName', (req, res) => {
  const fileName = path.basename(req.params.fileName);
  const filePath = path.join(OUTPUT_DIR, fileName);

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Archivo no encontrado.' });
  }

  res.download(filePath, fileName);
});

app.post('/api/passenger-count/analyze', uploadCounterVideo.single('video'), async (req, res) => {
  const doorType = req.body.doorType;
  const cleanup = () => {
    if (req.file) fs.unlink(req.file.path, () => {});
  };

  if (!['principal', 'bajada'].includes(doorType)) {
    cleanup();
    return res.status(400).json({ error: "doorType debe ser 'principal' o 'bajada'." });
  }

  if (doorType === 'principal' && !req.body.zone) {
    cleanup();
    return res.status(400).json({ error: "Puerta 'principal' requiere la zona del validador (zone)." });
  }

  let videoPath;
  try {
    videoPath = await resolveVideoPath(req);
  } catch (err) {
    return res.status(err.status || 500).json({
      error: err.publicMessage || err.message,
      ...(err.publicMessage ? { details: err.message } : {}),
    });
  }

  const args = [
    ANALYZE_SCRIPT,
    '--video', videoPath,
    '--door-type', doorType,
  ];

  if (req.body.line) args.push('--line', req.body.line);
  if (req.body.zone) args.push('--zone', req.body.zone);
  if (req.body.boardingSide) args.push('--boarding-side', req.body.boardingSide);
  if (req.body.dwellFrames) args.push('--dwell-frames', String(req.body.dwellFrames));
  if (req.body.vidStride) args.push('--vid-stride', String(req.body.vidStride));

  const ANALYZE_TIMEOUT_MS = Number(process.env.ANALYZE_TIMEOUT_MS) || 3 * 60 * 60 * 1000;

  let stdout;
  try {
    ({ stdout } = await runAnalyzeExclusive(() =>
      execFilePromise(PYTHON_BIN, args, {
        maxBuffer: 1024 * 1024 * 200,
        timeout: ANALYZE_TIMEOUT_MS,
        cwd: path.dirname(ANALYZE_SCRIPT),
      })
    ));
  } catch (err) {
    fs.unlink(videoPath, () => {});
    return res.status(500).json({
      error: 'Error al analizar el video.',
      details: err.stderr?.trim() || err.message,
    });
  }

  fs.unlink(videoPath, () => {});

  let result;
  try {
    result = JSON.parse(stdout.trim().split('\n').pop());
  } catch (parseErr) {
    return res.status(500).json({
      error: 'No se pudo interpretar la salida del analizador.',
      details: stdout,
    });
  }

  if (result.error) {
    return res.status(400).json(result);
  }

  res.json(result);
});

app.post('/api/passenger-count/preview', uploadCounterVideo.single('video'), async (req, res) => {
  let videoPath;
  try {
    videoPath = await resolveVideoPath(req);
  } catch (err) {
    return res.status(err.status || 500).json({
      error: err.publicMessage || err.message,
      ...(err.publicMessage ? { details: err.message } : {}),
    });
  }

  const args = [PREVIEW_SCRIPT, '--video', videoPath];
  if (req.body.line) args.push('--line', req.body.line);
  if (req.body.zone) args.push('--zone', req.body.zone);

  // No pasa por la cola de análisis: no carga torch/YOLO, es liviano y
  // rápido, así que no hace falta serializarlo contra los análisis pesados.
  let stdout;
  try {
    ({ stdout } = await execFilePromise(PYTHON_BIN, args, {
      maxBuffer: 1024 * 1024 * 20,
      timeout: 60 * 1000,
      cwd: path.dirname(PREVIEW_SCRIPT),
    }));
  } catch (err) {
    fs.unlink(videoPath, () => {});
    return res.status(500).json({
      error: 'Error al generar la vista previa.',
      details: err.stderr?.trim() || err.message,
    });
  }

  fs.unlink(videoPath, () => {});

  let result;
  try {
    result = JSON.parse(stdout.trim().split('\n').pop());
  } catch (parseErr) {
    return res.status(500).json({
      error: 'No se pudo interpretar la salida de la vista previa.',
      details: stdout,
    });
  }

  if (result.error) {
    return res.status(400).json(result);
  }

  res.json(result);
});

app.use((err, req, res, next) => {
  res.status(400).json({ error: err.message });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor de conversión de video escuchando en http://localhost:${PORT}`);
});
