const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('../database/db');
const websiteAService = require('./websiteAService');
const websiteBService = require('./websiteBService');

const CACHE_DIR = path.join(__dirname, '..', 'storage', 'output_cache');
if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

class TransferService {
  constructor() {
    this.isProcessing = false;
    this.currentJob = null;
  }

  /**
   * Compute SHA-256 hash of a buffer
   */
  computeHash(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex');
  }

  /**
   * Validate PDF structure and integrity
   */
  validatePdf(buffer, minSize = 100) {
    if (!buffer || buffer.length < minSize) {
      return { valid: false, reason: `File is too small (${buffer ? buffer.length : 0} bytes). Minimum is ${minSize} bytes.` };
    }
    const header = buffer.slice(0, 5).toString('ascii');
    if (!header.startsWith('%PDF')) {
      return { valid: false, reason: `Invalid PDF format. Expected header '%PDF-', got '${header}'.` };
    }
    return { valid: true };
  }

  /**
   * Helper delay for retry backoff
   */
  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Execute transfer for a single PDF buffer
   * @param {Buffer} sourcePdfBuffer 
   * @param {string} originalFileName 
   * @param {object} options { force: boolean, maxRetries: number }
   */
  async transferPdf(sourcePdfBuffer, originalFileName = 'source.pdf', options = {}) {
    const settings = db.getSettings();
    const maxRetries = options.maxRetries || settings.maxRetries || 3;
    const retryDelay = settings.retryDelayMs || 3000;
    const forceUpload = options.force === true || options.isTemplate === true;

    const startTime = Date.now();
    const sourceHash = this.computeHash(sourcePdfBuffer);

    db.addLog('info', 'TRANSFER', `Initiating transfer pipeline for "${originalFileName}" (${sourcePdfBuffer.length} bytes, SHA-256: ${sourceHash.substring(0, 12)}...)`);

    // 1. Validate Input PDF
    const validation = this.validatePdf(sourcePdfBuffer);
    if (!validation.valid) {
      const err = new Error(`Input PDF validation failed: ${validation.reason}`);
      db.addTransfer({
        originalFileName,
        fileSize: sourcePdfBuffer.length,
        sha256Hash: sourceHash,
        status: 'failed',
        errorMessage: err.message,
        latencyMs: Date.now() - startTime,
      });
      db.addLog('error', 'TRANSFER', `Transfer rejected for "${originalFileName}": ${err.message}`);
      throw err;
    }

    // 2. Duplicate Detection: Check if identical source hash was already successfully transferred
    // For rolling source templates, we ALWAYS send to Website A to advance dates & generate new chalans!
    if (!forceUpload && !options.isTemplate) {
      const existing = db.findTransferByHash(sourceHash);
      if (existing) {
        db.addLog('warn', 'TRANSFER', `Duplicate detected: identical file "${originalFileName}" already transferred on ${existing.timestamp}. Skipping upload.`);
        const skippedRecord = db.addTransfer({
          originalFileName,
          generatedFileName: existing.generatedFileName,
          fileSize: sourcePdfBuffer.length,
          sha256Hash: sourceHash,
          status: 'duplicate_skipped',
          notes: `Skipped upload: matches existing transfer ID ${existing.id}`,
          websiteBFileId: existing.websiteBFileId,
          latencyMs: Date.now() - startTime,
        });
        return {
          status: 'duplicate_skipped',
          message: `Identical file already transferred (Transfer #${existing.id.slice(0, 8)}). Duplicate prevented.`,
          record: skippedRecord,
        };
      }
    }

    // 3. Execution with Retry Mechanism
    let attempt = 0;
    let lastError = null;
    let generatedResult = null;
    let uploadResult = null;

    while (attempt < maxRetries) {
      attempt++;
      try {
        db.addLog('info', 'TRANSFER', `[Attempt ${attempt}/${maxRetries}] Step 1: Processing on Website A...`);

        // Step 1: Send to Website A and retrieve generated PDF
        generatedResult = await websiteAService.processAndDownload(sourcePdfBuffer, originalFileName, options);

        // Step 2: Validate Generated PDF
        const genValidation = this.validatePdf(generatedResult.pdfBuffer);
        if (!genValidation.valid) {
          throw new Error(`Generated PDF from Website A is invalid: ${genValidation.reason}`);
        }

        const generatedHash = this.computeHash(generatedResult.pdfBuffer);

        // Step 3: Check duplicate on generated PDF hash
        if (!forceUpload) {
          const existingGen = db.findTransferByHash(generatedHash);
          if (existingGen) {
            db.addLog('warn', 'TRANSFER', `Duplicate output PDF detected (SHA-256: ${generatedHash.substring(0, 12)}...). Skipping upload to Website B.`);
            const dupRecord = db.addTransfer({
              originalFileName,
              generatedFileName: generatedResult.filename,
              fileSize: generatedResult.pdfBuffer.length,
              sha256Hash: generatedHash,
              status: 'duplicate_skipped',
              notes: `Generated content matches existing transfer #${existingGen.id.slice(0, 8)}`,
              websiteAFileId: generatedResult.fileId,
              websiteBFileId: existingGen.websiteBFileId,
              latencyMs: Date.now() - startTime,
            });
            return {
              status: 'duplicate_skipped',
              message: `Generated output already exists on Website B. Duplicate prevented.`,
              record: dupRecord,
            };
          }
        }

        db.addLog('info', 'TRANSFER', `[Attempt ${attempt}/${maxRetries}] Step 2: Uploading to Website B...`);

        // Step 4: Upload to Website B
        uploadResult = await websiteBService.uploadPdf(
          generatedResult.pdfBuffer,
          generatedResult.filename,
          options
        );

        // Step 5: Cache generated PDF on Website C for direct admin review/download
        const cacheFileName = `${Date.now()}_${generatedResult.filename}`;
        const cachePath = path.join(CACHE_DIR, cacheFileName);
        fs.writeFileSync(cachePath, generatedResult.pdfBuffer);

        const totalLatencyMs = Date.now() - startTime;

        // Step 6: Record successful transfer in database
        const record = db.addTransfer({
          originalFileName,
          generatedFileName: generatedResult.filename,
          fileSize: generatedResult.pdfBuffer.length,
          sha256Hash: generatedHash,
          status: 'success',
          attempts: attempt,
          latencyMs: totalLatencyMs,
          websiteAFileId: generatedResult.fileId,
          websiteBFileId: uploadResult.file ? uploadResult.file.id : null,
          cachedFilePath: cacheFileName,
          notes: `Updated ${generatedResult.replacements} fields across ${generatedResult.pages} pages. Uploaded to Website B.`,
        });

        db.addLog('success', 'TRANSFER', `Transfer completed successfully for "${generatedResult.filename}" in ${totalLatencyMs}ms (Attempts: ${attempt})`, {
          transferId: record.id,
          websiteBFileId: record.websiteBFileId,
          replacements: generatedResult.replacements,
        });

        return {
          status: 'success',
          message: `Successfully transferred "${generatedResult.filename}" to Website B!`,
          record,
          generatedResult,
          uploadResult,
        };

      } catch (err) {
        lastError = err;
        db.addLog('warn', 'TRANSFER', `[Attempt ${attempt}/${maxRetries}] Failed: ${err.message}`);

        if (attempt < maxRetries) {
          const waitTime = retryDelay * Math.pow(1.5, attempt - 1);
          db.addLog('info', 'TRANSFER', `Retrying in ${Math.round(waitTime / 1000)}s...`);
          await this.delay(waitTime);
        }
      }
    }

    // All retries exhausted
    const totalLatencyMs = Date.now() - startTime;
    const failedRecord = db.addTransfer({
      originalFileName,
      generatedFileName: generatedResult ? generatedResult.filename : originalFileName,
      fileSize: sourcePdfBuffer.length,
      sha256Hash: sourceHash,
      status: 'failed',
      attempts: attempt,
      latencyMs: totalLatencyMs,
      errorMessage: lastError ? lastError.message : 'Unknown error',
    });

    db.addLog('error', 'TRANSFER', `Transfer pipeline FAILED for "${originalFileName}" after ${attempt} attempts: ${lastError ? lastError.message : 'Unknown'}`);

    throw new Error(`Transfer failed after ${attempt} attempts: ${lastError ? lastError.message : 'Unknown'}`);
  }

  /**
   * Process all active source templates through the transfer pipeline
   */
  async processAllActiveTemplates(options = {}) {
    if (this.isProcessing) {
      db.addLog('warn', 'SCHEDULER', 'A transfer cycle is already in progress. Skipping concurrent run.');
      return { skipped: true, reason: 'Job already running' };
    }

    this.isProcessing = true;
    const templates = db.getTemplates().filter(t => t.enabled);

    db.addLog('info', 'TRANSFER', `Starting automated transfer cycle for ${templates.length} active template(s)...`);

    const results = [];
    try {
      if (templates.length === 0) {
        db.addLog('info', 'TRANSFER', 'No active source templates found in Website C. Upload or enable templates in the dashboard to automate.');
        return { success: true, count: 0, results: [] };
      }

      for (const tpl of templates) {
        try {
          if (!fs.existsSync(tpl.filePath)) {
            db.addLog('error', 'TRANSFER', `Template file not found at path: ${tpl.filePath}`);
            continue;
          }

          const buffer = fs.readFileSync(tpl.filePath);
          const result = await this.transferPdf(buffer, tpl.fileName, { ...options, isTemplate: true, force: true });

          // If transfer succeeded with a newly generated PDF, update the source template in-place
          if (result && result.status === 'success' && result.generatedResult && result.generatedResult.pdfBuffer) {
            try {
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
            } catch (writeErr) {
              db.addLog('warn', 'TRANSFER', `Failed to update source template file in-place: ${writeErr.message}`);
            }
          } else {
            db.updateTemplate(tpl.id, {
              lastProcessedDate: new Date().toISOString(),
              lastStatus: result.status,
            });
          }

          results.push({ templateId: tpl.id, fileName: tpl.fileName, result });
        } catch (err) {
          db.updateTemplate(tpl.id, {
            lastProcessedDate: new Date().toISOString(),
            lastStatus: 'failed',
          });
          results.push({ templateId: tpl.id, fileName: tpl.fileName, error: err.message });
        }
      }
    } finally {
      this.isProcessing = false;
    }

    return {
      success: true,
      count: results.length,
      results,
    };
  }
}

module.exports = new TransferService();
