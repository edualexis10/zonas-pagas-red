# Visor Multicámara y Conversor de Videos

Aplicación web para ver hasta **8 cámaras sincronizadas** a la vez (como un DVR), **unirlas en un solo video mosaico** para descargarlo, y convertir varios videos de distintos tamaños, en paralelo, entre distintos formatos (MP4, AVI, MOV, MKV, WEBM, GIF).

## Publicar en internet (Render)

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/edualexis10/zonas-pagas-red)

1. Pulsa el botón de arriba e inicia sesión en Render con tu cuenta de GitHub.
2. Pulsa **Deploy Blueprint** (usa `render.yaml`). Al terminar, la app queda en un enlace fijo `https://visor-multicamara….onrender.com`.
3. Cada vez que se suben cambios a `main`, Render la actualiza solo.
4. (Opcional) Para que no cualquiera la use: en Render → **Environment** agrega `APP_PASSWORD` con una contraseña. El navegador la pide una vez (usuario: cualquiera).

El plan gratis "duerme" tras 15 minutos sin uso (la primera visita tarda ~1 minuto en despertar) y tiene poca CPU, así que unir muchos videos largos es lento; el plan *Starter* es más rápido.

### Alternativa: Railway

En [railway.com](https://railway.com) → **New Project → Deploy from GitHub repo** → `edualexis10/zonas-pagas-red` (usa `railway.json`). Luego en el servicio: **Settings → Networking → Generate Domain** para obtener el enlace público. `APP_PASSWORD` se agrega en **Variables**.

## Uso

```bash
npm install
npm start
```

Abre `http://localhost:3000`:

- **Visor multicámara** (`/`): arrastra hasta 8 videos (o haz clic en una celda vacía). Se reproducen todos juntos con una sola barra de tiempo, velocidad de 0.25× a 16×, avance cuadro a cuadro, distribución 1/2/4/6/8/9, ampliar una cámara (doble clic), pantalla completa y captura PNG del mosaico.
  - **Cualquier formato**: lo que el navegador abre (MP4, WEBM, MOV…) se ve al instante sin subir nada. Lo demás (AVI, DAV, H.264/H.265 crudo de DVR, HEVC, FLV, TS, WMV…) se sube y el servidor lo convierte automáticamente para poder verlo.
  - **Desde enlaces**: pega uno o varios enlaces (uno por línea) en la barra 🔗 y pulsa *Cargar enlaces*. Acepta enlaces directos a videos, de **Google Drive** y de **Dropbox** (el archivo debe estar compartido como "cualquier persona con el enlace"). El servidor descarga el video y lo trata como uno subido.
  - **Carpeta de Google Drive**: pega el enlace de una carpeta pública y sus videos (también los de subcarpetas, p. ej. una por canal) se reparten solos en las cámaras. Si hay más de los que caben, eliges cuáles.
  - **Pantallas**: arriba de la grilla eliges cuántas pantallas ver (1, 2, 4, 6, 8 o 9). Si hay más cámaras que pantallas, se pasan por páginas con ◀ ▶.
  - **Celular**: la página se adapta al teléfono (en vertical usa 2 columnas; un toque sobre una cámara muestra sus botones; pantalla completa también en iPhone).
  - **Retraso por cámara** (⏱): si las grabaciones no empiezan a la misma hora, ajusta los segundos para alinearlas. 🔇/🔊 elige qué cámara se escucha.
  - **Unir y descargar**: genera un MP4 con todas las cámaras en cuadrícula (misma distribución, retrasos y audio elegido que el visor), en HD, Full HD, 2K o 4K, y lo descarga automáticamente.
    - **Audio del video**: los audios nunca se mezclan. Elige *Sin audio*, *Solo cámara N*, o *Todas, en pistas separadas*: cada cámara queda como una pista de audio con su nombre ("Cámara 1", "Cámara 2"…) y eliges cuál escuchar en el reproductor (en VLC: Audio → Pista de audio).
- **Informes de incidentes** (`/informe/`): arma el informe de movimientos del bus (desvinculaciones, casos graves, incidentes) y lo descarga en Word con el formato de siempre (logo + "INFORME PPU", tabla PPU/Responsable/RUT/Terminal, viñetas con hora e imagen GPS, firma).
  - **Pega las capturas GPS** (Ctrl+V, arrastrar o elegir): cada una crea un movimiento y el servidor lee la imagen (OCR) para completar hora, fecha, servicio, sentido, destino y velocidad. Sugiere el tipo en orden: inicio → incidente → fin.
  - **Redacción automática**: según el tipo de movimiento (inicio, recorrido, incidente, detención, desvío, retoma, fin o texto libre) escribe el párrafo con conectores ("Con fecha…", "A las…", "Posteriormente…"). El texto se puede editar; lo que escribas a mano se corrige (tildes comunes, "hrs" → "horas", PPU con guion, punto final).
  - **Revisión**: avisa datos faltantes, RUT con dígito verificador inválido, PPU mal escrita, horas fuera de orden, movimientos sin imagen y diferencias entre la hora escrita y la de la captura.
  - El borrador, la firma (imagen) y los terminales usados se guardan solo en el navegador.
- **🗜 Comprimir videos**: por defecto **une todas las cámaras en un solo video comprimido** (en un solo paso); también puede comprimir cada una por separado o una sola. Niveles *Alta calidad* (CRF 21), *Equilibrado* (CRF 25, máx. 1080p, recomendado) o *Máxima compresión* (CRF 28, máx. 720p), con presets rápidos de x264. La variable `MAX_JOBS` ajusta cuántos videos se procesan a la vez (por defecto según los núcleos reales del contenedor). Muestra cuánto pesaba y cuánto pesa ahora; el original no se modifica. El mosaico unido también tiene un selector de *Calidad* (alta / normal / comprimida).
- **Conversor** (`/convertir.html`): sube uno o varios videos, elige el formato de salida (MP4 por defecto) y descarga cada resultado cuando esté listo.

## Cómo funciona

- **Informes** (`informe.js`): `POST /api/informe/ocr` lee la captura con `tesseract.js` (español; los datos del idioma se descargan la primera vez y quedan en `.cache/`) y `POST /api/informe/docx` arma el Word con la librería `docx` (carta, Calibri, mismos márgenes que el formato original).

- Backend en Express (`server.js`) recibe los videos subidos con `multer` (hasta 20 por solicitud, 2 GB cada uno) y los procesa con `fluent-ffmpeg` (usando el binario incluido por `ffmpeg-static`, sin dependencias del sistema).
- **Cola de conversión concurrente**: las conversiones se procesan en paralelo, acotadas al número de núcleos de CPU disponibles, para aprovechar el hardware sin saturarlo cuando llegan muchos videos a la vez.
- **Remux rápido**: al convertir a MP4/MKV/MOV, primero intenta copiar los streams sin recodificar (`-c copy`, casi instantáneo); si el video de origen no es compatible, recae automáticamente en recodificar con `libx264`/`aac`, preset `veryfast` y multi-hilo.
- **Progreso en vivo**: cada video se procesa como un "job" independiente (`GET /api/jobs/:id`) y el frontend muestra una barra de progreso y enlace de descarga por archivo.
- **Mosaico**: `POST /api/mosaic` escala cada cámara a una celda 16:9 (con barras negras si su proporción es otra), aplica los retrasos (`tpad` / `-ss`) y las ubica con el filtro `xstack` de ffmpeg; el video dura lo que la cámara más larga.
- **Enlaces**: `POST /api/import` convierte enlaces para compartir de Drive/Dropbox en descarga directa, descarga el video al servidor con progreso y rechaza enlaces que abren una página web en vez del archivo.
- **Vista previa**: `POST /api/preview` recodifica a H.264 (o WebM si el navegador no tiene H.264) a máx. 720p con preset rápido; los originales se suben una sola vez y se reutilizan para el mosaico.
- **Limpieza automática**: los archivos subidos/convertidos de más de 3 horas se eliminan periódicamente para no llenar el disco.
- Frontend estático en `public/` con selección múltiple (drag & drop) y selector de formato.
- Formatos soportados: `mp4`, `avi`, `mov`, `mkv`, `webm`, `gif`.
