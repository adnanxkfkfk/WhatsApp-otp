const crypto = require("crypto");

const PASSWORD = "adnan";
const SALT = "otp_salt";
const ITERATIONS = 1000;
const IV_LENGTH = 12; // For AES-GCM

function getKey() {
  return crypto.pbkdf2Sync(PASSWORD, SALT, ITERATIONS, 32, "sha256");
}

function encrypt(obj) {
  const iv = crypto.randomBytes(IV_LENGTH);
  const key = getKey();
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);

  const json = Buffer.from(JSON.stringify(obj));
  const encrypted = Buffer.concat([cipher.update(json), cipher.final()]);
  const tag = cipher.getAuthTag();

  const payload = Buffer.concat([iv, tag, encrypted]);
  return payload.toString("base64url");
}

function decrypt(base64url) {
  try {
    const buffer = Buffer.from(base64url, "base64url");
    const iv = buffer.slice(0, IV_LENGTH);
    const tag = buffer.slice(IV_LENGTH, IV_LENGTH + 16);
    const encrypted = buffer.slice(IV_LENGTH + 16);

    const key = getKey();
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);

    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return JSON.parse(decrypted.toString());
  } catch (err) {
    return null;
  }
}

module.exports = { encrypt, decrypt };
