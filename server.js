const path = require('path');
const fs = require('fs');
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

app.use((err, req, res, next) => {
  res.status(400).json({ error: err.message });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor de conversión de video escuchando en http://localhost:${PORT}`);
});
