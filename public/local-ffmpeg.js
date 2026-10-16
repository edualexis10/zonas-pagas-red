// ---------------------------------------------------------------------------
// ffmpeg dentro del navegador (WebAssembly).
//
// Para lo que NO necesita recodificar (pasar un AVI/DAV del DVR a MP4, unir
// continuaciones del mismo tipo) no vale la pena subir gigas al servidor: se
// hace en el equipo del usuario, en segundos. Lo pesado (mosaico, comprimir)
// sigue en el servidor.
// ---------------------------------------------------------------------------

/* exported LocalFF */
const LocalFF = (() => {
  const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  // El ffmpeg del navegador trabaja en memoria: archivos más grandes van al servidor.
  const MAX_BYTES = (isMobile ? 0.4 : 1.5) * 1024 ** 3;
  const supported = typeof WebAssembly === 'object' && typeof Worker === 'function';

  let ffPromise = null;
  let chain = Promise.resolve();
  let dirSeq = 0;

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const el = document.createElement('script');
      el.src = src;
      el.onload = resolve;
      el.onerror = () => reject(new Error('No se pudo cargar el procesador local.'));
      document.head.appendChild(el);
    });
  }

  function getFF() {
    if (!ffPromise) {
      ffPromise = (async () => {
        if (!window.FFmpegWASM) await loadScript('/vendor/ffmpeg/ffmpeg.js');
        const ff = new window.FFmpegWASM.FFmpeg();
        await ff.load({
          coreURL: '/vendor/ffmpeg-core/ffmpeg-core.js',
          wasmURL: '/vendor/ffmpeg-core/ffmpeg-core.wasm',
        });
        return ff;
      })().catch((err) => {
        ffPromise = null;
        throw err;
      });
    }
    return ffPromise;
  }

  // Un trabajo a la vez (el ffmpeg del navegador es uno solo).
  function serial(fn) {
    const run = chain.then(fn, fn);
    chain = run.catch(() => {});
    return run;
  }

  // Lee de los mensajes de ffmpeg lo básico de cada archivo de entrada.
  function parseInputs(logs) {
    const inputs = [];
    let cur = null;
    for (const line of logs) {
      if (/^Input #\d+/.test(line)) {
        cur = { format: (line.match(/^Input #\d+, ([\w,]+)/) || [])[1] || null, duration: 0, vcodec: null, acodec: null, width: 0, height: 0 };
        inputs.push(cur);
        continue;
      }
      if (!cur) continue;
      const d = line.match(/Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/);
      if (d) cur.duration = Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]);
      const v = line.match(/Stream #\d+:\d+\S*: Video: (\w+)(?:[^\n]*?, (\d{2,5})x(\d{2,5}))?/);
      if (v && !cur.vcodec) {
        cur.vcodec = v[1];
        cur.width = Number(v[2]) || 0;
        cur.height = Number(v[3]) || 0;
      }
      const a = line.match(/Stream #\d+:\d+\S*: Audio: (\w+)/);
      if (a && !cur.acodec) cur.acodec = a[1];
      if (/^Output #/.test(line)) cur = null;
    }
    return inputs;
  }

  // Ejecuta ffmpeg con los archivos montados (sin copiarlos a memoria).
  // args(dir) arma la línea de comandos; devuelve el archivo de salida.
  function run(files, args, outName, onProgress, extraFiles = {}) {
    return serial(async () => {
      const ff = await getFF();
      const dir = `/in${++dirSeq}`;
      const logs = [];
      const onLog = ({ message }) => logs.push(message);
      const onProg = ({ progress }) => {
        if (onProgress && progress >= 0 && progress <= 1) onProgress(Math.round(progress * 100));
      };
      await ff.createDir(dir);
      await ff.mount('WORKERFS', { files }, dir);
      for (const [name, text] of Object.entries(extraFiles)) await ff.writeFile(name, text.replace(/\{dir\}/g, dir));
      ff.on('log', onLog);
      ff.on('progress', onProg);
      try {
        const code = await ff.exec(args(dir));
        if (outName === null) return { logs, inputs: parseInputs(logs) };
        if (code !== 0) throw new Error(`ffmpeg terminó con código ${code}`);
        const data = await ff.readFile(outName);
        return { data, logs, inputs: parseInputs(logs) };
      } finally {
        ff.off('log', onLog);
        ff.off('progress', onProg);
        if (outName) await ff.deleteFile(outName).catch(() => {});
        for (const name of Object.keys(extraFiles)) await ff.deleteFile(name).catch(() => {});
        await ff.unmount(dir).catch(() => {});
        await ff.deleteDir(dir).catch(() => {});
      }
    });
  }

  async function probe(files) {
    const { inputs } = await run(files, (dir) => ['-hide_banner', ...files.flatMap((f) => ['-i', `${dir}/${f.name}`])], null);
    return inputs;
  }

  const canUse = (files) => supported && files.every((f) => f instanceof File) && files.reduce((s, f) => s + f.size, 0) <= MAX_BYTES;

  // AVI/DAV/.264 con H.264 (o H.265 si el navegador lo reproduce) → MP4 sin
  // recodificar el video. Devuelve null si no se puede (otro formato de video).
  async function toMp4(file, { canHevc = false, onProgress } = {}) {
    if (!canUse([file])) return null;
    const [info] = await probe([file]);
    if (!info || !(info.vcodec === 'h264' || (info.vcodec === 'hevc' && canHevc))) return null;
    const { data } = await run(
      [file],
      (dir) => [
        '-fflags', '+genpts',
        '-i', `${dir}/${file.name}`,
        '-map', '0:v:0',
        '-map', '0:a:0?',
        '-c:v', 'copy',
        ...(info.vcodec === 'hevc' ? ['-tag:v', 'hvc1'] : []),
        ...(info.acodec === 'aac' ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '128k']),
        '-movflags', '+faststart',
        '/out.mp4',
      ],
      '/out.mp4',
      onProgress
    );
    return { blob: new Blob([data.buffer], { type: 'video/mp4' }), info };
  }

  // Une partes H.264 seguidas (mismo tamaño y tipo de archivo) pegando el
  // video sin recodificar; el audio de cada parte se ajusta a su duración
  // (igual que en el servidor). Devuelve null si no se puede hacer aquí.
  async function concat(files, { onProgress } = {}) {
    if (files.length < 2 || !canUse(files)) return null;
    const infos = await probe(files);
    if (infos.length !== files.length) return null;
    const first = infos[0];
    const same = infos.every(
      (i) => i.vcodec === 'h264' && i.width === first.width && i.height === first.height && i.format === first.format
    );
    if (!same) return null;
    const total = infos.reduce((s, i) => s + i.duration, 0);
    const withAudio = infos.some((i) => i.acodec);
    const chains = infos.map((info, i) => {
      const d = Math.round((info.duration || 1) * 1000) / 1000;
      return info.acodec
        ? `[${i + 1}:a:0]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,apad,atrim=duration=${d},asetpts=PTS-STARTPTS[a${i}]`
        : `anullsrc=r=48000:cl=stereo,atrim=duration=${d}[a${i}]`;
    });
    const list = files.map((f) => `file '{dir}/${f.name.replace(/'/g, "'\\''")}'`).join('\n');
    const { data } = await run(
      files,
      (dir) => [
        '-f', 'concat', '-safe', '0', '-i', '/list.txt',
        ...(withAudio ? files.flatMap((f) => ['-i', `${dir}/${f.name}`]) : []),
        '-map', '0:v:0', '-c:v', 'copy',
        ...(withAudio
          ? ['-filter_complex', `${chains.join(';')};${infos.map((_, i) => `[a${i}]`).join('')}concat=n=${files.length}:v=0:a=1[outa]`, '-map', '[outa]', '-c:a', 'aac', '-b:a', '128k']
          : ['-an']),
        '-movflags', '+faststart',
        '/out.mp4',
      ],
      '/out.mp4',
      onProgress,
      { '/list.txt': list }
    );
    return { blob: new Blob([data.buffer], { type: 'video/mp4' }), duration: total, infos };
  }

  return { supported, MAX_BYTES, canUse, probe, toMp4, concat };
})();
