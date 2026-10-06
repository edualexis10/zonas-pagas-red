// Informes de incidentes: lectura de capturas GPS (OCR) y exportación a Word
// con el mismo formato del informe manual (logo + "INFORME <PPU>", tabla de
// datos, viñetas con hora e imagen GPS, firma).
const path = require('path');
const fs = require('fs');
const express = require('express');
const multer = require('multer');
const {
  Document, Packer, Paragraph, TextRun, ImageRun, Table, TableRow, TableCell,
  WidthType, BorderStyle, AlignmentType, Header, LevelFormat,
  HorizontalPositionRelativeFrom, VerticalPositionRelativeFrom, TextWrappingType,
} = require('docx');

const LOGO_PATH = path.join(__dirname, 'public', 'informe', 'logo.png');
const TESS_CACHE = path.join(__dirname, '.cache', 'tesseract');

// ---------- OCR ----------

let workerPromise = null;
function getWorker() {
  if (!workerPromise) {
    fs.mkdirSync(TESS_CACHE, { recursive: true });
    const { createWorker } = require('tesseract.js');
    workerPromise = createWorker('spa', 1, { cachePath: TESS_CACHE }).catch((err) => {
      workerPromise = null;
      throw err;
    });
  }
  return workerPromise;
}

function titleCase(s) {
  return s.toLowerCase().replace(/(^|[\s-])(\p{L})/gu, (m, sep, ch) => sep + ch.toUpperCase()).trim();
}

// Extrae los datos de la ficha del bus que muestra el sistema GPS. El OCR
// confunde algunas letras (B↔8, I↔1, : ↔ espacio), por eso los patrones son
// tolerantes. Todo lo detectado se muestra al usuario para que lo confirme.
function parseGpsText(text) {
  const t = String(text || '').replace(/\r/g, '');
  const out = {};

  const fh = t.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2})\s*[:.\s]\s*(\d{2})(?:\s*[:.\s]\s*(\d{2}))?/);
  if (fh) {
    const [, d, m, y, hh, mm] = fh;
    out.fecha = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
    if (Number(hh) < 24 && Number(mm) < 60) out.hora = `${hh.padStart(2, '0')}:${mm}`;
  }

  const vel = t.match(/Velocidad[^\d\n]*(\d+(?:[.,]\d+)?)\s*K/i);
  if (vel) out.velocidad = String(Math.round(Number(vel[1].replace(',', '.'))));

  const dir = t.match(/Direcci\S*\s+(Noreste|Noroeste|Sureste|Suroeste|Norte|Sur|Este|Oeste)/i);
  if (dir) out.rumbo = titleCase(dir[1]);

  // "Ruta en consola T1024 00I (B14)": la última letra del código es el sentido.
  const ruta = t.match(/Ruta\s+en\s+\S+\s+\S?\d{3,4}\s*\d{0,2}([IilR1|])\s*\(\s*([0-9A-Za-z]{1,5})\s*\)/);
  if (ruta) {
    out.sentido = /r/i.test(ruta[1]) ? 'Regreso' : 'Ida';
    let svc = ruta[2].toUpperCase();
    if (/^8\d{2}$/.test(svc)) svc = `B${svc.slice(1)}`; // el OCR lee la "B" como "8"
    out.servicio = svc;
  }

  const desc = t.match(/Descripci\S*\s+r\S*\s+([A-ZÁÉÍÓÚÑ][A-ZÁÉÍÓÚÑ .]*?)\s+-\s+([A-ZÁÉÍÓÚÑ][A-ZÁÉÍÓÚÑ .]*)/);
  if (desc) {
    out.origen = titleCase(desc[1]);
    out.destino = titleCase(desc[2]);
    if (out.sentido === 'Regreso') [out.origen, out.destino] = [out.destino, out.origen];
  }
  return out;
}

// ---------- Word ----------

const FONT = 'Calibri';
const PX_MAX_W = 500; // ~5,2" (el área útil de la carta es ~6,7")
const PX_MAX_H = 330;

function decodeImage(img) {
  if (!img || typeof img.data !== 'string') return null;
  const m = img.data.match(/^data:image\/(png|jpe?g|gif|bmp);base64,(.+)$/);
  if (!m) return null;
  const w = Number(img.width) || 800;
  const h = Number(img.height) || 450;
  return { type: m[1] === 'jpeg' ? 'jpg' : m[1], data: Buffer.from(m[2], 'base64'), w, h };
}

function fit(w, h, maxW, maxH) {
  const k = Math.min(1, maxW / w, maxH / h);
  return { width: Math.round(w * k), height: Math.round(h * k) };
}

function imageParagraph(img, maxW = PX_MAX_W, maxH = PX_MAX_H) {
  return new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { after: 240 },
    children: [new ImageRun({ type: img.type, data: img.data, transformation: fit(img.w, img.h, maxW, maxH) })],
  });
}

const thin = { style: BorderStyle.SINGLE, size: 4, color: '000000' };
const cellBorders = { top: thin, bottom: thin, left: thin, right: thin };

function dataRow(label, value) {
  const cell = (children, width) => new TableCell({
    borders: cellBorders,
    width: { size: width, type: WidthType.DXA },
    margins: { left: 80, right: 80 },
    children: [new Paragraph({ spacing: { after: 0, line: 240 }, children })],
  });
  return new TableRow({
    children: [
      cell([new TextRun({ text: label, bold: true, underline: {}, font: FONT, size: 22 })], 1500),
      cell([new TextRun({ text: value || '', font: FONT, size: 20 })], 3200),
    ],
  });
}

async function buildDocx(input) {
  const ppu = String(input.ppu || '').trim();
  const logo = fs.existsSync(LOGO_PATH) ? fs.readFileSync(LOGO_PATH) : null;

  const headerChildren = [];
  if (logo) {
    headerChildren.push(new ImageRun({
      type: 'png',
      data: logo,
      transformation: { width: 124, height: 96 },
      floating: {
        horizontalPosition: { relative: HorizontalPositionRelativeFrom.MARGIN, offset: 66675 },
        verticalPosition: { relative: VerticalPositionRelativeFrom.LINE, offset: -450215 },
        wrap: { type: TextWrappingType.NONE },
        allowOverlap: true,
      },
    }));
  }
  headerChildren.push(new TextRun({ text: `INFORME ${ppu}`.trim(), bold: true, size: 40, font: FONT }));

  const body = [];
  if (input.intro) {
    body.push(new Paragraph({ indent: { firstLine: 708 }, children: [new TextRun({ text: input.intro, font: FONT })] }));
  }

  body.push(new Table({
    width: { size: 4700, type: WidthType.DXA },
    columnWidths: [1500, 3200],
    rows: [
      dataRow('PPU:', ppu),
      dataRow('Responsable', input.responsable),
      dataRow('Rut:', input.rut),
      dataRow('Terminal:', input.terminal),
    ],
  }));
  body.push(new Paragraph({ children: [] }));

  for (const item of Array.isArray(input.items) ? input.items : []) {
    if (!item || !String(item.text || '').trim()) continue;
    body.push(new Paragraph({
      numbering: { reference: 'vinetas', level: 0 },
      spacing: { after: 160 },
      children: [new TextRun({ text: String(item.text).trim(), font: FONT })],
    }));
    for (const raw of Array.isArray(item.images) ? item.images : []) {
      const img = decodeImage(raw);
      if (img) body.push(imageParagraph(img));
    }
  }

  const firma = input.firma || {};
  const firmaImg = decodeImage(firma.image);
  body.push(new Paragraph({ children: [] }));
  if (firmaImg) {
    body.push(imageParagraph(firmaImg, 240, 220));
  } else {
    const lines = (Array.isArray(firma.lines) ? firma.lines : []).map((l) => String(l).trim()).filter(Boolean);
    if (lines.length) {
      body.push(new Paragraph({ spacing: { before: 720, after: 0 }, alignment: AlignmentType.CENTER, children: [new TextRun({ text: '______________________________', font: FONT })] }));
      lines.forEach((line, i) => body.push(new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: 0 },
        children: [new TextRun({ text: line, font: FONT, size: 20, bold: i === 0 })],
      })));
    }
  }

  const doc = new Document({
    creator: 'Informes de incidentes',
    title: `Informe ${ppu}`,
    styles: { default: { document: { run: { font: FONT, size: 22 } } } },
    numbering: {
      config: [{
        reference: 'vinetas',
        levels: [{
          level: 0, format: LevelFormat.BULLET, text: '•', alignment: AlignmentType.LEFT,
          style: { paragraph: { indent: { left: 720, hanging: 360 } } },
        }],
      }],
    },
    sections: [{
      properties: {
        page: {
          size: { width: 12240, height: 15840 },
          margin: { top: 1418, right: 1134, bottom: 1418, left: 1134, header: 709, footer: 709 },
        },
      },
      headers: {
        default: new Header({ children: [new Paragraph({ indent: { left: logo ? 2050 : 0 }, children: headerChildren })] }),
      },
      children: body,
    }],
  });
  return Packer.toBuffer(doc);
}

function safeFileName(s) {
  return String(s || '').replace(/[^\p{L}\p{N} ._-]/gu, '').trim() || 'informe';
}

// ---------- Rutas ----------

const router = express.Router();
const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /^image\//.test(file.mimetype)),
});

router.post('/ocr', imageUpload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Envía una imagen (PNG o JPG).' });
  try {
    const worker = await getWorker();
    const { data } = await worker.recognize(req.file.buffer);
    res.json({ fields: parseGpsText(data.text), text: data.text });
  } catch (err) {
    console.error('OCR falló:', err);
    res.status(500).json({ error: 'No se pudo leer la imagen. Completa los datos a mano.' });
  }
});

router.post('/docx', express.json({ limit: '80mb' }), async (req, res) => {
  try {
    const buffer = await buildDocx(req.body || {});
    const name = `INFORME ${safeFileName(req.body && req.body.ppu)}.docx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
    res.send(buffer);
  } catch (err) {
    console.error('No se pudo generar el informe:', err);
    res.status(500).json({ error: 'No se pudo generar el documento Word.' });
  }
});

module.exports = { router, parseGpsText, buildDocx };
