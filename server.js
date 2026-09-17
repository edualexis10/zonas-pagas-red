const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
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

app.post('/api/passenger-count/analyze', uploadCounterVideo.single('video'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No se recibió ningún archivo de video.' });
  }

  const doorType = req.body.doorType;
  if (!['principal', 'bajada'].includes(doorType)) {
    fs.unlink(req.file.path, () => {});
    return res.status(400).json({ error: "doorType debe ser 'principal' o 'bajada'." });
  }

  if (doorType === 'principal' && !req.body.zone) {
    fs.unlink(req.file.path, () => {});
    return res.status(400).json({ error: "Puerta 'principal' requiere la zona del validador (zone)." });
  }

  // multer guarda el archivo sin extensión; ultralytics necesita una extensión
  // de video reconocida para tratarlo como tal.
  const ext = path.extname(req.file.originalname) || '.mp4';
  const videoPath = `${req.file.path}${ext}`;
  fs.renameSync(req.file.path, videoPath);

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

  execFile(
    PYTHON_BIN,
    args,
    { maxBuffer: 1024 * 1024 * 50, timeout: ANALYZE_TIMEOUT_MS, cwd: path.dirname(ANALYZE_SCRIPT) },
    (err, stdout, stderr) => {
      fs.unlink(videoPath, () => {});

      if (err) {
        return res.status(500).json({
          error: 'Error al analizar el video.',
          details: stderr?.trim() || err.message,
        });
      }

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
    }
  );
});

app.use((err, req, res, next) => {
  res.status(400).json({ error: err.message });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor de conversión de video escuchando en http://localhost:${PORT}`);
});
