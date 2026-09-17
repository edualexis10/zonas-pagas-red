# Conversor de Videos

Aplicación web para convertir videos entre distintos formatos (MP4, AVI, MOV, MKV, WEBM, GIF).

## Uso

```bash
npm install
npm start
```

Abre `http://localhost:3000`, sube un video, elige el formato de salida (MP4 por defecto) y descarga el resultado.

## Despliegue con URL pública (Railway / Render)

El repo incluye un `Dockerfile` que instala Node, Python y todas las
dependencias (incluye `torch` CPU-only para mantener la imagen liviana). Para
tener la app accesible desde cualquier lado:

**Railway**
1. Entra a [railway.app](https://railway.app) → "New Project" → "Deploy from GitHub repo".
2. Selecciona este repositorio y la rama que quieras desplegar.
3. Railway detecta el `Dockerfile` automáticamente y construye la imagen.
4. En "Settings" → "Networking", genera un dominio público. Ese es el link para abrir la app.

**Render**
1. Entra a [render.com](https://render.com) → "New" → "Web Service".
2. Conecta este repositorio; en "Environment" elige **Docker** (usa el `Dockerfile` del repo).
3. Render construye la imagen y te da una URL pública (`https://tu-app.onrender.com`) al terminar el deploy.

En ambos casos, una vez desplegado abre `/conteo.html` en esa URL para usar el
contador de pasajeros, o la raíz `/` para el conversor de video.

**Nota sobre recursos**: `ultralytics`/`torch` son pesados y corren en CPU en
los tiers gratuitos, así que el análisis de videos largos será lento (ver
sección "Videos largos" más abajo). Para uso real conviene un plan con más
CPU/RAM, o un servidor con GPU si el volumen de videos es alto.

## Cómo funciona

- Backend en Express (`server.js`) recibe el video subido con `multer`, lo procesa con `fluent-ffmpeg` (usando el binario incluido por `ffmpeg-static`, sin dependencias del sistema) y genera el archivo en el formato solicitado.
- Frontend estático en `public/` con un formulario de carga (drag & drop) y selector de formato.
- Formatos soportados: `mp4`, `avi`, `mov`, `mkv`, `webm`, `gif`.

## Contador de pasajeros (pagan vs. evaden)

Página en `public/conteo.html` para subir el video de hasta 3 cámaras de un bus
(1 puerta principal con validador + 2 puertas de bajada) y obtener un conteo
de pasajeros que pagaron vs. evadieron.

### Cómo funciona

- `passenger-counter/analyze.py` usa **YOLOv8** (`ultralytics`) para detectar y
  seguir personas en el video, y cuenta cruces sobre una línea virtual
  configurable por cámara.
- **Puerta principal**: además de contar cruces, revisa si cada persona
  permaneció ("dwell") el tiempo suficiente dentro de la zona del validador
  (`--zone`). Quien no lo hizo se cuenta como evasor.
- **Puertas de bajada**: no hay validador. Se asume que la parada NO es zona
  paga, así que cualquier persona que cruza la línea en sentido de *subida*
  (en vez de bajada) se cuenta como evasora.
- `server.js` expone `POST /api/passenger-count/analyze` (multipart: `video`,
  `doorType`, `line`, `zone`/`boardingSide` según la puerta) que invoca el
  script Python como subproceso y devuelve el resumen en JSON.

### Instalación de dependencias Python

```bash
cd passenger-counter
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
```

La primera ejecución descarga automáticamente los pesos `yolov8n.pt` (requiere
internet). Si el binario de Python no se llama `python3` en tu entorno, define
la variable de entorno `PYTHON_BIN` antes de correr `npm start`.

### Videos largos (ej. ~2 horas)

- **No subas videos largos a mí (Claude) por chat ni por un conector como Drive**: yo recibo archivos como texto (base64), así que algo de 200+ MB o 2 horas revienta el límite de contexto. Ese flujo solo sirve para clips cortos de prueba/calibración (10-60s).
- **Para uso real**, el video completo debe ir directo del origen (cámara/DVR o tu equipo) al servidor de esta app — por el formulario web (`conteo.html`) o llamando `POST /api/passenger-count/analyze` directamente — donde se guarda en disco y se procesa localmente, sin pasar por el chat.
- **Rendimiento**: analizar cada frame de un video de 2 horas con YOLO en CPU puede tardar horas. Usa el parámetro `vidStride` (o `--vid-stride` en el script) para analizar 1 de cada N frames — un valor de 3 a 5 acelera el análisis varias veces con impacto mínimo en el conteo, porque una persona tarda bien más de un frame en cruzar la puerta. Los umbrales de permanencia/histéresis se reescalan automáticamente según el stride.
- Si tienes acceso a GPU en el entorno de despliegue, ultralytics la usa automáticamente y es mucho más rápido que CPU para videos largos.

### Calibración (importante)

- La **línea de conteo** y la **zona del validador** están definidas como
  coordenadas normalizadas (0 a 1) respecto al ancho/alto del video, porque
  cada cámara tiene un encuadre distinto. Ajusta esos valores en la sección
  "Calibración avanzada" de cada cámara en `conteo.html` mirando un frame de
  referencia del video real.
- **Limitación importante**: el video no permite "leer" si el validador
  efectivamente aceptó el pago (luz verde, beep, etc.) salvo que se entrene un
  modelo específico para eso. La detección de "pagó" usa una heurística de
  permanencia frente al validador, que debe calibrarse y, de ser posible,
  contrastarse contra el log real de transacciones del validador para medir
  qué tan preciso es.
- La geolocalización (coordenadas GPS) solo puede obtenerse si el video ya
  trae esos metadatos embebidos (cámaras con GPS) o un overlay de texto con
  coordenadas quemado en la imagen (requeriría OCR adicional). No es posible
  derivar coordenadas reales solo a partir de la imagen.
