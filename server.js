const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
require('dotenv').config();

const db = require('./database/db');
const websiteAService = require('./services/websiteAService');
const websiteBService = require('./services/websiteBService');
const transferService = require('./services/transferService');
const schedulerService = require('./services/schedulerService');
const { authMiddleware, JWT_SECRET } = require('./middleware/auth');

const app = express();

// Ensure storage directories exist
const TEMPLATES_DIR = path.join(__dirname, 'storage', 'source_templates');
const CACHE_DIR = path.join(__dirname, 'storage', 'output_cache');
[TEMPLATES_DIR, CACHE_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// Multer memory storage for direct file uploads
const memoryUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf' || file.originalname.toLowerCase().endsWith('.pdf')) {
      cb(null, true);
    } else {
      cb(new Error('Only PDF files are allowed.'), false);
    }
  },
});

// Multer disk storage for source templates
const templateDiskStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, TEMPLATES_DIR),
  filename: (req, file, cb) => {
    const cleanName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, `${Date.now()}_${cleanName}`);
  },
});
const templateUpload = multer({
  storage: templateDiskStorage,
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf' || file.originalname.toLowerCase().endsWith('.pdf')) {
      cb(null, true);
    } else {
      cb(new Error('Only PDF files are allowed.'), false);
    }
  },
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Static frontend
app.use(express.static(path.join(__dirname, 'public')));

// Admin credentials (from .env or secure defaults)
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin12345';
let adminPasswordHash = bcrypt.hashSync(ADMIN_PASSWORD, 10);

// --- Public Routes ---

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'Website C (PDF Transfer Hub)',
    timestamp: new Date().toISOString(),
    scheduler: schedulerService.getStatus(),
  });
});

// Admin Login
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ message: 'Username and password required.' });
  }

  const userMatches = username.trim().toLowerCase() === ADMIN_USERNAME.toLowerCase();
  const passMatches = bcrypt.compareSync(password, adminPasswordHash);

  if (!userMatches || !passMatches) {
    db.addLog('warn', 'AUTH', `Failed login attempt for username: "${username}"`);
    return res.status(401).json({ message: 'Invalid admin username or password.' });
  }

  const token = jwt.sign(
    { username: ADMIN_USERNAME, role: 'admin' },
    JWT_SECRET,
    { expiresIn: '7d' }
  );

  db.addLog('info', 'AUTH', `Admin logged in successfully: ${username}`);

  res.json({
    message: 'Admin authentication successful.',
    token,
    user: { username: ADMIN_USERNAME, role: 'admin' },
  });
});

// --- Protected Routes ---

// Me route
app.get('/api/auth/me', authMiddleware, (req, res) => {
  res.json({ admin: req.admin });
});

// Dashboard Overview / Stats
app.get('/api/dashboard/stats', authMiddleware, async (req, res) => {
  try {
    const stats = db.getStats();
    const settings = db.getSettings();
    const scheduler = schedulerService.getStatus();
    const recentTransfers = db.getTransfers(10);

    res.json({
      stats,
      settings: {
        websiteAUrl: settings.websiteAUrl,
        websiteBUrl: settings.websiteBUrl,
        websiteBEmail: settings.websiteBEmail,
        scheduleInterval: settings.scheduleInterval,
        scheduleEnabled: settings.scheduleEnabled,
        maxRetries: settings.maxRetries,
      },
      scheduler,
      recentTransfers,
    });
  } catch (err) {
    res.status(500).json({ message: 'Error retrieving dashboard stats: ' + err.message });
  }
});

// Connection Test: Website A
app.post('/api/test/website-a', authMiddleware, async (req, res) => {
  const { url, endpoint } = req.body || {};
  const result = await websiteAService.testConnection(url, endpoint);
  res.json(result);
});

// Connection Test: Website B
app.post('/api/test/website-b', authMiddleware, async (req, res) => {
  const { url, email, password } = req.body || {};
  const result = await websiteBService.testConnection(url, email, password);
  res.json(result);
});

// Full Connection Test (Both)
app.post('/api/test/all', authMiddleware, async (req, res) => {
  const [resA, resB] = await Promise.all([
    websiteAService.testConnection(),
    websiteBService.testConnection(),
  ]);
  res.json({
    websiteA: resA,
    websiteB: resB,
    allOperational: resA.success && resB.success,
  });
});

// Manual Run Now (trigger automated cycle for active templates)
app.post('/api/transfers/run-now', authMiddleware, async (req, res) => {
  try {
    const result = await schedulerService.triggerNow();
    res.json({ message: 'Transfer cycle completed.', result });
  } catch (err) {
    res.status(500).json({ message: 'Transfer cycle failed: ' + err.message });
  }
});

// Scheduler Controls
app.post('/api/scheduler/start', authMiddleware, (req, res) => {
  const { expression } = req.body || {};
  const result = schedulerService.start(expression);
  res.json(result);
});

app.post('/api/scheduler/stop', authMiddleware, (req, res) => {
  const result = schedulerService.stop();
  res.json(result);
});

// Direct Transfer: Upload PDF file directly, process on A, transfer to B
app.post('/api/transfers/manual-upload', authMiddleware, memoryUpload.single('pdf'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: 'No PDF file uploaded.' });
    }

    const force = req.body.force === 'true' || req.body.force === true;
    const result = await transferService.transferPdf(
      req.file.buffer,
      req.file.originalname,
      { force }
    );

    res.json(result);
  } catch (err) {
    res.status(500).json({ message: 'Transfer error: ' + err.message });
  }
});

// Source Templates Management
app.get('/api/templates', authMiddleware, (req, res) => {
  res.json({ templates: db.getTemplates() });
});

app.post('/api/templates/upload', authMiddleware, templateUpload.array('templates', 10), (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ message: 'No PDF files provided.' });
    }

    const saved = [];
    for (const f of req.files) {
      const tpl = db.addTemplate({
        fileName: f.originalname,
        filePath: f.path,
        fileSize: f.size,
      });
      saved.push(tpl);
      db.addLog('info', 'SYSTEM', `Added source template: "${f.originalname}" (${f.size} bytes)`);
    }

    res.status(201).json({
      message: `${saved.length} template(s) added successfully!`,
      templates: saved,
    });
  } catch (err) {
    res.status(500).json({ message: 'Error adding templates: ' + err.message });
  }
});

app.delete('/api/templates/:id', authMiddleware, (req, res) => {
  const tpl = db.findTransferById(req.params.id) || db.getTemplates().find(t => t.id === req.params.id);
  if (tpl && tpl.filePath && fs.existsSync(tpl.filePath)) {
    try { fs.unlinkSync(tpl.filePath); } catch (e) {}
  }
  const removed = db.removeTemplate(req.params.id);
  if (!removed) {
    return res.status(404).json({ message: 'Template not found.' });
  }
  db.addLog('info', 'SYSTEM', `Removed source template ID: ${req.params.id}`);
  res.json({ message: 'Template removed successfully.', template: removed });
});

app.patch('/api/templates/:id/toggle', authMiddleware, (req, res) => {
  const templates = db.getTemplates();
  const tpl = templates.find(t => t.id === req.params.id);
  if (!tpl) {
    return res.status(404).json({ message: 'Template not found.' });
  }
  const updated = db.updateTemplate(tpl.id, { enabled: !tpl.enabled });
  db.addLog('info', 'SYSTEM', `Template "${tpl.fileName}" is now ${updated.enabled ? 'enabled' : 'disabled'}`);
  res.json({ message: `Template ${updated.enabled ? 'enabled' : 'disabled'}.`, template: updated });
});

// Run and auto-advance a specific template immediately
app.post('/api/templates/:id/run', authMiddleware, async (req, res) => {
  try {
    const templates = db.getTemplates();
    const tpl = templates.find(t => t.id === req.params.id);
    if (!tpl) {
      return res.status(404).json({ message: 'Template not found.' });
    }
    if (!fs.existsSync(tpl.filePath)) {
      return res.status(404).json({ message: 'Template file missing from disk.' });
    }

    const buffer = fs.readFileSync(tpl.filePath);
    const result = await transferService.transferPdf(buffer, tpl.fileName, { force: true });

    if (result && result.status === 'success' && result.generatedResult && result.generatedResult.pdfBuffer) {
      // Overwrite the template file on disk with the fresh generated PDF
      fs.writeFileSync(tpl.filePath, result.generatedResult.pdfBuffer);
      db.updateTemplate(tpl.id, {
        fileName: result.generatedResult.filename || tpl.fileName,
        fileSize: result.generatedResult.pdfBuffer.length,
        lastProcessedDate: new Date().toISOString(),
        lastStatus: 'success',
        lastGeneratedFileName: result.generatedResult.filename,
      });
      db.addLog('success', 'TRANSFER', `🔄 Auto-advanced source template "${tpl.fileName}" -> updated to "${result.generatedResult.filename}" in-place for next cycle.`);
    }

    res.json({ message: `Template processed and advanced successfully.`, result });
  } catch (err) {
    res.status(500).json({ message: 'Error running template: ' + err.message });
  }
});

// Transfers History
app.get('/api/transfers', authMiddleware, (req, res) => {
  const limit = parseInt(req.query.limit) || 100;
  res.json({ transfers: db.getTransfers(limit) });
});

// Download cached processed PDF from Website C
app.get('/api/transfers/:id/download', authMiddleware, (req, res) => {
  const transfer = db.findTransferById(req.params.id);
  if (!transfer || !transfer.cachedFilePath) {
    return res.status(404).json({ message: 'Transfer record or cached PDF not found.' });
  }

  const filePath = path.join(CACHE_DIR, transfer.cachedFilePath);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ message: 'Cached file expired or deleted from disk.' });
  }

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(transfer.generatedFileName)}"`);
  const stream = fs.createReadStream(filePath);
  stream.pipe(res);
});

// Activity Logs
app.get('/api/logs', authMiddleware, (req, res) => {
  const limit = parseInt(req.query.limit) || 100;
  const level = req.query.level || 'all';
  res.json({ logs: db.getLogs(limit, level) });
});

app.delete('/api/logs', authMiddleware, (req, res) => {
  db.clearLogs();
  db.addLog('info', 'SYSTEM', 'Activity logs cleared by administrator.');
  res.json({ message: 'Logs cleared successfully.' });
});

// Settings Management
app.get('/api/settings', authMiddleware, (req, res) => {
  const settings = db.getSettings();
  res.json({
    settings: {
      ...settings,
      hasWebsiteBPassword: Boolean(process.env.WEBSITE_B_PASSWORD || true),
    },
  });
});

app.post('/api/settings', authMiddleware, (req, res) => {
  const {
    websiteAUrl,
    websiteAProcessEndpoint,
    websiteBUrl,
    websiteBLoginEndpoint,
    websiteBUploadEndpoint,
    websiteBEmail,
    websiteBPassword,
    scheduleInterval,
    scheduleEnabled,
    maxRetries,
    timeoutMs,
  } = req.body;

  const updates = {};
  if (websiteAUrl !== undefined) updates.websiteAUrl = websiteAUrl.trim();
  if (websiteAProcessEndpoint !== undefined) updates.websiteAProcessEndpoint = websiteAProcessEndpoint.trim();
  if (websiteBUrl !== undefined) updates.websiteBUrl = websiteBUrl.trim();
  if (websiteBLoginEndpoint !== undefined) updates.websiteBLoginEndpoint = websiteBLoginEndpoint.trim();
  if (websiteBUploadEndpoint !== undefined) updates.websiteBUploadEndpoint = websiteBUploadEndpoint.trim();
  if (websiteBEmail !== undefined) updates.websiteBEmail = websiteBEmail.trim();
  if (scheduleInterval !== undefined) updates.scheduleInterval = scheduleInterval.trim();
  if (scheduleEnabled !== undefined) updates.scheduleEnabled = Boolean(scheduleEnabled);
  if (maxRetries !== undefined) updates.maxRetries = parseInt(maxRetries) || 3;
  if (timeoutMs !== undefined) updates.timeoutMs = parseInt(timeoutMs) || 45000;

  if (websiteBPassword && websiteBPassword.trim()) {
    process.env.WEBSITE_B_PASSWORD = websiteBPassword.trim();
  }

  const updatedSettings = db.updateSettings(updates);

  // If schedule interval or enabled status changed, update running scheduler
  if (updates.scheduleInterval || updates.scheduleEnabled !== undefined) {
    if (updatedSettings.scheduleEnabled) {
      schedulerService.start(updatedSettings.scheduleInterval);
    } else {
      schedulerService.stop();
    }
  }

  db.addLog('info', 'SYSTEM', 'Automation settings updated by administrator.');
  res.json({ message: 'Settings saved successfully.', settings: updatedSettings });
});

// Fallback to index.html for SPA frontend
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start Server
const PORT = process.env.PORT || 5050;

app.listen(PORT, () => {
  console.log(`=======================================================`);
  console.log(`🚀 Website C (PDF Transfer Hub) running on http://localhost:${PORT}`);
  console.log(`📡 Website A target: ${db.getSettings().websiteAUrl}`);
  console.log(`📥 Website B target: ${db.getSettings().websiteBUrl}`);
  console.log(`⏰ Scheduler: ${db.getSettings().scheduleInterval} (Enabled: ${db.getSettings().scheduleEnabled})`);
  console.log(`=======================================================`);

  // Initialize background scheduler
  schedulerService.init();
});
