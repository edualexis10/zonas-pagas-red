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

cameraCards.forEach((card) => {
  const dropzone = card.querySelector('[data-role="dropzone"]');
  const videoInput = card.querySelector('[data-role="video-input"]');
  const fileLabel = card.querySelector('[data-role="file-label"]');
  const analyzeBtn = card.querySelector('[data-role="analyze-btn"]');
  const countsEl = card.querySelector('[data-role="counts"]');
  const doorType = card.dataset.door;

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

  analyzeBtn.addEventListener('click', async () => {
    if (!videoInput.files.length) {
      setCardStatus(card, 'Selecciona un video primero.', 'error');
      return;
    }

    const formData = new FormData();
    formData.append('video', videoInput.files[0]);
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

      setCardStatus(card, `Listo (${data.frames_processed} frames procesados).`, 'success');
      updateSummary();
    } catch (err) {
      setCardStatus(card, err.message, 'error');
    } finally {
      analyzeBtn.disabled = false;
    }
  });
});
