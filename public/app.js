const form = document.getElementById('convert-form');
const videoInput = document.getElementById('video-input');
const dropzone = document.getElementById('dropzone');
const fileLabel = document.getElementById('file-label');
const submitBtn = document.getElementById('submit-btn');
const statusEl = document.getElementById('status');
const jobList = document.getElementById('job-list');

const INITIAL_CHUNK_SIZE = 4 * 1024 * 1024; // 4 MB
const MIN_CHUNK_SIZE = 256 * 1024; // 256 KB: por debajo de esto, nos rendimos

let selectedFiles = [];

function setStatus(message, type) {
  statusEl.textContent = message;
  statusEl.className = `status ${type}`;
  statusEl.hidden = false;
}

function updateFileLabel() {
  if (selectedFiles.length === 0) {
    fileLabel.textContent = 'Arrastra uno o varios videos aquí o haz clic para elegirlos';
  } else if (selectedFiles.length === 1) {
    fileLabel.textContent = selectedFiles[0].name;
  } else {
    fileLabel.textContent = `${selectedFiles.length} videos seleccionados`;
  }
}

function setFiles(fileListLike) {
  selectedFiles = Array.from(fileListLike);
  updateFileLabel();
}

videoInput.addEventListener('change', () => setFiles(videoInput.files));

['dragover', 'dragleave', 'drop'].forEach((eventName) => {
  dropzone.addEventListener(eventName, (e) => e.preventDefault());
});

dropzone.addEventListener('dragover', () => dropzone.classList.add('dragover'));
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
dropzone.addEventListener('drop', (e) => {
  dropzone.classList.remove('dragover');
  if (e.dataTransfer.files.length > 0) {
    setFiles(e.dataTransfer.files);
  }
});

function renderJobRow(fileName) {
  const li = document.createElement('li');
  li.className = 'job';
  li.innerHTML = `
    <div class="job-header">
      <span class="job-name" title="${fileName}">${fileName}</span>
      <span class="job-state">Subiendo… 0%</span>
    </div>
    <div class="progress-track"><div class="progress-fill" style="width:0%"></div></div>
  `;
  jobList.appendChild(li);
  return {
    stateEl: li.querySelector('.job-state'),
    fillEl: li.querySelector('.progress-fill'),
    rowEl: li,
  };
}

async function postChunk(uploadId, blob, isLast) {
  const formData = new FormData();
  formData.append('uploadId', uploadId);
  formData.append('isLast', String(isLast));
  formData.append('chunk', blob);

  const response = await fetch('/api/upload/chunk', { method: 'POST', body: formData });
  const contentType = response.headers.get('content-type') || '';

  if (!contentType.includes('application/json')) {
    const err = new Error(`HTTP ${response.status}`);
    err.status = response.status;
    throw err;
  }

  const data = await response.json();
  if (!response.ok) {
    const err = new Error(data.error || `HTTP ${response.status}`);
    err.status = response.status;
    throw err;
  }
  return data;
}

function pollJob(jobId, stateEl, fillEl, rowEl) {
  const timer = setInterval(async () => {
    try {
      const res = await fetch(`/api/jobs/${jobId}`);
      const job = await res.json();

      if (job.status === 'processing') {
        stateEl.textContent = `Convirtiendo… ${job.progress}%`;
        fillEl.style.width = `${job.progress}%`;
      } else if (job.status === 'queued') {
        stateEl.textContent = 'En cola…';
      } else if (job.status === 'done') {
        clearInterval(timer);
        rowEl.classList.add('done');
        stateEl.textContent = 'Completado';
        stateEl.classList.add('done');
        fillEl.style.width = '100%';
        const link = document.createElement('a');
        link.className = 'job-download';
        link.href = job.downloadUrl;
        link.textContent = `Descargar ${job.fileName}`;
        link.setAttribute('download', job.fileName);
        rowEl.appendChild(link);
        onJobSettled();
      } else if (job.status === 'error') {
        clearInterval(timer);
        rowEl.classList.add('error');
        stateEl.textContent = job.error || 'Error';
        stateEl.classList.add('error');
        onJobSettled();
      }
    } catch (err) {
      clearInterval(timer);
      stateEl.textContent = 'Error de conexión';
      stateEl.classList.add('error');
      onJobSettled();
    }
  }, 800);
}

let pendingJobs = 0;
function onJobSettled() {
  pendingJobs -= 1;
  if (pendingJobs <= 0) {
    submitBtn.disabled = false;
    setStatus('Todas las conversiones terminaron.', 'success');
  }
}

async function processFile(file, format) {
  const { stateEl, fillEl, rowEl } = renderJobRow(file.name);

  try {
    const uploadId = await (async () => {
      const initRes = await fetch('/api/upload/init', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileName: file.name, format }),
      });
      const initData = await initRes.json();
      if (!initRes.ok) throw new Error(initData.error || 'No se pudo iniciar la subida.');
      return initData.uploadId;
    })();

    let sent = 0;
    let offset = 0;
    let jobId = null;

    while (offset < file.size) {
      const end = Math.min(offset + INITIAL_CHUNK_SIZE, file.size);
      const isLast = end >= file.size;

      await uploadChunkRange(file, uploadId, offset, end, isLast, (bytes, result) => {
        sent += bytes;
        const pct = Math.min(99, Math.round((sent / file.size) * 100));
        stateEl.textContent = `Subiendo… ${pct}%`;
        fillEl.style.width = `${pct}%`;
        if (result && result.done) {
          jobId = result.jobId;
        }
      });

      offset = end;
    }

    if (file.size === 0) {
      throw new Error('El archivo está vacío.');
    }

    stateEl.textContent = 'Procesando…';
    pollJob(jobId, stateEl, fillEl, rowEl);
  } catch (err) {
    rowEl.classList.add('error');
    stateEl.textContent = err.message || 'Error al subir el video.';
    stateEl.classList.add('error');
    onJobSettled();
  }
}

async function uploadChunkRange(file, uploadId, start, end, isLast, onProgress) {
  const size = end - start;
  try {
    const blob = file.slice(start, end);
    const result = await postChunk(uploadId, blob, isLast);
    onProgress(size, result);
  } catch (err) {
    if (size <= MIN_CHUNK_SIZE) {
      throw new Error(
        `No se pudo subir el video (${err.message}). El servidor/proxy podría estar rechazando incluso fragmentos pequeños.`
      );
    }
    const mid = start + Math.floor(size / 2);
    await uploadChunkRange(file, uploadId, start, mid, false, onProgress);
    await uploadChunkRange(file, uploadId, mid, end, isLast, onProgress);
  }
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();

  if (selectedFiles.length === 0) {
    setStatus('Selecciona uno o varios videos primero.', 'error');
    return;
  }

  const format = document.getElementById('format-select').value;

  submitBtn.disabled = true;
  jobList.innerHTML = '';
  pendingJobs = selectedFiles.length;
  setStatus(`Subiendo y convirtiendo ${selectedFiles.length} video(s)…`, 'info');

  selectedFiles.forEach((file) => {
    processFile(file, format);
  });
});
