const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const DB_FILE = path.join(DATA_DIR, 'hub_storage.json');

const DEFAULT_DATA = {
  transfers: [],
  templates: [],
  logs: [],
  stats: {
    totalTransferred: 0,
    totalFailed: 0,
    totalDuplicatesBlocked: 0,
    lastTransferAt: null,
    lastSuccessfulTransfer: null,
  },
  settings: {
    websiteAUrl: 'https://pdf-editorx.onrender.com',
    websiteAProcessEndpoint: '/process',
    websiteBUrl: 'https://pdf-sender-iaa4.onrender.com',
    websiteBLoginEndpoint: '/api/auth/login',
    websiteBUploadEndpoint: '/api/files/upload',
    websiteBEmail: 'foradvance685@gmail.com',
    scheduleInterval: '0 * * * *', // Every hour by default
    scheduleEnabled: true,
    maxRetries: 3,
    timeoutMs: 45000,
    retryDelayMs: 3000,
  }
};

class HubDatabase {
  constructor() {
    this.data = this.load();
  }

  load() {
    try {
      if (fs.existsSync(DB_FILE)) {
        const raw = fs.readFileSync(DB_FILE, 'utf-8');
        const parsed = JSON.parse(raw);
        return {
          ...DEFAULT_DATA,
          ...parsed,
          stats: { ...DEFAULT_DATA.stats, ...(parsed.stats || {}) },
          settings: { ...DEFAULT_DATA.settings, ...(parsed.settings || {}) },
        };
      }
    } catch (err) {
      console.error('Error loading DB file, re-initializing default state:', err);
    }
    this.saveDirect(DEFAULT_DATA);
    return JSON.parse(JSON.stringify(DEFAULT_DATA));
  }

  save() {
    this.saveDirect(this.data);
  }

  saveDirect(data) {
    const tmpFile = DB_FILE + '.tmp';
    try {
      fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2), 'utf-8');
      fs.renameSync(tmpFile, DB_FILE);
    } catch (err) {
      console.error('Failed to save DB file atomically:', err);
    }
  }

  // --- Transfers ---
  getTransfers(limit = 100) {
    return [...this.data.transfers]
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
      .slice(0, limit);
  }

  findTransferByHash(hash) {
    return this.data.transfers.find(t => t.sha256Hash === hash && t.status === 'success');
  }

  findTransferById(id) {
    return this.data.transfers.find(t => t.id === id);
  }

  addTransfer(transfer) {
    const record = {
      id: transfer.id || crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      originalFileName: transfer.originalFileName,
      generatedFileName: transfer.generatedFileName || transfer.originalFileName,
      fileSize: transfer.fileSize || 0,
      sha256Hash: transfer.sha256Hash || '',
      status: transfer.status || 'pending', // 'success', 'failed', 'duplicate_skipped'
      attempts: transfer.attempts || 1,
      latencyMs: transfer.latencyMs || 0,
      websiteAFileId: transfer.websiteAFileId || null,
      websiteBFileId: transfer.websiteBFileId || null,
      notes: transfer.notes || '',
      errorMessage: transfer.errorMessage || null,
      cachedFilePath: transfer.cachedFilePath || null,
    };

    this.data.transfers.unshift(record);
    // Keep max 1000 transfers history
    if (this.data.transfers.length > 1000) {
      this.data.transfers = this.data.transfers.slice(0, 1000);
    }

    if (record.status === 'success') {
      this.data.stats.totalTransferred++;
      this.data.stats.lastTransferAt = record.timestamp;
      this.data.stats.lastSuccessfulTransfer = record;
    } else if (record.status === 'failed') {
      this.data.stats.totalFailed++;
      this.data.stats.lastTransferAt = record.timestamp;
    } else if (record.status === 'duplicate_skipped') {
      this.data.stats.totalDuplicatesBlocked++;
    }

    this.save();
    return record;
  }

  // --- Source Templates ---
  getTemplates() {
    return this.data.templates || [];
  }

  addTemplate(tpl) {
    const record = {
      id: tpl.id || crypto.randomUUID(),
      fileName: tpl.fileName,
      filePath: tpl.filePath,
      fileSize: tpl.fileSize,
      addedDate: new Date().toISOString(),
      lastProcessedDate: null,
      enabled: tpl.enabled !== false,
      lastStatus: 'ready',
    };
    this.data.templates.unshift(record);
    this.save();
    return record;
  }

  updateTemplate(id, updates) {
    const idx = this.data.templates.findIndex(t => t.id === id);
    if (idx !== -1) {
      this.data.templates[idx] = { ...this.data.templates[idx], ...updates };
      this.save();
      return this.data.templates[idx];
    }
    return null;
  }

  removeTemplate(id) {
    const idx = this.data.templates.findIndex(t => t.id === id);
    if (idx !== -1) {
      const removed = this.data.templates.splice(idx, 1)[0];
      this.save();
      return removed;
    }
    return null;
  }

  // --- Logs ---
  addLog(level, category, message, details = null) {
    const logItem = {
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      level, // 'info', 'success', 'warn', 'error'
      category, // 'WEBSITE_A', 'WEBSITE_B', 'TRANSFER', 'SCHEDULER', 'AUTH', 'SYSTEM'
      message,
      details: details ? (typeof details === 'object' ? JSON.stringify(details) : String(details)) : null,
    };
    this.data.logs.unshift(logItem);
    // Keep max 500 logs
    if (this.data.logs.length > 500) {
      this.data.logs = this.data.logs.slice(0, 500);
    }
    this.save();
    return logItem;
  }

  getLogs(limit = 100, level = null) {
    let logs = this.data.logs;
    if (level && level !== 'all') {
      logs = logs.filter(l => l.level === level);
    }
    return logs.slice(0, limit);
  }

  clearLogs() {
    this.data.logs = [];
    this.save();
  }

  // --- Stats ---
  getStats() {
    return {
      ...this.data.stats,
      activeTemplatesCount: (this.data.templates || []).filter(t => t.enabled).length,
      totalTemplatesCount: (this.data.templates || []).length,
      totalRecordsCount: this.data.transfers.length,
    };
  }

  // --- Settings ---
  getSettings() {
    return { ...this.data.settings };
  }

  updateSettings(newSettings) {
    this.data.settings = {
      ...this.data.settings,
      ...newSettings,
    };
    this.save();
    return this.data.settings;
  }
}

module.exports = new HubDatabase();
