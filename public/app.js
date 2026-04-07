'use strict';

// ── Element refs ─────────────────────────────────────────────────────────
const dropZone      = document.getElementById('dropZone');
const fileInput     = document.getElementById('fileInput');
const browseBtn     = document.getElementById('browseBtn');
const fileBadge     = document.getElementById('fileBadge');
const fileBadgeText = document.getElementById('fileBadgeText');
const clearFile     = document.getElementById('clearFile');
const processBtn    = document.getElementById('processBtn');
const statusCard    = document.getElementById('statusCard');
const statusDot     = document.getElementById('statusDot');
const statusMsg     = document.getElementById('statusMsg');
const progressBar   = document.getElementById('progressBar');
const progressFill  = document.getElementById('progressFill');
const downloadBtn   = document.getElementById('downloadBtn');

// ── State ─────────────────────────────────────────────────────────────────
let selectedFile = null;
let pollTimer    = null;

// ── File handling ─────────────────────────────────────────────────────────
browseBtn.addEventListener('click', e => { e.stopPropagation(); fileInput.click(); });
dropZone.addEventListener('click',  () => { if (!selectedFile) fileInput.click(); });

fileInput.addEventListener('change', () => {
  if (fileInput.files[0]) selectFile(fileInput.files[0]);
});

dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
dropZone.addEventListener('dragleave', ()  => dropZone.classList.remove('drag-over'));
dropZone.addEventListener('drop', e => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  if (e.dataTransfer.files[0]) selectFile(e.dataTransfer.files[0]);
});

clearFile.addEventListener('click', () => {
  selectedFile = null;
  fileInput.value = '';
  dropZone.classList.remove('has-file');
  fileBadge.classList.remove('visible');
  processBtn.disabled = true;
  hideStatus();
});

function selectFile(file) {
  selectedFile = file;
  dropZone.classList.add('has-file');
  fileBadgeText.textContent = `${file.name}  (${fmtSize(file.size)})`;
  fileBadge.classList.add('visible');
  processBtn.disabled = false;
  hideStatus();
}

function fmtSize(b) {
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 ** 3)   return `${(b / 1024 ** 2).toFixed(1)} MB`;
  return `${(b / 1024 ** 3).toFixed(2)} GB`;
}

// ── Process ───────────────────────────────────────────────────────────────
processBtn.addEventListener('click', async () => {
  if (!selectedFile) return;

  const name     = document.getElementById('inp-name').value.trim();
  const number   = document.getElementById('inp-number').value.trim();
  const client   = document.getElementById('inp-client').value.trim();
  const duration = document.getElementById('inp-duration').value.trim();
  const preset   = document.querySelector('input[name="preset"]:checked').value;

  processBtn.disabled = true;
  setBtnProcessing(true);
  showStatus('processing', 'Uploading…');
  progressBar.classList.add('visible');
  progressFill.style.width = '0%';
  downloadBtn.classList.remove('visible');

  const formData = new FormData();
  formData.append('video',    selectedFile);
  formData.append('name',     name);
  formData.append('number',   number);
  formData.append('client',   client);
  formData.append('duration', duration);
  formData.append('preset',   preset);

  try {
    const res  = await fetch('/process', { method: 'POST', body: formData });
    const data = await res.json();

    if (data.error) { showStatus('error', `Error: ${data.error}`); reset(); return; }

    showStatus('processing', 'Processing…');
    pollTimer = setInterval(() => pollStatus(data.jobId, preset), 2000);

  } catch (err) {
    showStatus('error', `Upload failed: ${err.message}`);
    reset();
  }
});

async function pollStatus(jobId, preset) {
  try {
    const res  = await fetch(`/status/${jobId}`);
    const data = await res.json();

    if (data.status === 'done') {
      clearInterval(pollTimer);
      progressFill.style.width = '100%';
      setTimeout(() => {
        showStatus('done', 'Done — your file is ready.');
        progressBar.classList.remove('visible');
        downloadBtn.href = `/download/${data.outputFilename}`;
        downloadBtn.download = data.outputFilename;
        downloadBtn.classList.add('visible');
        reset();
      }, 400);

    } else if (data.status === 'error') {
      clearInterval(pollTimer);
      const msg = (data.error || 'Unknown error').split('\n').slice(0, 4).join(' | ');
      showStatus('error', `Failed: ${msg}`);
      progressBar.classList.remove('visible');
      reset();

    } else if (data.progress) {
      showStatus('processing', `Processing… ${data.progress}`);
      // Creep the bar forward based on timecode
      const current = parseFloat(progressFill.style.width) || 0;
      if (current < 90) progressFill.style.width = `${current + 1}%`;
    }
  } catch { /* network blip — keep polling */ }
}

// ── Helpers ───────────────────────────────────────────────────────────────
function showStatus(type, msg) {
  statusCard.classList.add('visible');
  statusDot.className   = `status-dot ${type}`;
  statusMsg.textContent = msg;
}

function hideStatus() {
  clearInterval(pollTimer);
  statusCard.classList.remove('visible');
  downloadBtn.classList.remove('visible');
  progressBar.classList.remove('visible');
}

function reset() {
  setBtnProcessing(false);
  processBtn.disabled = !selectedFile;
}

function setBtnProcessing(on) {
  processBtn.innerHTML = on
    ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
           style="animation:spin 1s linear infinite">
         <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83
                  M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/>
       </svg> Processing…`
    : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
         <polygon points="5 3 19 12 5 21 5 3"/>
       </svg> Process Video`;
}

const style = document.createElement('style');
style.textContent = `@keyframes spin { to { transform: rotate(360deg); } }`;
document.head.appendChild(style);
