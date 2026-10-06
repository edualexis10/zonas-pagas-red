'use strict';

// ---------- Estado ----------

const DRAFT_KEY = 'informe-borrador-v1';
const FIRMA_KEY = 'informe-firma-v1';
const TERMINALES_KEY = 'informe-terminales-v1';

const INTRO_DEFAULT = 'El presente informe tiene como objetivo detallar cada movimiento que el bus realizó antes, durante y después del {hecho}, indicando fecha/hora e imagen GPS. A continuación, se detalla lo mencionado:';
const FIRMA_DEFAULT = 'Nombre Apellido\nJefe COF\nCentro de Operación de Flota\nSantiago Transporte Urbano S.A.';

function blankState() {
  return {
    ppu: '', responsable: '', rut: '', terminal: '', fecha: '', genero: 'f', motivo: 'incidente',
    servicio: '', sentido: '', destino: '',
    eventos: [],
    grabaciones: 'sin_sistema', grabImagenes: [],
    cierre: '', intro: '', firmaTexto: FIRMA_DEFAULT,
  };
}

let state = blankState();
let firmaImg = null; // { data, width, height } — solo en este navegador
let seq = 0;

function newEvent(tipo) {
  return {
    id: `e${Date.now().toString(36)}${(seq++).toString(36)}`,
    tipo, hora: '', lugar: '', velocidad: '', minutos: '',
    accion: 'solera', complemento: '', consecuencia: 'danos_bus', detalle: '',
    imagenes: [], texto: '', editado: false, ocr: null,
  };
}

// ---------- Utilidades de texto ----------

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

function fechaLarga(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
  if (!m) return '';
  return `${Number(m[3])} de ${MESES[Number(m[2]) - 1]} de ${m[1]}`;
}

function titleCase(s) {
  return String(s || '').toLowerCase().replace(/(^|[\s-])(\p{L})/gu, (x, sep, ch) => sep + ch.toUpperCase());
}

// "avenida einstein" → "Avenida Einstein"; si ya viene con mayúsculas se respeta.
const MENORES = new Set(['de', 'del', 'la', 'las', 'los', 'el', 'con', 'y', 'e', 'en', 'a', 'al', 'entre', 'esquina']);
function calle(s) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  if (/\p{Lu}/u.test(t)) return t;
  return t.split(' ').map((w, i) => (i > 0 && MENORES.has(w) ? w : w.charAt(0).toUpperCase() + w.slice(1))).join(' ');
}

function normPpu(s) {
  const raw = String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const m = /^([A-Z]{2,4})(\d{2,4})$/.exec(raw);
  return m ? `${m[1]}-${m[2]}` : String(s || '').toUpperCase().trim();
}

function rutDv(body) {
  let sum = 0;
  let mul = 2;
  for (let i = body.length - 1; i >= 0; i--) {
    sum += Number(body[i]) * mul;
    mul = mul === 7 ? 2 : mul + 1;
  }
  const r = 11 - (sum % 11);
  return r === 11 ? '0' : r === 10 ? 'K' : String(r);
}

function normRut(s) {
  const raw = String(s || '').toUpperCase().replace(/[^0-9K]/g, '');
  if (raw.length < 2) return String(s || '').trim();
  return `${raw.slice(0, -1)}-${raw.slice(-1)}`;
}

function rutValido(s) {
  const m = /^(\d{6,8})-([0-9K])$/.exec(normRut(s));
  return !!m && rutDv(m[1]) === m[2];
}

// Palabras que suelen quedar sin tilde al escribir rápido.
const TILDES = {
  expedicion: 'expedición', direccion: 'dirección', colision: 'colisión', interseccion: 'intersección',
  camara: 'cámara', camaras: 'cámaras', grabacion: 'grabación', vehiculo: 'vehículo', vehiculos: 'vehículos',
  informacion: 'información', ubicacion: 'ubicación', situacion: 'situación', atencion: 'atención',
  rapido: 'rápido', rapida: 'rápida', transmision: 'transmisión', kilometros: 'kilómetros', segun: 'según',
  despues: 'después', tambien: 'también', ademas: 'además', transito: 'tránsito', maniobro: 'maniobró',
  colisiono: 'colisionó', realizo: 'realizó', ocasiono: 'ocasionó',
  agresion: 'agresión', lesion: 'lesión', conduccion: 'conducción', desvinculacion: 'desvinculación',
  medico: 'médico', policia: 'policía', publico: 'público', publica: 'pública',
  numero: 'número', area: 'área', via: 'vía', mecanica: 'mecánica', mecanico: 'mecánico',
};

function pulir(text) {
  let s = String(text || '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  s = s
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/([,;])(?=[^\s\d])/g, '$1 ')
    .replace(/\.{2,}/g, '.')
    .replace(/,\./g, '.')
    .replace(/\b(\d{1,2})[.:](\d{2})\s*(?:hrs?\.?|horas?)(?=[\s,.;]|$)/gi, '$1:$2 horas')
    .replace(/\bhrs?\.?(?=[\s,.;]|$)/gi, 'horas')
    .replace(/\baprox\.?(?=[\s,.;]|$)/gi, 'aproximadamente')
    .replace(/\bkm\/hr?s?\b/gi, 'km/h')
    .replace(/\b([A-Za-z]{4})-(\d{2})\b|\b([A-Z]{4})(\d{2})\b/g, (m, a, b, c, d) => `${(a || c).toUpperCase()}-${b || d}`)
    .replace(/\b\p{L}+\b/gu, (w) => {
      const fix = TILDES[w.toLowerCase()];
      if (!fix || fix === w.toLowerCase()) return w;
      return w[0] === w[0].toUpperCase() ? fix[0].toUpperCase() + fix.slice(1) : fix;
    });
  s = s[0].toUpperCase() + s.slice(1);
  if (!/[.!?:]$/.test(s)) s += '.';
  return s;
}

function lowerFirst(s) { return s ? s[0].toLowerCase() + s.slice(1) : s; }
function ph(label) { return `[${label}]`; } // dato faltante: se resalta y se avisa

// ---------- Redacción automática ----------

const ACCIONES = {
  solera: 'colisiona con la solera',
  vehiculo: 'colisiona con un vehículo particular',
  bus: 'colisiona con otro bus del sistema',
  objeto: 'colisiona con un objeto fijo',
  atropello: 'atropella a un peatón',
  caida: 'registra la caída de un pasajero al interior del bus',
  agresion: 'es víctima de una agresión por parte de un usuario',
  frenado: 'realiza una maniobra de frenado brusco',
  falla: 'presenta una falla mecánica',
};
const CONSECUENCIAS = {
  danos_bus: 'ocasionando daños materiales en el bus',
  danos_terceros: 'ocasionando daños materiales a terceros',
  danos_ambos: 'ocasionando daños materiales en el bus y a terceros',
  lesion_pasajero: 'resultando un pasajero lesionado',
  lesion_tercero: 'resultando un tercero lesionado',
  sin_danos: 'sin registrar daños ni lesionados',
};

function redactar(ev, i) {
  const ppu = state.ppu || ph('PPU');
  const cond = state.genero === 'm' ? 'el conductor' : 'la conductora';
  const hora = ev.hora || ph('hora');
  const svc = state.servicio || ph('servicio');
  const sentido = state.sentido || ph('sentido');
  const lugar = (ev.lugar || '').trim() || ph('lugar');
  const vel = Number(ev.velocidad);
  const detalle = ev.detalle ? ` ${pulir(ev.detalle)}` : '';
  const fecha = fechaLarga(state.fecha);

  // Conectores: el primero lleva la fecha, el fin va con "Posteriormente".
  const mids = ['A las', 'Luego, a las', 'Más tarde, a las'];
  const midIndex = state.eventos.slice(0, i).filter((e) => e.tipo !== 'fin').length;
  let lead;
  if (i === 0) lead = `${fecha ? `Con fecha ${fecha}, a` : 'A'} las ${hora} horas`;
  else if (ev.tipo === 'fin') lead = `Posteriormente, a las ${hora} horas`;
  else lead = `${mids[(midIndex - 1 + mids.length) % mids.length]} ${hora} horas`;

  switch (ev.tipo) {
    case 'inicio': {
      const dest = state.destino ? `, con dirección a ${state.destino}` : '';
      if (i === 0) {
        return `${fecha ? `Con fecha ${fecha}, el` : 'El'} bus ${ppu} inicia expedición prestando servicio ${svc}, sentido ${sentido}, a las ${hora} horas${dest}.`;
      }
      return `${lead}, el bus ${ppu} inicia una nueva expedición prestando servicio ${svc}, sentido ${sentido}${dest}.`;
    }
    case 'recorrido':
      return `${lead}, el bus ${ppu} transita por ${lugar}${vel > 0 ? ` a una velocidad de ${vel} km/h` : ''}, prestando servicio ${svc}, sentido ${sentido}.`;
    case 'incidente': {
      const accion = ev.accion === 'otra' ? (lowerFirst(pulir(ev.complemento).replace(/\.$/, '')) || ph('qué ocurrió')) : ACCIONES[ev.accion];
      const comp = ev.accion !== 'otra' && ev.complemento.trim() ? ` ${ev.complemento.trim().replace(/[.,]+$/, '')}` : '';
      const cons = CONSECUENCIAS[ev.consecuencia] ? `, ${CONSECUENCIAS[ev.consecuencia]}` : '';
      const velTxt = vel > 0 ? ` a una velocidad de ${vel} km/h` : '';
      return `${lead}, mientras realizaba su recorrido por ${lugar}${velTxt}, ${cond} del bus ${ppu} ${accion}${comp}${cons}.${detalle}`;
    }
    case 'detencion': {
      const min = Number(ev.minutos) > 0 ? ` durante ${Number(ev.minutos)} minutos aproximadamente` : '';
      return `${lead}, el bus ${ppu} se mantiene detenido en ${lugar}${min}.${detalle}`;
    }
    case 'desvio':
      return `${lead}, el bus ${ppu} se desvía de su trazado habitual en ${lugar}.${detalle}`;
    case 'retoma':
      return `${lead}, el bus ${ppu} retoma su recorrido${ev.lugar ? ` por ${ev.lugar.trim()}` : ''}.`;
    case 'fin':
      return `${lead}, ${cond} del bus ${ppu} finaliza la expedición correspondiente al servicio ${svc}, sentido ${sentido}, ingresando al terminal ${state.terminal || ph('terminal')}.`;
    default: {
      const t = pulir(ev.detalle);
      if (!t) return ev.hora ? `${lead}, ${ph('detalle')}.` : ph('detalle');
      if (!ev.hora || /^a las/i.test(t)) return t;
      return `${lead}, ${lowerFirst(t)}`;
    }
  }
}

const GRABACIONES = {
  sin_sistema: 'Bus no presenta sistema de grabaciones.',
  adjunta: 'Se adjuntan imágenes obtenidas del sistema de grabación del bus.',
  no_disponible: 'Las grabaciones del bus no se encuentran disponibles para el horario del incidente.',
  en_revision: 'Las grabaciones del bus se encuentran en proceso de descarga y revisión.',
};

function introTexto() {
  const hecho = state.motivo === 'incidente' ? 'incidente' : 'hecho informado';
  return pulir(state.intro || INTRO_DEFAULT.replace('{hecho}', hecho));
}

function refreshTexts() {
  state.eventos.forEach((ev, i) => { if (!ev.editado) ev.texto = redactar(ev, i); });
}

// Párrafos finales (viñetas) tal como irán al Word.
function items() {
  const list = state.eventos.map((ev) => ({ text: ev.texto, images: ev.imagenes }));
  if (GRABACIONES[state.grabaciones]) {
    list.push({ text: GRABACIONES[state.grabaciones], images: state.grabaciones === 'adjunta' ? state.grabImagenes : [] });
  }
  if (state.cierre.trim()) list.push({ text: pulir(state.cierre), images: [] });
  return list;
}

// ---------- Revisión (detección de problemas) ----------

function toMin(h) { const m = /^(\d{2}):(\d{2})$/.exec(h || ''); return m ? Number(m[1]) * 60 + Number(m[2]) : null; }

function revisar() {
  const out = [];
  const add = (level, msg) => out.push({ level, msg });
  const req = [['ppu', 'la PPU'], ['responsable', 'el responsable'], ['rut', 'el RUT'], ['terminal', 'el terminal'], ['fecha', 'la fecha']];
  req.forEach(([k, n]) => { if (!String(state[k] || '').trim()) add('err', `Falta ${n}.`); });
  if (state.rut && !rutValido(state.rut)) add('err', `El RUT ${state.rut} no es válido: revisa el dígito verificador.`);
  if (state.ppu && !/^([A-Z]{4}-\d{2}|[A-Z]{2}-\d{4})$/.test(state.ppu)) add('warn', `La PPU "${state.ppu}" no tiene el formato ABCD-12.`);
  if (!state.eventos.length) add('err', 'Agrega al menos un movimiento (o pega una captura GPS).');

  const tipos = state.eventos.map((e) => e.tipo);
  if (state.eventos.length && state.motivo === 'incidente' && !tipos.includes('incidente')) add('warn', 'No hay ningún movimiento de tipo Incidente.');
  if (state.eventos.length && !tipos.includes('inicio')) add('info', 'No se indica el inicio de la expedición.');
  if (state.eventos.length && !tipos.includes('fin')) add('info', 'No se indica el fin de la expedición.');

  let prev = null;
  state.eventos.forEach((ev, i) => {
    const n = i + 1;
    if (!ev.hora) add('err', `Movimiento ${n}: falta la hora.`);
    const t = toMin(ev.hora);
    if (t !== null && prev !== null && t < prev) add('warn', `Movimiento ${n}: la hora ${ev.hora} es anterior a la del movimiento ${n - 1}.`);
    if (t !== null) prev = t;
    if (!ev.imagenes.length) add('warn', `Movimiento ${n}: sin imagen GPS.`);
    const faltan = (ev.texto.match(/\[[^\]]+\]/g) || []).filter((x) => x !== '[hora]');
    if (faltan.length) add('err', `Movimiento ${n}: completa ${[...new Set(faltan)].join(', ')}.`);
    if (ev.ocr && ev.ocr.fields) {
      const f = ev.ocr.fields;
      if (f.hora && ev.hora && f.hora !== ev.hora) add('warn', `Movimiento ${n}: la imagen GPS marca ${f.hora} y escribiste ${ev.hora}.`);
      if (f.fecha && state.fecha && f.fecha.slice(5) !== state.fecha.slice(5)) add('warn', `Movimiento ${n}: la imagen GPS es de otro día (${f.fecha.split('-').reverse().join('/')}).`);
    }
    if (ev.editado && /\[[^\]]+\]/.test(ev.texto)) add('err', `Movimiento ${n}: el texto editado aún tiene datos entre corchetes.`);
  });
  if (state.grabaciones === 'adjunta' && !state.grabImagenes.length) add('warn', 'Marcaste que se adjuntan grabaciones, pero no hay imágenes.');
  if (!firmaImg && !state.firmaTexto.trim()) add('info', 'El informe va sin firma.');
  return out;
}

// ---------- Imágenes ----------

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

// Fotos de celular pesan mucho: se reducen a 1800 px y JPEG. Las capturas
// PNG pequeñas quedan tal cual para no perder nitidez del texto del GPS.
async function prepareImage(file) {
  const data = await readAsDataUrl(file);
  const img = await loadImage(data);
  const big = img.naturalWidth > 1800 || file.size > 1.5 * 1024 * 1024 || !/png|jpe?g/.test(file.type);
  if (!big) return { data, width: img.naturalWidth, height: img.naturalHeight };
  const k = Math.min(1, 1800 / img.naturalWidth);
  const c = document.createElement('canvas');
  c.width = Math.round(img.naturalWidth * k);
  c.height = Math.round(img.naturalHeight * k);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(img, 0, 0, c.width, c.height);
  return { data: c.toDataURL('image/jpeg', 0.88), width: c.width, height: c.height };
}

async function ocrImage(ev, file) {
  ev.ocr = { status: 'busy' };
  renderEvents();
  try {
    const fd = new FormData();
    fd.append('image', file);
    const res = await fetch('/api/informe/ocr', { method: 'POST', body: fd });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || 'Error');
    const f = json.fields || {};
    ev.ocr = { status: 'done', fields: f };
    const filled = [];
    if (f.hora && !ev.hora) { ev.hora = f.hora; filled.push('hora'); }
    if (f.velocidad && !ev.velocidad && ['recorrido', 'incidente'].includes(ev.tipo)) ev.velocidad = f.velocidad;
    if (f.fecha && !state.fecha) { state.fecha = f.fecha; markFilled('fecha'); }
    if (f.servicio && !state.servicio) { state.servicio = f.servicio; markFilled('servicio'); }
    if (f.sentido && !state.sentido) { state.sentido = f.sentido; markFilled('sentido'); }
    if (f.destino && !state.destino) { state.destino = f.destino; markFilled('destino'); }
    sortIfTimed();
  } catch (err) {
    ev.ocr = { status: 'fail' };
  }
  syncFields();
  update(true);
}

function ocrSummary(ocr) {
  if (!ocr) return '';
  if (ocr.status === 'busy') return 'Leyendo la imagen…';
  if (ocr.status === 'fail') return 'No se pudo leer la imagen; completa la hora a mano.';
  const f = ocr.fields || {};
  const parts = [f.hora, [f.servicio, f.sentido].filter(Boolean).join(' '), f.destino && `a ${f.destino}`, f.velocidad && `${f.velocidad} km/h`, f.rumbo].filter(Boolean);
  return parts.length ? `Detectado: ${parts.join(' · ')}` : 'La imagen no tiene datos GPS legibles.';
}

// Al pegar varias capturas sin hora, se ordenan por la hora detectada.
function sortIfTimed() {
  const timed = state.eventos.every((e) => e.hora);
  if (!timed) return;
  const sorted = [...state.eventos].sort((a, b) => toMin(a.hora) - toMin(b.hora));
  if (sorted.some((e, i) => e !== state.eventos[i]) && state.eventos.every((e) => !e.editado)) state.eventos = sorted;
}

// Tipo sugerido para una captura nueva: inicio → incidente → fin.
function guessTipo() {
  const tipos = state.eventos.map((e) => e.tipo);
  if (!tipos.length) return 'inicio';
  if (!tipos.includes('incidente')) return 'incidente';
  if (!tipos.includes('fin')) return 'fin';
  return 'recorrido';
}

async function addImagesToEvent(ev, files) {
  for (const file of files) {
    if (!/^image\//.test(file.type)) continue;
    const prepared = await prepareImage(file);
    ev.imagenes.push(prepared);
    update(true);
    if (!ev.ocr || ev.ocr.status !== 'done') ocrImage(ev, file);
  }
}

async function newEventsFromImages(files) {
  for (const file of files) {
    if (!/^image\//.test(file.type)) continue;
    const ev = newEvent(guessTipo());
    state.eventos.push(ev);
    await addImagesToEvent(ev, [file]);
  }
}

// ---------- Render ----------

const $ = (sel, root = document) => root.querySelector(sel);
const eventsEl = $('#events');
const tpl = $('#tpl-event');

function thumb(imgObj, onRemove) {
  const div = document.createElement('div');
  div.className = 'thumb';
  const img = document.createElement('img');
  img.src = imgObj.data;
  img.alt = '';
  const b = document.createElement('button');
  b.type = 'button';
  b.title = 'Quitar imagen';
  b.textContent = '✕';
  b.addEventListener('click', onRemove);
  div.append(img, b);
  return div;
}

function renderEvents() {
  const focused = document.activeElement;
  const focusId = focused && focused.closest('.event') ? focused.id : null;
  eventsEl.textContent = '';
  state.eventos.forEach((ev, i) => {
    const li = tpl.content.firstElementChild.cloneNode(true);
    li.dataset.id = ev.id;
    li.classList.toggle('is-incidente', ev.tipo === 'incidente');
    $('.ev-num', li).textContent = i + 1;
    const tipo = $('.ev-tipo', li);
    tipo.value = ev.tipo;
    tipo.id = `${ev.id}-tipo`;
    const hora = $('.ev-hora', li);
    hora.value = ev.hora;
    hora.id = `${ev.id}-hora`;
    li.querySelectorAll('[data-show]').forEach((el) => { el.hidden = !el.dataset.show.split(' ').includes(ev.tipo); });
    li.querySelectorAll('[data-f]').forEach((el) => { el.value = ev[el.dataset.f]; el.id = `${ev.id}-${el.dataset.f}`; });
    const comp = $('[data-f="complemento"]', li);
    comp.placeholder = ev.accion === 'otra' ? 'Describe qué ocurrió: colisiona con…' : 'del paradero ubicado en dicha avenida';
    const thumbs = $('.thumbs', li);
    ev.imagenes.forEach((im, k) => thumbs.append(thumb(im, () => { ev.imagenes.splice(k, 1); if (!ev.imagenes.length) ev.ocr = null; update(true); })));
    const chip = $('.ocr-chip', li);
    chip.hidden = !ev.ocr;
    chip.textContent = ocrSummary(ev.ocr);
    chip.className = `ocr-chip ${ev.ocr ? ev.ocr.status : ''}`;
    const ta = $('.ev-texto', li);
    ta.value = ev.texto;
    ta.id = `${ev.id}-texto`;
    ta.classList.toggle('edited', ev.editado);
    $('[data-act="regen"]', li).hidden = !ev.editado;
    $('[data-act="up"]', li).disabled = i === 0;
    $('[data-act="down"]', li).disabled = i === state.eventos.length - 1;
    eventsEl.append(li);
  });
  const again = focusId && document.getElementById(focusId);
  if (again) again.focus();
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function renderPaper() {
  const its = items();
  const list = its.map((it) => {
    const txt = esc(it.text || '').replace(/\[[^\]]+\]/g, (m) => `<span class="ph">${m}</span>`);
    const imgs = (it.images || []).map((im) => `<img src="${im.data}" alt="" />`).join('');
    return `<li>${txt || '<span class="doc-empty">(sin texto)</span>'}${imgs}</li>`;
  }).join('');
  const firma = firmaImg
    ? `<img src="${firmaImg.data}" alt="Firma" />`
    : state.firmaTexto.trim()
      ? `<span class="line">${state.firmaTexto.trim().split('\n').map((l, i) => (i === 0 ? `<strong>${esc(l)}</strong>` : esc(l))).join('<br />')}</span>`
      : '';
  $('#paper').innerHTML = `
    <div class="doc-header"><img src="logo.png" alt="" /><h2>INFORME ${esc(state.ppu)}</h2></div>
    <p class="doc-intro">${esc(introTexto())}</p>
    <table class="doc-table">
      <tr><th>PPU:</th><td>${esc(state.ppu)}</td></tr>
      <tr><th>Responsable</th><td>${esc(state.responsable)}</td></tr>
      <tr><th>Rut:</th><td>${esc(state.rut)}</td></tr>
      <tr><th>Terminal:</th><td>${esc(state.terminal)}</td></tr>
    </table>
    ${list ? `<ul class="doc-list">${list}</ul>` : '<p class="doc-empty">Los movimientos aparecerán aquí.</p>'}
    <div class="doc-firma">${firma}</div>`;
}

function renderReview() {
  const issues = revisar();
  const errs = issues.filter((x) => x.level === 'err').length;
  const warns = issues.filter((x) => x.level === 'warn').length;
  const pill = $('#status-pill');
  pill.className = `status-pill ${errs ? 'err' : warns ? 'warn' : 'ok'}`;
  pill.textContent = errs ? `${errs} dato${errs > 1 ? 's' : ''} por completar` : warns ? `${warns} aviso${warns > 1 ? 's' : ''}` : 'Listo para exportar';
  const ul = $('#issues');
  ul.textContent = '';
  (issues.length ? issues : [{ level: 'ok', msg: 'Todo revisado: datos completos y horas en orden.' }]).forEach((x) => {
    const li = document.createElement('li');
    li.className = x.level;
    li.textContent = x.msg;
    ul.append(li);
  });
  $('#f-rut').classList.toggle('bad', !!state.rut && !rutValido(state.rut));
}

function syncFields() {
  document.querySelectorAll('[data-k]').forEach((el) => {
    const v = state[el.dataset.k] ?? '';
    if (el.value !== v) el.value = v; // mismo valor: no mueve el cursor
  });
  $('#grab-images-wrap').hidden = state.grabaciones !== 'adjunta';
  const gi = $('#grab-images');
  gi.textContent = '';
  state.grabImagenes.forEach((im, k) => gi.append(thumb(im, () => { state.grabImagenes.splice(k, 1); update(); })));
  $('#f-intro').placeholder = INTRO_DEFAULT.replace('{hecho}', state.motivo === 'incidente' ? 'incidente' : 'hecho informado');
  const fi = $('#firma-img');
  fi.hidden = !firmaImg;
  if (firmaImg) fi.src = firmaImg.data;
  $('#firma-quitar').hidden = !firmaImg;
}

function markFilled(k) {
  const el = document.querySelector(`[data-k="${k}"]`);
  if (!el) return;
  el.classList.add('filled');
  setTimeout(() => el.classList.remove('filled'), 2500);
}

let saveTimer = null;
function update(structural = false) {
  refreshTexts();
  if (structural) renderEvents();
  else {
    // Solo actualiza los textos sin reconstruir (mantiene el foco al escribir).
    state.eventos.forEach((ev) => {
      const ta = document.getElementById(`${ev.id}-texto`);
      if (ta && document.activeElement !== ta) ta.value = ev.texto;
    });
  }
  renderPaper();
  renderReview();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveDraft, 400);
}

// ---------- Borrador ----------

function saveDraft() {
  const note = $('#save-note');
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify(state));
    note.textContent = 'Borrador guardado en este navegador.';
  } catch (e) {
    try {
      const light = { ...state, eventos: state.eventos.map((ev) => ({ ...ev, imagenes: [] })), grabImagenes: [] };
      localStorage.setItem(DRAFT_KEY, JSON.stringify(light));
      note.textContent = 'Borrador guardado sin imágenes (son muy pesadas para el navegador). Descarga el Word antes de cerrar.';
    } catch (e2) {
      note.textContent = 'No se pudo guardar el borrador en este navegador.';
    }
  }
}

function loadDraft() {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (raw) state = { ...blankState(), ...JSON.parse(raw) };
  } catch (e) { /* sin borrador */ }
  try {
    const f = localStorage.getItem(FIRMA_KEY);
    if (f) firmaImg = JSON.parse(f);
  } catch (e) { /* sin firma */ }
  renderTerminales();
}

function renderTerminales() {
  let list = ['Santa Clara'];
  try { list = [...new Set([...list, ...JSON.parse(localStorage.getItem(TERMINALES_KEY) || '[]')])]; } catch (e) { /* nada */ }
  $('#terminales').innerHTML = list.map((t) => `<option value="${esc(t)}"></option>`).join('');
}

function rememberTerminal(t) {
  if (!t) return;
  try {
    const list = JSON.parse(localStorage.getItem(TERMINALES_KEY) || '[]');
    if (!list.includes(t)) { list.push(t); localStorage.setItem(TERMINALES_KEY, JSON.stringify(list.slice(-20))); }
  } catch (e) { /* nada */ }
  renderTerminales();
}

// ---------- Eventos de la página ----------

document.querySelectorAll('[data-k]').forEach((el) => {
  el.addEventListener('input', () => {
    state[el.dataset.k] = el.value;
    if (el.dataset.k === 'grabaciones') syncFields();
    update();
  });
});

// Normaliza al salir del campo: mayúsculas, guion, tildes, etc.
$('#f-ppu').addEventListener('change', (e) => { state.ppu = normPpu(e.target.value); e.target.value = state.ppu; update(); });
$('#f-rut').addEventListener('change', (e) => { state.rut = normRut(e.target.value); e.target.value = state.rut; update(); });
$('#f-responsable').addEventListener('change', (e) => { state.responsable = e.target.value.replace(/\s+/g, ' ').trim().toUpperCase(); e.target.value = state.responsable; update(); });
$('#f-terminal').addEventListener('change', (e) => { state.terminal = titleCase(e.target.value.trim()); e.target.value = state.terminal; rememberTerminal(state.terminal); update(); });
$('#f-destino').addEventListener('change', (e) => { state.destino = titleCase(e.target.value.trim()); e.target.value = state.destino; update(); });
$('#f-servicio').addEventListener('change', (e) => { state.servicio = e.target.value.replace(/\s+/g, '').toUpperCase(); e.target.value = state.servicio; update(); });
['#f-ppu', '#f-rut', '#f-responsable', '#f-terminal', '#f-destino', '#f-servicio', '#f-sentido', '#f-fecha', '#f-genero', '#f-motivo'].forEach((s) => {
  $(s).addEventListener('change', () => update(true));
});

function eventOf(el) {
  const li = el.closest('.event');
  return li ? state.eventos.find((e) => e.id === li.dataset.id) : null;
}

eventsEl.addEventListener('input', (e) => {
  const ev = eventOf(e.target);
  if (!ev) return;
  const t = e.target;
  if (t.classList.contains('ev-texto')) {
    ev.texto = t.value;
    ev.editado = true;
    t.classList.add('edited');
    $('[data-act="regen"]', t.closest('.event')).hidden = false;
  } else if (t.classList.contains('ev-hora')) ev.hora = t.value;
  else if (t.dataset.f) ev[t.dataset.f] = t.value;
  update();
});

eventsEl.addEventListener('change', (e) => {
  const ev = eventOf(e.target);
  if (!ev) return;
  if (e.target.classList.contains('ev-tipo')) { ev.tipo = e.target.value; update(true); }
  else if (e.target.dataset.f === 'accion') update(true);
  else if (e.target.dataset.f === 'lugar') {
    ev.lugar = calle(e.target.value);
    e.target.value = ev.lugar;
    update();
  }
  else if (e.target.type === 'file') {
    addImagesToEvent(ev, [...e.target.files]);
    e.target.value = '';
  } else if (e.target.classList.contains('ev-texto')) {
    ev.texto = pulir(e.target.value);
    e.target.value = ev.texto;
    update();
  } else if (e.target.classList.contains('ev-hora')) { sortIfTimed(); update(true); }
});

eventsEl.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const ev = eventOf(btn);
  const i = state.eventos.indexOf(ev);
  const act = btn.dataset.act;
  if (act === 'del') state.eventos.splice(i, 1);
  if (act === 'up' && i > 0) [state.eventos[i - 1], state.eventos[i]] = [state.eventos[i], state.eventos[i - 1]];
  if (act === 'down' && i < state.eventos.length - 1) [state.eventos[i + 1], state.eventos[i]] = [state.eventos[i], state.eventos[i + 1]];
  if (act === 'regen') ev.editado = false;
  update(true);
});

// Arrastrar una imagen sobre un movimiento la agrega a ese movimiento.
eventsEl.addEventListener('dragover', (e) => { const li = e.target.closest('.event'); if (li) { e.preventDefault(); li.classList.add('drag'); } });
eventsEl.addEventListener('dragleave', (e) => { const li = e.target.closest('.event'); if (li) li.classList.remove('drag'); });
eventsEl.addEventListener('drop', (e) => {
  const li = e.target.closest('.event');
  if (!li) return;
  e.preventDefault();
  e.stopPropagation();
  li.classList.remove('drag');
  addImagesToEvent(eventOf(li), [...e.dataTransfer.files]);
});

document.querySelectorAll('[data-add]').forEach((b) => b.addEventListener('click', () => {
  state.eventos.push(newEvent(b.dataset.add));
  update(true);
  const last = eventsEl.lastElementChild;
  if (last) { last.scrollIntoView({ block: 'nearest' }); $('.ev-hora', last).focus(); }
}));

const pasteZone = $('#paste-zone');
$('#paste-file').addEventListener('change', (e) => { newEventsFromImages([...e.target.files]); e.target.value = ''; });
pasteZone.addEventListener('dragover', (e) => { e.preventDefault(); pasteZone.classList.add('drag'); });
pasteZone.addEventListener('dragleave', () => pasteZone.classList.remove('drag'));
pasteZone.addEventListener('drop', (e) => { e.preventDefault(); pasteZone.classList.remove('drag'); newEventsFromImages([...e.dataTransfer.files]); });

// Ctrl+V en cualquier parte: si el foco está en un movimiento, la imagen va
// a ese movimiento; si no, se crea uno nuevo.
document.addEventListener('paste', (e) => {
  const files = [...(e.clipboardData ? e.clipboardData.files : [])].filter((f) => /^image\//.test(f.type));
  if (!files.length) return;
  e.preventDefault();
  const ev = document.activeElement ? eventOf(document.activeElement) : null;
  if (ev) addImagesToEvent(ev, files);
  else newEventsFromImages(files);
});

$('#grab-file').addEventListener('change', async (e) => {
  for (const f of e.target.files) state.grabImagenes.push(await prepareImage(f));
  e.target.value = '';
  syncFields();
  update();
});

$('#firma-file').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  firmaImg = await prepareImage(f);
  try { localStorage.setItem(FIRMA_KEY, JSON.stringify(firmaImg)); } catch (err) { /* se usa solo en esta sesión */ }
  syncFields();
  update();
});
$('#firma-quitar').addEventListener('click', () => {
  firmaImg = null;
  try { localStorage.removeItem(FIRMA_KEY); } catch (err) { /* nada */ }
  syncFields();
  update();
});

// "Nuevo informe" pide confirmación con un segundo clic.
const btnNuevo = $('#btn-nuevo');
let confirmTimer = null;
btnNuevo.addEventListener('click', () => {
  if (!btnNuevo.classList.contains('confirm')) {
    btnNuevo.classList.add('confirm');
    btnNuevo.textContent = '¿Borrar todo? Clic otra vez';
    confirmTimer = setTimeout(() => { btnNuevo.classList.remove('confirm'); btnNuevo.textContent = 'Nuevo informe'; }, 3500);
    return;
  }
  clearTimeout(confirmTimer);
  btnNuevo.classList.remove('confirm');
  btnNuevo.textContent = 'Nuevo informe';
  const firma = state.firmaTexto;
  state = blankState();
  state.firmaTexto = firma;
  syncFields();
  update(true);
});

$('#btn-ejemplo').addEventListener('click', () => {
  const firma = state.firmaTexto;
  state = {
    ...blankState(), firmaTexto: firma,
    ppu: 'ABCD-12', responsable: 'PÉREZ SOTO JUANA ANDREA', rut: '12345678-5', terminal: 'Santa Clara',
    fecha: '2026-09-10', genero: 'f', servicio: 'B14', sentido: 'Ida', destino: 'Mapocho',
  };
  const a = newEvent('inicio'); a.hora = '07:31';
  const b = newEvent('incidente'); b.hora = '07:47'; b.lugar = 'Avenida Einstein'; b.complemento = 'del paradero ubicado en dicha avenida';
  const c = newEvent('fin'); c.hora = '09:22';
  state.eventos = [a, b, c];
  syncFields();
  update(true);
});

$('#btn-docx').addEventListener('click', async () => {
  const btn = $('#btn-docx');
  const errs = revisar().filter((x) => x.level === 'err');
  if (errs.length && !btn.dataset.force) {
    btn.dataset.force = '1';
    btn.textContent = `Hay ${errs.length} dato(s) pendiente(s). Descargar igual`;
    setTimeout(() => { delete btn.dataset.force; btn.textContent = 'Descargar Word'; }, 4000);
    return;
  }
  delete btn.dataset.force;
  btn.disabled = true;
  btn.textContent = 'Generando…';
  try {
    const body = {
      ppu: state.ppu, responsable: state.responsable, rut: state.rut, terminal: state.terminal,
      intro: introTexto(),
      items: items().map((it) => ({ text: it.text, images: it.images })),
      firma: { image: firmaImg, lines: state.firmaTexto.split('\n') },
    };
    const res = await fetch('/api/informe/docx', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'No se pudo generar el Word.');
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `INFORME ${state.ppu || 'SIN PPU'}.docx`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    btn.textContent = 'Descargado ✓';
  } catch (err) {
    btn.textContent = 'Error, reintentar';
    $('#save-note').textContent = err.message;
  } finally {
    btn.disabled = false;
    setTimeout(() => { btn.textContent = 'Descargar Word'; }, 2500);
  }
});

// ---------- Inicio ----------

loadDraft();
syncFields();
update(true);
