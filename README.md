# Conversor de Videos

Aplicación web para convertir videos entre distintos formatos (MP4, AVI, MOV, MKV, WEBM, GIF).

## Uso

```bash
npm install
npm start
```

Abre `http://localhost:3000`, sube un video, elige el formato de salida (MP4 por defecto) y descarga el resultado.

## Cómo funciona

- Backend en Express (`server.js`) recibe el video subido con `multer`, lo procesa con `fluent-ffmpeg` (usando el binario incluido por `ffmpeg-static`, sin dependencias del sistema) y genera el archivo en el formato solicitado.
- Frontend estático en `public/` con un formulario de carga (drag & drop) y selector de formato.
- Formatos soportados: `mp4`, `avi`, `mov`, `mkv`, `webm`, `gif`.
