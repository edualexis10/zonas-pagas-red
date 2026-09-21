const form = document.getElementById('convert-form');
const videoInput = document.getElementById('video-input');
const dropzone = document.getElementById('dropzone');
const fileLabel = document.getElementById('file-label');
const submitBtn = document.getElementById('submit-btn');
const statusEl = document.getElementById('status');
const jobList = document.getElementById('job-list');

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

function renderJobRow(job) {
  const li = document.createElement('li');
  li.className = 'job';
  li.id = `job-${job.jobId}`;
  li.innerHTML = `
    <div class="job-header">
      <span class="job-name" title="${job.fileName}">${job.fileName}</span>
      <span class="job-state">En cola…</span>
    </div>
    <div class="progress-track"><div class="progress-fill" style="width:0%"></div></div>
  `;
  return li;
}

function pollJob(jobId) {
  const row = document.getElementById(`job-${jobId}`);
  if (!row) return;

  const stateEl = row.querySelector('.job-state');
  const fillEl = row.querySelector('.progress-fill');

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
        row.classList.add('done');
        stateEl.textContent = 'Completado';
        stateEl.classList.add('done');
        fillEl.style.width = '100%';
        const link = document.createElement('a');
        link.className = 'job-download';
        link.href = job.downloadUrl;
        link.textContent = `Descargar ${job.fileName}`;
        link.setAttribute('download', job.fileName);
        row.appendChild(link);
        checkAllDone();
      } else if (job.status === 'error') {
        clearInterval(timer);
        row.classList.add('error');
        stateEl.textContent = job.error || 'Error';
        stateEl.classList.add('error');
        checkAllDone();
      }
    } catch (err) {
      clearInterval(timer);
      stateEl.textContent = 'Error de conexión';
      stateEl.classList.add('error');
    }
  }, 800);
}

let pendingJobs = 0;
function checkAllDone() {
  pendingJobs -= 1;
  if (pendingJobs <= 0) {
    submitBtn.disabled = false;
    setStatus('Todas las conversiones terminaron.', 'success');
  }
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();

  if (selectedFiles.length === 0) {
    setStatus('Selecciona uno o varios videos primero.', 'error');
    return;
  }

  const formData = new FormData();
  selectedFiles.forEach((file) => formData.append('videos', file));
  formData.append('format', document.getElementById('format-select').value);

  submitBtn.disabled = true;
  jobList.innerHTML = '';
  setStatus(`Subiendo ${selectedFiles.length} video(s)…`, 'info');

  try {
    const response = await fetch('/api/convert', {
      method: 'POST',
      body: formData,
    });
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'Error desconocido al convertir el video.');
    }

    setStatus(`Convirtiendo ${data.jobs.length} video(s) en paralelo…`, 'info');
    pendingJobs = data.jobs.length;

    data.jobs.forEach((job) => {
      jobList.appendChild(renderJobRow(job));
      pollJob(job.jobId);
    });
  } catch (err) {
    setStatus(err.message, 'error');
    submitBtn.disabled = false;
  }
});
