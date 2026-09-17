const cameraCards = document.querySelectorAll('.camera-card');

const results = {}; // doorKey -> { summary: {paga, evade, baja} }

function keyFor(card) {
  return card.dataset.cameraId || card.dataset.door;
}

function setCardStatus(card, message, type) {
  const statusEl = card.querySelector('[data-role="status"]');
  statusEl.textContent = message;
  statusEl.className = `status ${type}`;
  statusEl.hidden = false;
}

function updateSummary() {
  let paga = 0;
  let evade = 0;
  let baja = 0;

  Object.values(results).forEach((r) => {
    paga += r.paga || 0;
    evade += r.evade || 0;
    baja += r.baja || 0;
  });

  const totalSubieron = paga + evade;
  const tasa = totalSubieron > 0 ? Math.round((evade / totalSubieron) * 100) : 0;

  document.getElementById('total-paga').textContent = paga;
  document.getElementById('total-evade').textContent = evade;
  document.getElementById('total-baja').textContent = baja;
  document.getElementById('tasa-evasion').textContent = `${tasa}%`;
}

function labelFor(type) {
  return { paga: 'Pagó', evade: 'Evadió', baja: 'Bajó' }[type] || type;
}

cameraCards.forEach((card) => {
  const dropzone = card.querySelector('[data-role="dropzone"]');
  const videoInput = card.querySelector('[data-role="video-input"]');
  const fileLabel = card.querySelector('[data-role="file-label"]');
  const videoUrlInput = card.querySelector('[data-role="video-url"]');
  const analyzeBtn = card.querySelector('[data-role="analyze-btn"]');
  const previewBtn = card.querySelector('[data-role="preview-btn"]');
  const previewImg = card.querySelector('[data-role="preview-img"]');
  const sampleFrameImg = card.querySelector('[data-role="sample-frame"]');
  const thumbGallery = card.querySelector('[data-role="thumb-gallery"]');
  const countsEl = card.querySelector('[data-role="counts"]');
  const doorType = card.dataset.door;

  function videoFormData() {
    const videoUrl = videoUrlInput.value.trim();
    if (!videoInput.files.length && !videoUrl) return null;
    const formData = new FormData();
    if (videoInput.files.length) {
      formData.append('video', videoInput.files[0]);
    } else {
      formData.append('videoUrl', videoUrl);
    }
    return formData;
  }

  videoInput.addEventListener('change', () => {
    if (videoInput.files.length > 0) {
      fileLabel.textContent = videoInput.files[0].name;
    }
  });

  ['dragover', 'dragleave', 'drop'].forEach((eventName) => {
    dropzone.addEventListener(eventName, (e) => e.preventDefault());
  });
  dropzone.addEventListener('dragover', () => dropzone.classList.add('dragover'));
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
  dropzone.addEventListener('drop', (e) => {
    dropzone.classList.remove('dragover');
    const files = e.dataTransfer.files;
    if (files.length > 0) {
      videoInput.files = files;
      fileLabel.textContent = files[0].name;
    }
  });

  previewBtn.addEventListener('click', async () => {
    const formData = videoFormData();
    if (!formData) {
      setCardStatus(card, 'Selecciona un video o pega un enlace.', 'error');
      return;
    }
    formData.append('line', card.querySelector('[data-role="line"]').value);
    const zoneInput = card.querySelector('[data-role="zone"]');
    if (zoneInput) formData.append('zone', zoneInput.value);

    previewBtn.disabled = true;
    previewImg.hidden = true;
    setCardStatus(card, 'Generando vista previa...', 'info');

    try {
      const response = await fetch('/api/passenger-count/preview', {
        method: 'POST',
        body: formData,
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.details || data.error || 'Error desconocido al generar la vista previa.');
      }

      previewImg.src = data.image;
      previewImg.hidden = false;
      setCardStatus(card, 'Vista previa lista. Ajusta línea/zona si no calzan y vuelve a intentar.', 'success');
    } catch (err) {
      setCardStatus(card, err.message, 'error');
    } finally {
      previewBtn.disabled = false;
    }
  });

  analyzeBtn.addEventListener('click', async () => {
    const formData = videoFormData();
    if (!formData) {
      setCardStatus(card, 'Selecciona un video o pega un enlace.', 'error');
      return;
    }
    formData.append('doorType', doorType);
    formData.append('line', card.querySelector('[data-role="line"]').value);
    formData.append('vidStride', card.querySelector('[data-role="vid-stride"]').value);

    if (doorType === 'principal') {
      formData.append('zone', card.querySelector('[data-role="zone"]').value);
      formData.append('dwellFrames', card.querySelector('[data-role="dwell"]').value);
    } else {
      formData.append('boardingSide', card.querySelector('[data-role="boarding-side"]').value);
    }

    analyzeBtn.disabled = true;
    countsEl.hidden = true;
    sampleFrameImg.hidden = true;
    thumbGallery.hidden = true;
    setCardStatus(card, 'Analizando video, esto puede tardar unos minutos...', 'info');

    try {
      const response = await fetch('/api/passenger-count/analyze', {
        method: 'POST',
        body: formData,
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.details || data.error || 'Error desconocido al analizar el video.');
      }

      const key = keyFor(card);
      results[key] = data.summary;

      if (doorType === 'principal') {
        card.querySelector('[data-role="count-paga"]').textContent = data.summary.paga;
        card.querySelector('[data-role="count-evade"]').textContent = data.summary.evade;
      } else {
        card.querySelector('[data-role="count-evade"]').textContent = data.summary.evade;
        card.querySelector('[data-role="count-baja"]').textContent = data.summary.baja;
      }
      countsEl.hidden = false;

      if (data.sample_frame) {
        sampleFrameImg.src = data.sample_frame;
        sampleFrameImg.hidden = false;
      }

      thumbGallery.innerHTML = '';
      const withThumb = (data.events || []).filter((e) => e.thumbnail);
      if (withThumb.length) {
        withThumb.forEach((e) => {
          const fig = document.createElement('figure');
          fig.className = `thumb thumb-${e.type}`;
          const img = document.createElement('img');
          img.src = e.thumbnail;
          img.alt = `${labelFor(e.type)} en el segundo ${e.timestamp_s}`;
          const caption = document.createElement('figcaption');
          caption.textContent = `${labelFor(e.type)} · ${e.timestamp_s}s`;
          fig.appendChild(img);
          fig.appendChild(caption);
          thumbGallery.appendChild(fig);
        });
        thumbGallery.hidden = false;
      } else {
        thumbGallery.hidden = true;
      }

      setCardStatus(card, `Listo (${data.frames_processed} frames procesados).`, 'success');
      updateSummary();
    } catch (err) {
      setCardStatus(card, err.message, 'error');
    } finally {
      analyzeBtn.disabled = false;
    }
  });
});
