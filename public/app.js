const form = document.getElementById('convert-form');
const videoInput = document.getElementById('video-input');
const dropzone = document.getElementById('dropzone');
const fileLabel = document.getElementById('file-label');
const submitBtn = document.getElementById('submit-btn');
const statusEl = document.getElementById('status');
const downloadLink = document.getElementById('download-link');

function setStatus(message, type) {
  statusEl.textContent = message;
  statusEl.className = `status ${type}`;
  statusEl.hidden = false;
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

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  downloadLink.hidden = true;

  if (!videoInput.files.length) {
    setStatus('Selecciona un video primero.', 'error');
    return;
  }

  const formData = new FormData();
  formData.append('video', videoInput.files[0]);
  formData.append('format', document.getElementById('format-select').value);

  submitBtn.disabled = true;
  setStatus('Convirtiendo video, esto puede tardar unos momentos...', 'info');

  try {
    const response = await fetch('/api/convert', {
      method: 'POST',
      body: formData,
    });
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'Error desconocido al convertir el video.');
    }

    setStatus('¡Conversión completada!', 'success');
    downloadLink.href = data.downloadUrl;
    downloadLink.textContent = `Descargar ${data.fileName}`;
    downloadLink.hidden = false;
  } catch (err) {
    setStatus(err.message, 'error');
  } finally {
    submitBtn.disabled = false;
  }
});
