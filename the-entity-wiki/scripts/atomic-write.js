const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function writeFileAtomic(filePath, data, encoding = 'utf8') {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  try {
    fs.writeFileSync(tmpPath, data, encoding);
    try {
      fs.chmodSync(tmpPath, fs.statSync(filePath).mode);
    } catch (modeError) {
      // target does not exist yet: keep default mode
    }
    const fd = fs.openSync(tmpPath, 'r');
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmpPath, filePath);
  } catch (error) {
    try {
      fs.unlinkSync(tmpPath);
    } catch (cleanupError) {
      // best effort: a stale .tmp file is harmless (gitignored by *.tmp* convention is not
      // guaranteed, so callers should keep temp dirs clean on success paths)
    }
    throw error;
  }
  return filePath;
}

function writeJsonAtomic(filePath, value, options = {}) {
  const { backup = true } = options;
  const text = `${JSON.stringify(value, null, 2)}\n`;
  if (backup && fs.existsSync(filePath)) {
    fs.copyFileSync(filePath, `${filePath}.bak`);
  }
  writeFileAtomic(filePath, text, 'utf8');
  return filePath;
}

module.exports = { writeFileAtomic, writeJsonAtomic };
