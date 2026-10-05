# Visor Multicámara y Conversor de Videos

Aplicación web para ver hasta **8 cámaras sincronizadas** a la vez (como un DVR), **unirlas en un solo video mosaico** para descargarlo, y convertir varios videos de distintos tamaños, en paralelo, entre distintos formatos (MP4, AVI, MOV, MKV, WEBM, GIF).

## Uso

```bash
npm install
npm start
```

Abre `http://localhost:3000`:

- **Visor multicámara** (`/`): arrastra hasta 8 videos (o haz clic en una celda vacía). Se reproducen todos juntos con una sola barra de tiempo, velocidad de 0.25× a 16×, avance cuadro a cuadro, distribución 1/2/4/6/8/9, ampliar una cámara (doble clic), pantalla completa y captura PNG del mosaico.
  - **Cualquier formato**: lo que el navegador abre (MP4, WEBM, MOV…) se ve al instante sin subir nada. Lo demás (AVI, DAV, H.264/H.265 crudo de DVR, HEVC, FLV, TS, WMV…) se sube y el servidor lo convierte automáticamente para poder verlo.
  - **Retraso por cámara** (⏱): si las grabaciones no empiezan a la misma hora, ajusta los segundos para alinearlas. 🔇/🔊 elige qué cámara se escucha.
  - **Unir y descargar**: genera un MP4 con todas las cámaras en cuadrícula (misma distribución, retrasos y audio elegido que el visor), en HD, Full HD, 2K o 4K, y lo descarga automáticamente.
- **Conversor** (`/convertir.html`): sube uno o varios videos, elige el formato de salida (MP4 por defecto) y descarga cada resultado cuando esté listo.

## Cómo funciona

- Backend en Express (`server.js`) recibe los videos subidos con `multer` (hasta 20 por solicitud, 2 GB cada uno) y los procesa con `fluent-ffmpeg` (usando el binario incluido por `ffmpeg-static`, sin dependencias del sistema).
- **Cola de conversión concurrente**: las conversiones se procesan en paralelo, acotadas al número de núcleos de CPU disponibles, para aprovechar el hardware sin saturarlo cuando llegan muchos videos a la vez.
- **Remux rápido**: al convertir a MP4/MKV/MOV, primero intenta copiar los streams sin recodificar (`-c copy`, casi instantáneo); si el video de origen no es compatible, recae automáticamente en recodificar con `libx264`/`aac`, preset `veryfast` y multi-hilo.
- **Progreso en vivo**: cada video se procesa como un "job" independiente (`GET /api/jobs/:id`) y el frontend muestra una barra de progreso y enlace de descarga por archivo.
- **Mosaico**: `POST /api/mosaic` escala cada cámara a una celda 16:9 (con barras negras si su proporción es otra), aplica los retrasos (`tpad` / `-ss`) y las ubica con el filtro `xstack` de ffmpeg; el video dura lo que la cámara más larga.
- **Vista previa**: `POST /api/preview` recodifica a H.264 (o WebM si el navegador no tiene H.264) a máx. 720p con preset rápido; los originales se suben una sola vez y se reutilizan para el mosaico.
- **Limpieza automática**: los archivos subidos/convertidos de más de 3 horas se eliminan periódicamente para no llenar el disco.
- Frontend estático en `public/` con selección múltiple (drag & drop) y selector de formato.
- Formatos soportados: `mp4`, `avi`, `mov`, `mkv`, `webm`, `gif`.
