const db = require('../database/db');

class WebsiteAService {
  /**
   * Test connection to Website A
   */
  async testConnection(customUrl = null, customEndpoint = null) {
    const settings = db.getSettings();
    const baseUrl = (customUrl || settings.websiteAUrl || 'https://pdf-editorx.onrender.com').replace(/\/+$/, '');
    const endpoint = customEndpoint || settings.websiteAProcessEndpoint || '/process';
    const targetUrl = `${baseUrl}${endpoint.startsWith('/') ? '' : '/'}${endpoint}`;

    const startTime = Date.now();
    try {
      // Test GET / to see if server is awake
      const homeRes = await fetch(baseUrl, { method: 'GET', signal: AbortSignal.timeout(30000) });
      const homeStatus = homeRes.status;

      // Test process endpoint - should return 405 (Method Not Allowed) for GET or 400 for empty POST
      let processStatus = null;
      try {
        const procRes = await fetch(targetUrl, { method: 'GET', signal: AbortSignal.timeout(15000) });
        processStatus = procRes.status;
      } catch (e) {
        processStatus = 'unreachable';
      }

      const latencyMs = Date.now() - startTime;
      const isOnline = homeStatus >= 200 && homeStatus < 400;

      db.addLog('info', 'WEBSITE_A', `Connection test to Website A (${baseUrl}) result: HTTP ${homeStatus}`, {
        homeStatus,
        processStatus,
        latencyMs,
      });

      return {
        success: isOnline,
        baseUrl,
        targetUrl,
        homeStatus,
        processEndpointStatus: processStatus,
        latencyMs,
        message: isOnline 
          ? `Website A is online (${latencyMs}ms response time). Process endpoint verified.` 
          : `Website A responded with HTTP ${homeStatus}.`,
      };
    } catch (err) {
      const latencyMs = Date.now() - startTime;
      db.addLog('error', 'WEBSITE_A', `Connection test to Website A failed: ${err.message}`, { error: err.message });
      return {
        success: false,
        baseUrl,
        targetUrl,
        latencyMs,
        error: err.message,
        message: `Failed to connect to Website A: ${err.message}. If the Render instance is asleep, it may take ~30s to wake up.`,
      };
    }
  }

  /**
   * Process a PDF on Website A and download the generated result
   * @param {Buffer} pdfBuffer - Input PDF buffer
   * @param {string} fileName - Original filename
   * @returns {Promise<{success: boolean, pdfBuffer: Buffer, filename: string, fileId: string, replacements: number, pages: number, latencyMs: number}>}
   */
  async processAndDownload(pdfBuffer, fileName = 'document.pdf', options = {}) {
    const settings = db.getSettings();
    const baseUrl = (options.websiteAUrl || settings.websiteAUrl || 'https://pdf-editorx.onrender.com').replace(/\/+$/, '');
    const processEndpoint = options.processEndpoint || settings.websiteAProcessEndpoint || '/process';
    const targetUrl = `${baseUrl}${processEndpoint.startsWith('/') ? '' : '/'}${processEndpoint}`;
    const timeoutMs = options.timeoutMs || settings.timeoutMs || 45000;

    const startTime = Date.now();

    // 1. Validate PDF header magic bytes '%PDF-'
    const pdfHeader = pdfBuffer.slice(0, 5).toString('ascii');
    if (!pdfHeader.startsWith('%PDF')) {
      throw new Error(`Invalid PDF header: expected '%PDF-', got '${pdfHeader}'.`);
    }

    db.addLog('info', 'WEBSITE_A', `Submitting "${fileName}" (${pdfBuffer.length} bytes) to Website A: ${targetUrl}`);

    // 2. Prepare FormData
    const blob = new Blob([pdfBuffer], { type: 'application/pdf' });
    const formData = new FormData();
    formData.append('pdf_file', blob, fileName);

    // 3. POST /process
    const processRes = await fetch(targetUrl, {
      method: 'POST',
      body: formData,
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!processRes.ok) {
      const errText = await processRes.text().catch(() => '');
      throw new Error(`Website A process failed with HTTP ${processRes.status}: ${errText.slice(0, 200)}`);
    }

    const processData = await processRes.json();
    if (!processData.success || !processData.file_id) {
      throw new Error(`Website A returned failure: ${processData.error || 'Unknown error'}`);
    }

    db.addLog('success', 'WEBSITE_A', `Website A processed "${fileName}": file_id=${processData.file_id}, replacements=${processData.replacements}, pages=${processData.pages}`);

    // 4. Download result from GET /download/:file_id?fname=:filename
    const generatedFileName = processData.filename || fileName;
    const downloadUrl = `${baseUrl}/download/${processData.file_id}?fname=${encodeURIComponent(generatedFileName)}`;

    db.addLog('info', 'WEBSITE_A', `Downloading generated PDF from: ${downloadUrl}`);

    const downloadRes = await fetch(downloadUrl, {
      method: 'GET',
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!downloadRes.ok) {
      throw new Error(`Failed to download processed PDF from Website A: HTTP ${downloadRes.status}`);
    }

    const arrayBuffer = await downloadRes.arrayBuffer();
    const resultBuffer = Buffer.from(arrayBuffer);

    // Validate downloaded PDF
    const resultHeader = resultBuffer.slice(0, 5).toString('ascii');
    if (!resultHeader.startsWith('%PDF')) {
      throw new Error(`Downloaded file from Website A is not a valid PDF! Header: '${resultHeader}'`);
    }

    const latencyMs = Date.now() - startTime;
    db.addLog('success', 'WEBSITE_A', `Successfully retrieved generated PDF "${generatedFileName}" (${resultBuffer.length} bytes in ${latencyMs}ms)`);

    return {
      success: true,
      pdfBuffer: resultBuffer,
      filename: generatedFileName,
      fileId: processData.file_id,
      replacements: processData.replacements || 0,
      pages: processData.pages || 1,
      latencyMs,
    };
  }
}

module.exports = new WebsiteAService();
