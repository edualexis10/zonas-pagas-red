# Conversor de Videos

Aplicación web para convertir varios videos de distintos tamaños, en paralelo, entre distintos formatos (MP4, AVI, MOV, MKV, WEBM, GIF).

## Uso

```bash
npm install
npm start
```

Abre `http://localhost:3000`, sube uno o varios videos (arrastrando o seleccionando), elige el formato de salida (MP4 por defecto) y descarga cada resultado cuando esté listo.

## Cómo funciona

- Backend en Express (`server.js`) recibe los videos subidos con `multer` (hasta 20 por solicitud, 2 GB cada uno) y los procesa con `fluent-ffmpeg` (usando el binario incluido por `ffmpeg-static`, sin dependencias del sistema).
- **Cola de conversión concurrente**: las conversiones se procesan en paralelo, acotadas al número de núcleos de CPU disponibles, para aprovechar el hardware sin saturarlo cuando llegan muchos videos a la vez.
- **Remux rápido**: al convertir a MP4/MKV/MOV, primero intenta copiar los streams sin recodificar (`-c copy`, casi instantáneo); si el video de origen no es compatible, recae automáticamente en recodificar con `libx264`/`aac`, preset `veryfast` y multi-hilo.
- **Progreso en vivo**: cada video se procesa como un "job" independiente (`GET /api/jobs/:id`) y el frontend muestra una barra de progreso y enlace de descarga por archivo.
- **Limpieza automática**: los archivos subidos/convertidos de más de 1 hora se eliminan periódicamente para no llenar el disco.
- Frontend estático en `public/` con selección múltiple (drag & drop) y selector de formato.
- Formatos soportados: `mp4`, `avi`, `mov`, `mkv`, `webm`, `gif`.
