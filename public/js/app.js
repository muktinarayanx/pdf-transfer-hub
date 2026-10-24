/**
 * Website C: PDF Transfer Hub — Client-side Controller
 */

// State
let token = localStorage.getItem('hub_admin_token') || '';
let currentTab = 'tabTransfers';
let statsPollInterval = null;
let logsPollInterval = null;

// API Helper
async function api(path, options = {}) {
  const headers = options.headers || {};
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  if (!(options.body instanceof FormData) && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }

  const res = await fetch(path, { ...options, headers });
  
  if (res.status === 401) {
    showLoginModal();
    throw new Error('Session expired. Please log in.');
  }

  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.message || `Request failed with HTTP ${res.status}`);
    }
    return data;
  }
  return res;
}

// Helpers
function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function formatDate(isoStr) {
  if (!isoStr) return '—';
  const d = new Date(isoStr);
  return d.toLocaleString('en-US', {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
}

function formatRelativeTime(isoStr) {
  if (!isoStr) return 'Never';
  const diff = Date.now() - new Date(isoStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function copyToClipboard(text, pillEl) {
  navigator.clipboard.writeText(text).then(() => {
    const original = pillEl.textContent;
    pillEl.textContent = 'Copied!';
    setTimeout(() => { pillEl.textContent = original; }, 1500);
  });
}

// --- Auth & Modals ---
const loginModal = document.getElementById('loginModal');
const adminLoginForm = document.getElementById('adminLoginForm');
const loginErrorMessage = document.getElementById('loginErrorMessage');
const btnLogout = document.getElementById('btnLogout');

function showLoginModal() {
  loginModal.classList.remove('hidden');
}

function hideLoginModal() {
  loginModal.classList.add('hidden');
  loginErrorMessage.style.display = 'none';
}

adminLoginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  loginErrorMessage.style.display = 'none';

  const username = document.getElementById('adminUsernameInput').value.trim();
  const password = document.getElementById('adminPasswordInput').value;

  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });

    const data = await res.json();
    if (!res.ok) {
      loginErrorMessage.textContent = data.message || 'Login failed.';
      loginErrorMessage.style.display = 'block';
      return;
    }

    token = data.token;
    localStorage.setItem('hub_admin_token', token);
    hideLoginModal();
    initDashboard();
  } catch (err) {
    loginErrorMessage.textContent = 'Network error: ' + err.message;
    loginErrorMessage.style.display = 'block';
  }
});

btnLogout.addEventListener('click', () => {
  localStorage.removeItem('hub_admin_token');
  token = '';
  showLoginModal();
});

// --- Tab Navigation & URL Hash Routing ---
const tabButtons = document.querySelectorAll('.tab-btn');
const tabPanes = document.querySelectorAll('.tab-pane');

const tabMap = {
  'transfers': 'tabTransfers',
  'templates': 'tabTemplates',
  'diagnostics': 'tabDiagnostics',
  'settings': 'tabSettings',
  'logs': 'tabLogs',
  'tabTransfers': 'tabTransfers',
  'tabTemplates': 'tabTemplates',
  'tabDiagnostics': 'tabDiagnostics',
  'tabSettings': 'tabSettings',
  'tabLogs': 'tabLogs',
};

function switchTab(tabKey, updateHash = true) {
  const targetId = tabMap[tabKey] || 'tabTransfers';
  tabButtons.forEach(b => {
    b.classList.toggle('active', b.getAttribute('data-tab') === targetId);
  });
  tabPanes.forEach(p => {
    p.classList.toggle('active', p.id === targetId);
  });
  currentTab = targetId;

  if (updateHash) {
    const hashName = Object.keys(tabMap).find(k => tabMap[k] === targetId && !k.startsWith('tab'));
    if (hashName) history.replaceState(null, '', `#${hashName}`);
  }

  if (targetId === 'tabTransfers') loadTransfers();
  if (targetId === 'tabTemplates') loadTemplates();
  if (targetId === 'tabSettings') loadSettings();
  if (targetId === 'tabLogs') loadLogs();
}

tabButtons.forEach(btn => {
  btn.addEventListener('click', () => {
    switchTab(btn.getAttribute('data-tab'));
  });
});

function handleHashChange() {
  const hash = window.location.hash.replace('#', '').trim().toLowerCase();
  if (hash && tabMap[hash]) {
    switchTab(hash, false);
  }
}
window.addEventListener('hashchange', handleHashChange);

// --- Top Metrics & Status Polling ---
async function fetchStats() {
  if (!token) return;
  try {
    const data = await api('/api/dashboard/stats');
    
    // Metrics
    document.getElementById('valTotalTransferred').textContent = data.stats.totalTransferred || 0;
    document.getElementById('valDuplicatesBlocked').textContent = data.stats.totalDuplicatesBlocked || 0;
    document.getElementById('valActiveTemplates').textContent = data.stats.activeTemplatesCount || 0;
    document.getElementById('valTemplatesSub').textContent = `${data.stats.totalTemplatesCount || 0} total templates configured`;
    document.getElementById('tabCountTemplates').textContent = data.stats.activeTemplatesCount || 0;

    const totalAttempts = (data.stats.totalTransferred || 0) + (data.stats.totalFailed || 0);
    const rate = totalAttempts > 0 ? Math.round(((data.stats.totalTransferred || 0) / totalAttempts) * 100) : 100;
    document.getElementById('valSuccessRateText').textContent = `${rate}% success rate (${data.stats.totalFailed || 0} failed)`;

    if (data.stats.lastSuccessfulTransfer) {
      document.getElementById('valLastTransferTime').textContent = formatRelativeTime(data.stats.lastSuccessfulTransfer.timestamp);
      document.getElementById('valLastTransferFile').textContent = data.stats.lastSuccessfulTransfer.generatedFileName || '—';
    } else {
      document.getElementById('valLastTransferTime').textContent = 'Never';
      document.getElementById('valLastTransferFile').textContent = '—';
    }

    // Scheduler pill
    const schText = document.getElementById('statusSchedulerText');
    const schDot = document.getElementById('dotScheduler');
    if (data.scheduler && data.scheduler.isEnabled) {
      schDot.className = 'pulse-dot online';
      let expLabel = data.scheduler.expression;
      if (expLabel === '0 * * * *') expLabel = 'Hourly';
      else if (expLabel === '*/2 * * * *') expLabel = 'Every 2m';
      else if (expLabel === '*/15 * * * *') expLabel = 'Every 15m';
      else if (expLabel === '*/30 * * * *') expLabel = 'Every 30m';
      else if (expLabel === '0 0 * * *') expLabel = 'Daily (00:00)';
      schText.textContent = expLabel || 'Active';
    } else {
      schDot.className = 'pulse-dot warning';
      schText.textContent = 'Paused';
    }

  } catch (err) {
    // handled by auth
  }
}

// Initial Connection Check for status pills
async function checkWebsiteConnections() {
  if (!token) return;
  try {
    // Website A
    api('/api/test/website-a', { method: 'POST' }).then(resA => {
      const dotA = document.getElementById('dotWebsiteA');
      const textA = document.getElementById('statusWebsiteAText');
      if (resA.success) {
        dotA.className = 'pulse-dot online';
        textA.textContent = `Online (${resA.latencyMs}ms)`;
      } else {
        dotA.className = 'pulse-dot offline';
        textA.textContent = 'Unreachable';
      }
    }).catch(() => {
      document.getElementById('dotWebsiteA').className = 'pulse-dot offline';
      document.getElementById('statusWebsiteAText').textContent = 'Error';
    });

    // Website B
    api('/api/test/website-b', { method: 'POST' }).then(resB => {
      const dotB = document.getElementById('dotWebsiteB');
      const textB = document.getElementById('statusWebsiteBText');
      if (resB.success) {
        dotB.className = 'pulse-dot online';
        textB.textContent = `Online (${resB.latencyMs}ms)`;
      } else {
        dotB.className = 'pulse-dot offline';
        textB.textContent = 'Auth/Connect Error';
      }
    }).catch(() => {
      document.getElementById('dotWebsiteB').className = 'pulse-dot offline';
      document.getElementById('statusWebsiteBText').textContent = 'Error';
    });
  } catch (e) {}
}

// --- TAB 1: Transfers & Direct Pipeline ---
const directDropZone = document.getElementById('directTransferDropZone');
const directPdfInput = document.getElementById('directPdfInput');
const pipelineProgressBox = document.getElementById('pipelineProgressBox');
const pipelineElapsedTimer = document.getElementById('pipelineElapsedTimer');
const pipelineStatusMessage = document.getElementById('pipelineStatusMessage');
const checkForceTransfer = document.getElementById('checkForceTransfer');

directDropZone.addEventListener('click', () => directPdfInput.click());
directDropZone.addEventListener('dragover', (e) => { e.preventDefault(); directDropZone.classList.add('dragover'); });
directDropZone.addEventListener('dragleave', () => directDropZone.classList.remove('dragover'));
directDropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  directDropZone.classList.remove('dragover');
  if (e.dataTransfer.files && e.dataTransfer.files[0]) {
    executeDirectTransfer(e.dataTransfer.files[0]);
  }
});
directPdfInput.addEventListener('change', () => {
  if (directPdfInput.files && directPdfInput.files[0]) {
    executeDirectTransfer(directPdfInput.files[0]);
    directPdfInput.value = '';
  }
});

async function executeDirectTransfer(file) {
  if (!file.name.toLowerCase().endsWith('.pdf')) {
    alert('Please select a valid PDF file.');
    return;
  }

  pipelineProgressBox.style.display = 'block';
  pipelineStatusMessage.textContent = `Initiating transfer for "${file.name}"...`;
  
  const stepValidate = document.getElementById('stepValidate');
  const stepA = document.getElementById('stepWebsiteA');
  const stepDedup = document.getElementById('stepDeduplicate');
  const stepB = document.getElementById('stepWebsiteB');

  [stepValidate, stepA, stepDedup, stepB].forEach(s => s.className = 'pipeline-step');

  stepValidate.classList.add('active');

  const startTime = Date.now();
  const timerInterval = setInterval(() => {
    pipelineElapsedTimer.textContent = ((Date.now() - startTime) / 1000).toFixed(1) + 's';
  }, 100);

  const formData = new FormData();
  formData.append('pdf', file);
  formData.append('force', checkForceTransfer.checked ? 'true' : 'false');

  try {
    // Step progression animation
    setTimeout(() => {
      stepValidate.classList.remove('active');
      stepValidate.classList.add('done');
      stepA.classList.add('active');
      pipelineStatusMessage.textContent = 'Processing PDF on Website A (generating shifted dates)...';
    }, 400);

    const result = await api('/api/transfers/manual-upload', {
      method: 'POST',
      body: formData,
    });

    clearInterval(timerInterval);
    pipelineElapsedTimer.textContent = ((Date.now() - startTime) / 1000).toFixed(1) + 's';

    stepA.classList.remove('active');
    stepA.classList.add('done');
    stepDedup.classList.add('done');
    stepB.classList.add('done');

    if (result.status === 'duplicate_skipped') {
      pipelineStatusMessage.innerHTML = `<span style="color: var(--warning); font-weight: 600;">⚠️ ${result.message}</span>`;
    } else {
      pipelineStatusMessage.innerHTML = `<span style="color: var(--success); font-weight: 600;">✅ ${result.message}</span>`;
    }

    fetchStats();
    loadTransfers();
  } catch (err) {
    clearInterval(timerInterval);
    pipelineStatusMessage.innerHTML = `<span style="color: var(--danger); font-weight: 600;">❌ Transfer failed: ${err.message}</span>`;
    fetchStats();
    loadTransfers();
  }
}

// Transfers Ledger
async function loadTransfers() {
  const tbody = document.getElementById('transfersTableBody');
  try {
    const data = await api('/api/transfers?limit=50');
    if (!data.transfers || data.transfers.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="8" style="text-align: center; padding: 2.5rem; color: var(--text-dim);">
            No transfers recorded yet. Drop a PDF above to run your first transfer!
          </td>
        </tr>`;
      return;
    }

    tbody.innerHTML = data.transfers.map(t => {
      let badgeClass = 'badge-pending';
      let badgeText = t.status || 'Pending';
      if (t.status === 'success') {
        badgeClass = 'badge-success';
        badgeText = 'Transferred';
      } else if (t.status === 'duplicate_skipped') {
        badgeClass = 'badge-duplicate';
        badgeText = 'Duplicate Blocked';
      } else if (t.status === 'failed') {
        badgeClass = 'badge-failed';
        badgeText = 'Failed';
      }

      const hashShort = t.sha256Hash ? t.sha256Hash.slice(0, 10) + '...' : '—';
      const downloadBtn = t.cachedFilePath ? `
        <a href="/api/transfers/${t.id}/download" class="btn btn-secondary btn-sm" title="Download cached output from Website C">
          ⬇ Download
        </a>` : '—';

      return `
        <tr>
          <td><span class="badge ${badgeClass}">${badgeText}</span></td>
          <td>
            <div class="file-name-cell">
              <span class="file-icon-pdf">📄</span>
              <span title="${t.generatedFileName}">${t.generatedFileName}</span>
            </div>
          </td>
          <td><span style="font-size: 0.8rem; color: var(--text-muted);">${t.originalFileName || '—'}</span></td>
          <td>${formatBytes(t.fileSize)}</td>
          <td>
            <span class="hash-pill" title="Click to copy full SHA-256 hash" onclick="copyToClipboard('${t.sha256Hash}', this)">
              ${hashShort}
            </span>
          </td>
          <td>${t.latencyMs ? t.latencyMs + 'ms' : '—'}</td>
          <td style="white-space: nowrap;">${formatDate(t.timestamp)}</td>
          <td>${downloadBtn}</td>
        </tr>
      `;
    }).join('');
  } catch (err) {
    tbody.innerHTML = `
      <tr>
        <td colspan="8" style="text-align: center; color: var(--danger); padding: 1.5rem;">
          Failed to load transfer history: ${err.message}
        </td>
      </tr>`;
  }
}

document.getElementById('btnRefreshTransfers').addEventListener('click', loadTransfers);

// Quick Run Now Header Button
document.getElementById('btnQuickRunNow').addEventListener('click', async () => {
  const btn = document.getElementById('btnQuickRunNow');
  btn.disabled = true;
  btn.querySelector('span').textContent = 'Running...';
  try {
    const res = await api('/api/transfers/run-now', { method: 'POST' });
    alert(`Transfer cycle executed!\nProcessed: ${res.result ? res.result.count : 0} template(s).`);
    fetchStats();
    loadTransfers();
    loadLogs();
  } catch (err) {
    alert('Run Now failed: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.querySelector('span').textContent = 'Run Now';
  }
});

// --- TAB 2: Source Templates Queue ---
const templateDropZone = document.getElementById('templateDropZone');
const templateFileInput = document.getElementById('templateFileInput');
const btnUploadTemplateTrigger = document.getElementById('btnUploadTemplateTrigger');

btnUploadTemplateTrigger.addEventListener('click', () => templateFileInput.click());
templateDropZone.addEventListener('click', () => templateFileInput.click());
templateDropZone.addEventListener('dragover', (e) => { e.preventDefault(); templateDropZone.classList.add('dragover'); });
templateDropZone.addEventListener('dragleave', () => templateDropZone.classList.remove('dragover'));
templateDropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  templateDropZone.classList.remove('dragover');
  if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
    uploadSourceTemplates(e.dataTransfer.files);
  }
});

templateFileInput.addEventListener('change', () => {
  if (templateFileInput.files && templateFileInput.files.length > 0) {
    uploadSourceTemplates(templateFileInput.files);
    templateFileInput.value = '';
  }
});

async function uploadSourceTemplates(files) {
  const formData = new FormData();
  let count = 0;
  for (const f of files) {
    if (f.name.toLowerCase().endsWith('.pdf')) {
      formData.append('templates', f);
      count++;
    }
  }

  if (count === 0) {
    alert('Please select at least one PDF file.');
    return;
  }

  try {
    await api('/api/templates/upload', {
      method: 'POST',
      body: formData,
    });
    loadTemplates();
    fetchStats();
  } catch (err) {
    alert('Upload templates failed: ' + err.message);
  }
}

async function loadTemplates() {
  const tbody = document.getElementById('templatesTableBody');
  try {
    const data = await api('/api/templates');
    if (!data.templates || data.templates.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="6" style="text-align: center; padding: 2rem; color: var(--text-dim);">
            No source templates in queue. Upload PDF templates above to schedule automated transfers!
          </td>
        </tr>`;
      return;
    }

    tbody.innerHTML = data.templates.map(t => {
      let statusBadge = `<span class="badge ${t.enabled ? 'badge-success' : 'badge-pending'}">${t.enabled ? 'Active' : 'Disabled'}</span>`;
      let lastRunBadge = '';
      if (t.lastStatus === 'success') {
        lastRunBadge = `<span class="badge badge-success" style="font-size: 0.72rem; padding: 0.15rem 0.5rem; display: inline-block;">✓ Processed & Advanced</span>`;
      } else if (t.lastStatus === 'failed') {
        lastRunBadge = `<span class="badge badge-failed" style="font-size: 0.72rem; padding: 0.15rem 0.5rem; display: inline-block;">✗ Failed</span>`;
      } else if (t.lastStatus === 'duplicate_skipped') {
        lastRunBadge = `<span class="badge badge-duplicate" style="font-size: 0.72rem; padding: 0.15rem 0.5rem; display: inline-block;">Duplicate Skipped</span>`;
      } else {
        lastRunBadge = `<span class="badge badge-pending" style="font-size: 0.72rem; padding: 0.15rem 0.5rem; display: inline-block;">Ready</span>`;
      }

      return `
      <tr>
        <td>${statusBadge}</td>
        <td>
          <div class="file-name-cell">
            <span class="file-icon-pdf">📄</span>
            <strong style="color: #f8fafc; font-size: 0.95rem;">${t.fileName}</strong>
          </div>
        </td>
        <td>${formatBytes(t.fileSize)}</td>
        <td>${formatDate(t.addedDate)}</td>
        <td>
          <div>${t.lastProcessedDate ? formatDate(t.lastProcessedDate) : 'Never'}</div>
          <div style="margin-top: 0.3rem;">${lastRunBadge}</div>
        </td>
        <td>
          <div style="display: flex; gap: 0.4rem;">
            <button class="btn btn-primary btn-sm" onclick="runSingleTemplate('${t.id}')" title="Process through Website A, upload to Website B, and advance template">
              ⚡ Run & Advance
            </button>
            <button class="btn btn-secondary btn-sm" onclick="toggleTemplate('${t.id}')">
              ${t.enabled ? 'Pause' : 'Enable'}
            </button>
            <button class="btn btn-danger btn-sm" onclick="deleteTemplate('${t.id}')">
              Delete
            </button>
          </div>
        </td>
      </tr>
    `;
    }).join('');
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="6" style="color: var(--danger);">Failed to load templates: ${err.message}</td></tr>`;
  }
}

window.toggleTemplate = async (id) => {
  try {
    await api(`/api/templates/${id}/toggle`, { method: 'PATCH' });
    loadTemplates();
    fetchStats();
  } catch (err) {
    alert('Failed to toggle template: ' + err.message);
  }
};

window.deleteTemplate = async (id) => {
  if (!confirm('Are you sure you want to remove this template from the queue?')) return;
  try {
    await api(`/api/templates/${id}`, { method: 'DELETE' });
    loadTemplates();
    fetchStats();
  } catch (err) {
    alert('Failed to delete template: ' + err.message);
  }
};

window.runSingleTemplate = async (id) => {
  try {
    const res = await api(`/api/templates/${id}/run`, { method: 'POST' });
    const genName = res.result && res.result.generatedResult ? res.result.generatedResult.filename : 'new file';
    alert(`Success! Processed on Website A, uploaded to Website B, and advanced source template to "${genName}"!`);
    loadTemplates();
    fetchStats();
    loadTransfers();
    loadLogs();
  } catch (err) {
    alert('Failed to run template: ' + err.message);
  }
};

// --- TAB 3: Diagnostics & Tests ---
const btnTestA = document.getElementById('btnTestA');
const btnTestB = document.getElementById('btnTestB');
const btnRunFullDiagnostic = document.getElementById('btnRunFullDiagnostic');
const btnTestConnections = document.getElementById('btnTestConnections');

btnTestA.addEventListener('click', async () => {
  btnTestA.disabled = true;
  btnTestA.querySelector('span').textContent = 'Testing Website A...';
  const box = document.getElementById('diagResultBoxA');
  const badge = document.getElementById('diagStatusBadgeA');

  box.textContent = 'Connecting to Website A (may take 10-30s if waking up Render)...';
  try {
    const res = await api('/api/test/website-a', { method: 'POST' });
    if (res.success) {
      badge.className = 'badge badge-success';
      badge.textContent = 'Online';
      box.innerHTML = `<span style="color: var(--success); font-weight: 600;">✓ ${res.message}</span><br>Target: ${res.targetUrl}<br>Latency: ${res.latencyMs}ms`;
    } else {
      badge.className = 'badge badge-failed';
      badge.textContent = 'Failed';
      box.innerHTML = `<span style="color: var(--danger); font-weight: 600;">✗ ${res.message}</span>`;
    }
    checkWebsiteConnections();
  } catch (err) {
    badge.className = 'badge badge-failed';
    badge.textContent = 'Error';
    box.textContent = 'Error: ' + err.message;
  } finally {
    btnTestA.disabled = false;
    btnTestA.querySelector('span').textContent = 'Test Website A Connection';
  }
});

btnTestB.addEventListener('click', async () => {
  btnTestB.disabled = true;
  btnTestB.querySelector('span').textContent = 'Testing Website B...';
  const box = document.getElementById('diagResultBoxB');
  const badge = document.getElementById('diagStatusBadgeB');

  box.textContent = 'Connecting to Website B and testing authentication...';
  try {
    const res = await api('/api/test/website-b', { method: 'POST' });
    if (res.success) {
      badge.className = 'badge badge-success';
      badge.textContent = 'Verified';
      box.innerHTML = `<span style="color: var(--success); font-weight: 600;">✓ ${res.message}</span><br>User: ${res.user ? res.user.email : 'uploader'}<br>Latency: ${res.latencyMs}ms`;
    } else {
      badge.className = 'badge badge-failed';
      badge.textContent = 'Failed';
      box.innerHTML = `<span style="color: var(--danger); font-weight: 600;">✗ ${res.message}</span>`;
    }
    checkWebsiteConnections();
  } catch (err) {
    badge.className = 'badge badge-failed';
    badge.textContent = 'Error';
    box.textContent = 'Error: ' + err.message;
  } finally {
    btnTestB.disabled = false;
    btnTestB.querySelector('span').textContent = 'Test Website B Connection';
  }
});

btnRunFullDiagnostic.addEventListener('click', async () => {
  btnRunFullDiagnostic.disabled = true;
  const out = document.getElementById('fullDiagnosticOutput');
  out.innerHTML = `[1/3] Probing Website A and Website B endpoints simultaneously...<br>`;

  try {
    const res = await api('/api/test/all', { method: 'POST' });
    let html = '';
    html += `Website A Status: ${res.websiteA.success ? '✅ ONLINE (' + res.websiteA.latencyMs + 'ms)' : '❌ ERROR: ' + res.websiteA.message}<br>`;
    html += `Website B Status: ${res.websiteB.success ? '✅ ONLINE & AUTHENTICATED (' + res.websiteB.latencyMs + 'ms)' : '❌ ERROR: ' + res.websiteB.message}<br>`;
    
    if (res.allOperational) {
      html += `<br><strong style="color: var(--success);">🎉 COMPLETE PIPELINE OPERATIONAL: Both Website A (Generator) and Website B (Receiver) are connected and ready for automated transfers!</strong>`;
    } else {
      html += `<br><strong style="color: var(--warning);">⚠️ Action required: Check the endpoint or credentials above.</strong>`;
    }
    out.innerHTML = html;
    checkWebsiteConnections();
  } catch (err) {
    out.innerHTML += `<span style="color: var(--danger);">Failed to execute diagnostics: ${err.message}</span>`;
  } finally {
    btnRunFullDiagnostic.disabled = false;
  }
});

btnTestConnections.addEventListener('click', () => {
  document.getElementById('tabBtnDiagnostics').click();
  btnRunFullDiagnostic.click();
});

// --- TAB 4: Settings & Configuration ---
async function loadSettings() {
  try {
    const data = await api('/api/settings');
    const s = data.settings;
    document.getElementById('settingWebsiteAUrl').value = s.websiteAUrl || '';
    document.getElementById('settingWebsiteAProcessEndpoint').value = s.websiteAProcessEndpoint || '/process';
    document.getElementById('settingWebsiteBUrl').value = s.websiteBUrl || '';
    document.getElementById('settingWebsiteBEmail').value = s.websiteBEmail || '';
    document.getElementById('settingScheduleInterval').value = s.scheduleInterval || '0 * * * *';
    document.getElementById('settingScheduleEnabled').checked = s.scheduleEnabled !== false;
    document.getElementById('settingMaxRetries').value = s.maxRetries || 3;
    document.getElementById('settingTimeoutMs').value = s.timeoutMs || 45000;
  } catch (err) {
    console.error('Failed to load settings:', err);
  }
}

document.querySelectorAll('.preset-chip').forEach(chip => {
  chip.addEventListener('click', () => {
    document.getElementById('settingScheduleInterval').value = chip.dataset.cron;
  });
});

document.getElementById('btnSaveSettings').addEventListener('click', async () => {
  const btn = document.getElementById('btnSaveSettings');
  btn.disabled = true;

  const payload = {
    websiteAUrl: document.getElementById('settingWebsiteAUrl').value.trim(),
    websiteAProcessEndpoint: document.getElementById('settingWebsiteAProcessEndpoint').value.trim(),
    websiteBUrl: document.getElementById('settingWebsiteBUrl').value.trim(),
    websiteBEmail: document.getElementById('settingWebsiteBEmail').value.trim(),
    scheduleInterval: document.getElementById('settingScheduleInterval').value.trim(),
    scheduleEnabled: document.getElementById('settingScheduleEnabled').checked,
    maxRetries: parseInt(document.getElementById('settingMaxRetries').value) || 3,
    timeoutMs: parseInt(document.getElementById('settingTimeoutMs').value) || 45000,
  };

  const pass = document.getElementById('settingWebsiteBPassword').value;
  if (pass && pass.trim()) {
    payload.websiteBPassword = pass.trim();
  }

  try {
    const res = await api('/api/settings', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    alert('Settings saved successfully!');
    document.getElementById('settingWebsiteBPassword').value = '';
    fetchStats();
    checkWebsiteConnections();
  } catch (err) {
    alert('Failed to save settings: ' + err.message);
  } finally {
    btn.disabled = false;
  }
});

document.getElementById('btnStartScheduler').addEventListener('click', async () => {
  try {
    await api('/api/scheduler/start', {
      method: 'POST',
      body: JSON.stringify({ expression: document.getElementById('settingScheduleInterval').value }),
    });
    alert('Background scheduler started!');
    fetchStats();
  } catch (err) {
    alert('Start scheduler error: ' + err.message);
  }
});

document.getElementById('btnStopScheduler').addEventListener('click', async () => {
  try {
    await api('/api/scheduler/stop', { method: 'POST' });
    alert('Background scheduler paused!');
    fetchStats();
  } catch (err) {
    alert('Stop scheduler error: ' + err.message);
  }
});

// --- TAB 5: Activity Logs ---
const terminalBody = document.getElementById('terminalLogsContainer');
const logLevelFilter = document.getElementById('logLevelFilter');

logLevelFilter.addEventListener('change', loadLogs);
document.getElementById('btnRefreshLogs').addEventListener('click', loadLogs);
document.getElementById('btnClearLogs').addEventListener('click', async () => {
  if (!confirm('Clear all server logs?')) return;
  try {
    await api('/api/logs', { method: 'DELETE' });
    loadLogs();
  } catch (err) {
    alert('Failed to clear logs: ' + err.message);
  }
});

async function loadLogs() {
  if (!token) return;
  try {
    const level = logLevelFilter.value;
    const data = await api(`/api/logs?limit=150&level=${level}`);
    if (!data.logs || data.logs.length === 0) {
      terminalBody.innerHTML = `<div class="log-line"><span class="log-msg" style="color: var(--text-dim);">No logs recorded.</span></div>`;
      return;
    }

    terminalBody.innerHTML = data.logs.map(l => {
      const timeStr = new Date(l.timestamp).toLocaleTimeString();
      return `
        <div class="log-line ${l.level}">
          <span class="log-time">[${timeStr}]</span>
          <span class="log-cat ${l.category}">${l.category}</span>
          <span class="log-msg">${escapeHtml(l.message)}</span>
        </div>
      `;
    }).join('');
  } catch (err) {
    // handled
  }
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// --- Init Application ---
function initDashboard() {
  handleHashChange();
  fetchStats();
  checkWebsiteConnections();
  loadTransfers();
  loadTemplates();
  loadSettings();
  loadLogs();

  // Periodic polling every 4 seconds to keep all views automatically in sync
  if (statsPollInterval) clearInterval(statsPollInterval);
  statsPollInterval = setInterval(() => {
    fetchStats();
    if (currentTab === 'tabTransfers') loadTransfers();
    if (currentTab === 'tabTemplates') loadTemplates();
    if (currentTab === 'tabLogs') loadLogs();
  }, 4000);
}

// Check initial auth state on startup
(async function start() {
  if (!token) {
    showLoginModal();
  } else {
    try {
      await api('/api/auth/me');
      hideLoginModal();
      initDashboard();
    } catch (e) {
      showLoginModal();
    }
  }
})();
