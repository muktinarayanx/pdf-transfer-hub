/**
 * Daily Automated PDF Transfer Script (GitHub Actions Compatible)
 * 
 * Pipeline:
 * 1. Reads current active template from ./template/active_template.pdf
 * 2. Wakes up Website A & Website B (Render sleep handling with retry loop)
 * 3. Submits PDF to Website A (processes dates and generates new chalan numbers)
 * 4. Downloads generated PDF
 * 5. Authenticates to Website B with uploader credentials
 * 6. Uploads the newly generated PDF to Website B
 * 7. Overwrites ./template/active_template.pdf with the generated file for the next day's run
 * 8. Records metadata to ./template/last_transfer.json
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Configuration from Environment Variables with secure defaults
const WEBSITE_A_URL = (process.env.WEBSITE_A_URL || 'https://pdf-editorx.onrender.com').replace(/\/+$/, '');
const WEBSITE_B_URL = (process.env.WEBSITE_B_URL || 'https://pdf-sender-iaa4.onrender.com').replace(/\/+$/, '');
const WEBSITE_B_EMAIL = process.env.WEBSITE_B_EMAIL || 'foradvance685@gmail.com';
const WEBSITE_B_PASSWORD = process.env.WEBSITE_B_PASSWORD || 'admin123';
const TEMPLATE_FILE = process.env.TEMPLATE_PATH || path.join(__dirname, '..', 'template', 'active_template.pdf');
const METADATA_FILE = path.join(__dirname, '..', 'template', 'last_transfer.json');

const delay = ms => new Promise(res => setTimeout(res, ms));

function computeHash(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * Wake up a Render server if asleep
 */
async function wakeUpServer(name, url, maxRetries = 6, waitIntervalMs = 10000) {
  console.log(`📡 Checking / waking up ${name} at ${url}...`);
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(25000) });
      if (res.status >= 200 && res.status < 500) {
        console.log(`✅ ${name} is awake (HTTP ${res.status}).`);
        return true;
      }
    } catch (err) {
      console.log(`⏳ [Attempt ${attempt}/${maxRetries}] Waiting for ${name} to wake up: ${err.message}`);
    }
    if (attempt < maxRetries) {
      await delay(waitIntervalMs);
    }
  }
  throw new Error(`Failed to wake up ${name} at ${url} after ${maxRetries} attempts.`);
}

/**
 * Process PDF on Website A and retrieve generated file
 */
async function processOnWebsiteA(pdfBuffer, originalFileName) {
  console.log(`\n=======================================================`);
  console.log(`[Step 1/3] Submitting "${originalFileName}" to Website A...`);
  console.log(`=======================================================`);

  const formData = new FormData();
  const blob = new Blob([pdfBuffer], { type: 'application/pdf' });
  formData.append('pdf_file', blob, originalFileName);

  const processUrl = `${WEBSITE_A_URL}/process`;
  const processRes = await fetch(processUrl, {
    method: 'POST',
    body: formData,
    signal: AbortSignal.timeout(90000),
  });

  if (!processRes.ok) {
    const errText = await processRes.text().catch(() => '');
    throw new Error(`Website A process endpoint failed (HTTP ${processRes.status}): ${errText}`);
  }

  const result = await processRes.json();
  if (!result.success || !result.file_id) {
    throw new Error(`Website A returned error: ${result.error || 'Unknown failure'}`);
  }

  console.log(`✓ Website A successfully generated:`);
  console.log(`  - File ID: ${result.file_id}`);
  console.log(`  - Generated Filename: ${result.filename}`);
  console.log(`  - Replacements made: ${result.replacements}`);
  console.log(`  - Pages: ${result.pages}`);

  // Download generated PDF
  const downloadUrl = `${WEBSITE_A_URL}/download/${result.file_id}?fname=${encodeURIComponent(result.filename)}`;
  console.log(`📥 Downloading generated PDF from: ${downloadUrl}`);

  const dlRes = await fetch(downloadUrl, { signal: AbortSignal.timeout(90000) });
  if (!dlRes.ok) {
    throw new Error(`Failed to download generated PDF from Website A (HTTP ${dlRes.status})`);
  }

  const arrayBuf = await dlRes.arrayBuffer();
  const generatedBuffer = Buffer.from(arrayBuf);

  const header = generatedBuffer.slice(0, 5).toString('ascii');
  if (!header.startsWith('%PDF')) {
    throw new Error(`Invalid PDF header downloaded from Website A: "${header}"`);
  }

  return {
    buffer: generatedBuffer,
    filename: result.filename,
    fileId: result.file_id,
    replacements: result.replacements,
    pages: result.pages,
  };
}

/**
 * Authenticate and Upload to Website B
 */
async function uploadToWebsiteB(pdfBuffer, fileName) {
  console.log(`\n=======================================================`);
  console.log(`[Step 2/3] Authenticating & Uploading to Website B...`);
  console.log(`=======================================================`);

  // 1. Login to Website B
  const loginUrl = `${WEBSITE_B_URL}/api/auth/login`;
  console.log(`🔑 Logging into Website B as ${WEBSITE_B_EMAIL}...`);
  const loginRes = await fetch(loginUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: WEBSITE_B_EMAIL, password: WEBSITE_B_PASSWORD }),
    signal: AbortSignal.timeout(30000),
  });

  const loginData = await loginRes.json().catch(() => ({}));
  if (!loginRes.ok || !loginData.token) {
    throw new Error(`Website B login failed (HTTP ${loginRes.status}): ${loginData.message || 'No token returned'}`);
  }

  const token = loginData.token;
  console.log(`✅ Authenticated with Website B (Role: ${loginData.user ? loginData.user.role : 'uploader'}).`);

  // 2. Upload file
  const uploadUrl = `${WEBSITE_B_URL}/api/files/upload`;
  const formData = new FormData();
  const blob = new Blob([pdfBuffer], { type: 'application/pdf' });
  formData.append('pdf', blob, fileName);

  console.log(`🚀 Uploading "${fileName}" (${pdfBuffer.length} bytes) to ${uploadUrl}...`);
  const uploadRes = await fetch(uploadUrl, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}` },
    body: formData,
    signal: AbortSignal.timeout(90000),
  });

  const uploadData = await uploadRes.json().catch(() => ({}));
  if (!uploadRes.ok) {
    throw new Error(`Website B upload failed (HTTP ${uploadRes.status}): ${uploadData.message || 'Unknown error'}`);
  }

  const uploadedFile = (uploadData.files && uploadData.files[0]) || uploadData.file;
  console.log(`✅ Successfully uploaded to Website B:`);
  console.log(`  - Record ID: ${uploadedFile ? (uploadedFile._id || uploadedFile.id) : 'verified'}`);
  console.log(`  - Size: ${pdfBuffer.length} bytes`);

  return uploadedFile;
}

/**
 * Main Daily Execution Runner
 */
async function main() {
  const startTime = Date.now();
  console.log(`=======================================================`);
  console.log(`⚡ Daily PDF Transfer Automation Started`);
  console.log(`🕒 Timestamp: ${new Date().toISOString()} (Local: ${new Date().toLocaleString()})`);
  console.log(`📁 Source Template: ${TEMPLATE_FILE}`);
  console.log(`🌐 Website A: ${WEBSITE_A_URL}`);
  console.log(`🌐 Website B: ${WEBSITE_B_URL}`);
  console.log(`=======================================================`);

  // 1. Verify template file exists
  if (!fs.existsSync(TEMPLATE_FILE)) {
    throw new Error(`Source template PDF not found at: ${TEMPLATE_FILE}`);
  }

  const sourceBuffer = fs.readFileSync(TEMPLATE_FILE);
  const sourceHash = computeHash(sourceBuffer);
  console.log(`📄 Loaded input template (${sourceBuffer.length} bytes, SHA-256: ${sourceHash.slice(0, 12)}...)`);

  // 2. Wake up both Render servers
  await wakeUpServer('Website A (Generator)', WEBSITE_A_URL);
  await wakeUpServer('Website B (Receiver)', WEBSITE_B_URL);

  // Read previous filename if metadata exists
  let previousName = 'source.pdf';
  if (fs.existsSync(METADATA_FILE)) {
    try {
      const prevMeta = JSON.parse(fs.readFileSync(METADATA_FILE, 'utf-8'));
      if (prevMeta.generatedFileName) previousName = prevMeta.generatedFileName;
    } catch (e) {}
  }

  // 3. Process on Website A
  const generated = await processOnWebsiteA(sourceBuffer, previousName);
  const generatedHash = computeHash(generated.buffer);

  // 4. Upload to Website B
  const uploadRecord = await uploadToWebsiteB(generated.buffer, generated.filename);

  // 5. Update local active template file for next day's run
  console.log(`\n=======================================================`);
  console.log(`[Step 3/3] Saving advanced template in-place for tomorrow...`);
  console.log(`=======================================================`);
  fs.writeFileSync(TEMPLATE_FILE, generated.buffer);
  console.log(`💾 Overwrote ${TEMPLATE_FILE} with "${generated.filename}" (${generated.buffer.length} bytes).`);

  // 6. Write run metadata
  const totalDuration = ((Date.now() - startTime) / 1000).toFixed(1);
  const metadata = {
    lastRunDate: new Date().toISOString(),
    previousFileName: previousName,
    generatedFileName: generated.filename,
    fileSize: generated.buffer.length,
    sha256Hash: generatedHash,
    replacements: generated.replacements,
    pages: generated.pages,
    websiteAFileId: generated.fileId,
    websiteBFileId: uploadRecord ? (uploadRecord._id || uploadRecord.id) : null,
    durationSeconds: totalDuration,
    status: 'success',
  };

  fs.writeFileSync(METADATA_FILE, JSON.stringify(metadata, null, 2), 'utf-8');
  console.log(`📝 Updated metadata in ${METADATA_FILE}`);

  // 7. Write to GitHub Actions Step Summary if available
  if (process.env.GITHUB_STEP_SUMMARY) {
    const summaryMarkdown = `
### 🚀 Daily PDF Transfer Completed Successfully!
- **Timestamp**: ${metadata.lastRunDate}
- **Previous Template**: \`${metadata.previousFileName}\`
- **New Advanced File**: \`${metadata.generatedFileName}\`
- **File Size**: ${(metadata.fileSize / 1024).toFixed(1)} KB
- **Replacements**: ${metadata.replacements} fields across ${metadata.pages} pages
- **Website B Record**: \`${metadata.websiteBFileId || 'Uploaded'}\`
- **Total Duration**: ${totalDuration}s
- **Next Run Scheduled**: Tomorrow at 11:00 PM IST (17:30 UTC)
`;
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summaryMarkdown);
  }

  console.log(`\n🎉 ALL DONE! Successfully processed and published "${generated.filename}" to Website B in ${totalDuration}s.`);
}

main().catch(err => {
  console.error(`\n❌ Pipeline Error: ${err.message}`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n### ❌ Daily Transfer Failed\n\`${err.message}\`\n`);
  }
  process.exit(1);
});
