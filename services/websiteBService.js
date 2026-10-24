const db = require('../database/db');

class WebsiteBService {
  constructor() {
    this.cachedToken = null;
    this.tokenExpiry = null;
    this.cachedUser = null;
  }

  /**
   * Log into Website B and retrieve a JWT token
   */
  async authenticate(customUrl = null, customEmail = null, customPassword = null) {
    const settings = db.getSettings();
    const baseUrl = (customUrl || settings.websiteBUrl || 'http://localhost:5000').replace(/\/+$/, '');
    const loginEndpoint = settings.websiteBLoginEndpoint || '/api/auth/login';
    const email = customEmail || settings.websiteBEmail || 'foradvance685@gmail.com';
    const password = customPassword || process.env.WEBSITE_B_PASSWORD || 'admin123';

    const loginUrl = `${baseUrl}${loginEndpoint.startsWith('/') ? '' : '/'}${loginEndpoint}`;

    // Return cached token if still valid (with 60-second buffer)
    if (this.cachedToken && this.tokenExpiry && Date.now() < (this.tokenExpiry - 60000)) {
      return {
        token: this.cachedToken,
        user: this.cachedUser,
        baseUrl,
      };
    }

    const startTime = Date.now();
    try {
      const res = await fetch(loginUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
        signal: AbortSignal.timeout(15000),
      });

      const data = await res.json().catch(() => ({}));
      const latencyMs = Date.now() - startTime;

      if (!res.ok) {
        throw new Error(data.message || `Website B login failed with HTTP ${res.status}`);
      }

      if (!data.token) {
        throw new Error('Website B response did not include an authentication token.');
      }

      if (data.user && data.user.role !== 'uploader') {
        throw new Error(`User "${email}" has role "${data.user.role}", but "uploader" role is required to upload files.`);
      }

      this.cachedToken = data.token;
      this.cachedUser = data.user;
      // Tokens expire in 7d according to Website B code, cache for 6 days
      this.tokenExpiry = Date.now() + 6 * 24 * 60 * 60 * 1000;

      db.addLog('info', 'WEBSITE_B', `Authenticated successfully as ${email} (${data.user ? data.user.role : 'uploader'}) on Website B in ${latencyMs}ms`);

      return {
        token: this.cachedToken,
        user: this.cachedUser,
        baseUrl,
        latencyMs,
      };
    } catch (err) {
      this.cachedToken = null;
      this.tokenExpiry = null;
      db.addLog('error', 'WEBSITE_B', `Authentication failed on Website B (${loginUrl}): ${err.message}`);
      throw err;
    }
  }

  /**
   * Test connection to Website B
   */
  async testConnection(customUrl = null, customEmail = null, customPassword = null) {
    const settings = db.getSettings();
    const baseUrl = (customUrl || settings.websiteBUrl || 'http://localhost:5000').replace(/\/+$/, '');
    const startTime = Date.now();

    try {
      // 1. Ping the server root
      let homeReachable = false;
      let homeStatus = null;
      try {
        const pingRes = await fetch(baseUrl, { method: 'GET', signal: AbortSignal.timeout(10000) });
        homeReachable = pingRes.status >= 200 && pingRes.status < 500;
        homeStatus = pingRes.status;
      } catch (e) {
        // May still respond to API if static route differs
      }

      // 2. Test authentication
      const authResult = await this.authenticate(baseUrl, customEmail, customPassword);
      const latencyMs = Date.now() - startTime;

      // 3. Test listing files to verify token works
      const filesUrl = `${baseUrl}/api/files`;
      const filesRes = await fetch(filesUrl, {
        headers: { 'Authorization': `Bearer ${authResult.token}` },
        signal: AbortSignal.timeout(10000),
      });

      const filesData = await filesRes.json().catch(() => ({ files: [] }));
      const existingFilesCount = (filesData.files || []).length;

      db.addLog('success', 'WEBSITE_B', `Connection test to Website B passed: ${existingFilesCount} existing files verified`, {
        baseUrl,
        latencyMs,
        user: authResult.user ? authResult.user.email : 'authenticated',
      });

      return {
        success: true,
        baseUrl,
        homeStatus,
        latencyMs,
        user: authResult.user,
        existingFilesCount,
        message: `Website B is fully operational (${latencyMs}ms). Verified uploader credentials and access to ${existingFilesCount} existing PDF(s).`,
      };
    } catch (err) {
      const latencyMs = Date.now() - startTime;
      db.addLog('error', 'WEBSITE_B', `Connection test to Website B failed: ${err.message}`, { error: err.message });
      return {
        success: false,
        baseUrl,
        latencyMs,
        error: err.message,
        message: `Failed to connect to Website B: ${err.message}`,
      };
    }
  }

  /**
   * Upload a PDF buffer to Website B
   */
  async uploadPdf(pdfBuffer, fileName = 'transferred.pdf', options = {}) {
    const settings = db.getSettings();
    const baseUrl = (options.websiteBUrl || settings.websiteBUrl || 'http://localhost:5000').replace(/\/+$/, '');
    const uploadEndpoint = settings.websiteBUploadEndpoint || '/api/files/upload';
    const uploadUrl = `${baseUrl}${uploadEndpoint.startsWith('/') ? '' : '/'}${uploadEndpoint}`;
    const timeoutMs = options.timeoutMs || settings.timeoutMs || 45000;

    const startTime = Date.now();

    // 1. Get valid JWT auth token
    const auth = await this.authenticate(baseUrl, options.email, options.password);

    db.addLog('info', 'WEBSITE_B', `Uploading "${fileName}" (${pdfBuffer.length} bytes) to Website B: ${uploadUrl}`);

    // 2. Prepare FormData with binary PDF
    const blob = new Blob([pdfBuffer], { type: 'application/pdf' });
    const formData = new FormData();
    formData.append('pdf', blob, fileName);

    // 3. POST /api/files/upload with Bearer token
    const res = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${auth.token}`,
      },
      body: formData,
      signal: AbortSignal.timeout(timeoutMs),
    });

    const data = await res.json().catch(() => ({}));
    const latencyMs = Date.now() - startTime;

    if (!res.ok) {
      throw new Error(data.message || `Website B upload failed with HTTP ${res.status}`);
    }

    if (!data.files || data.files.length === 0) {
      throw new Error('Website B accepted upload but returned empty file list.');
    }

    const uploadedRecord = data.files[0];
    db.addLog('success', 'WEBSITE_B', `Successfully uploaded "${fileName}" to Website B (ID: ${uploadedRecord.id}, ${uploadedRecord.fileSize} bytes in ${latencyMs}ms)`);

    return {
      success: true,
      file: uploadedRecord,
      message: data.message,
      latencyMs,
      baseUrl,
    };
  }

  /**
   * Get all uploaded files from Website B for sync check
   */
  async getFiles(customUrl = null) {
    const settings = db.getSettings();
    const baseUrl = (customUrl || settings.websiteBUrl || 'http://localhost:5000').replace(/\/+$/, '');
    const auth = await this.authenticate(baseUrl);

    const res = await fetch(`${baseUrl}/api/files`, {
      headers: { 'Authorization': `Bearer ${auth.token}` },
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      throw new Error(`Failed to fetch files from Website B: HTTP ${res.status}`);
    }

    const data = await res.json();
    return data.files || [];
  }
}

module.exports = new WebsiteBService();
