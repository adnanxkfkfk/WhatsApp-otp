// whatsapp-otp-api/index.js

const express = require("express");
const QRCode = require("qrcode");
const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require("@whiskeysockets/baileys");
const path = require("path");
const rimraf = require("rimraf");

const app = express();

const OTP_VALIDITY = 5 * 60 * 1000;
const BLOCK_DURATION = 15 * 60 * 1000;

let sock, currentQR = "", isConnected = false;
const otpStore = new Map();
const requestLog = new Map();
const blocked = new Set();

function block(key) {
  blocked.add(key);
  setTimeout(() => blocked.delete(key), BLOCK_DURATION);
}

function logRequest(ip) {
  const now = Date.now();
  const entries = requestLog.get(ip) || [];
  const recent = entries.filter(t => now - t < 60000);
  recent.push(now);
  requestLog.set(ip, recent);
  return recent.length;
}

function storeOTP(phone, otp) {
  otpStore.set(phone, { otp, expires: Date.now() + OTP_VALIDITY });
  setTimeout(() => otpStore.delete(phone), OTP_VALIDITY);
}

// WhatsApp connection
async function startSocket() {
  const { state, saveCreds } = await useMultiFileAuthState("./auth");
  sock = makeWASocket({ auth: state, printQRInTerminal: false });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
    if (qr) currentQR = await QRCode.toDataURL(qr);
    if (connection === "close") {
      const code = (lastDisconnect?.error)?.output?.statusCode;
      isConnected = false;
      if (code === DisconnectReason.loggedOut) {
        rimraf.sync("./auth");
        currentQR = "";
        setTimeout(startSocket, 1500);
      } else startSocket();
    }
    if (connection === "open") {
      isConnected = true;
      currentQR = "";
      console.log("Connected to WhatsApp");
    }
  });
}
startSocket();

// Routes

// Show QR
app.get("/qr", async (req, res) => {
  if (isConnected) return res.send("<h3>Already connected to WhatsApp</h3>");
  if (!currentQR) return res.send("<h3>QR not ready. Try again.</h3>");
  res.send(`<img src="${currentQR}" width="300" height="300" /><p>Scan to connect</p>`);
});

// Send OTP
app.get("/otp", async (req, res) => {
  const ip = req.ip;
  const phone = req.query.phone;
  if (!phone) return res.send("Phone number is required.");

  if (blocked.has(ip)) return res.send("You are blocked. Try again later.");
  if (logRequest(ip) > 5) {
    block(ip);
    return res.send("Too many requests. Try again in a few minutes.");
  }

  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  storeOTP(phone, otp);

  const msg = `*Booking Confirmation OTP*\n\nHello,\nTo confirm your booking with *Farhan Transport Service*, please use the OTP: *${otp}*\n\nValid for 5 minutes only. Never share this code.\n\n[Verify OTP](https://fts.com/verify?phone=${phone}&otp=${otp})`;

  try {
    await sock.sendMessage(`${phone}@s.whatsapp.net`, {
      text: msg,
      buttons: [
        {
          buttonId: "verify",
          buttonText: { displayText: "Verify via Web" },
          type: 1
        }
      ],
      footer: "Farhan Transport Service",
      headerType: 1
    });
    res.send("OTP sent successfully.");
  } catch {
    res.status(500).send("Failed to send OTP.");
  }
});

// Verify OTP
app.get("/verify", (req, res) => {
  const { phone, otp } = req.query;
  if (!phone || !otp) return res.send("Phone and OTP are required.");

  const stored = otpStore.get(phone);
  if (stored && stored.otp === otp && Date.now() < stored.expires) {
    otpStore.delete(phone);
    return res.send("✅ OTP Verified successfully.");
  }
  block(phone);
  res.send("❌ Invalid or expired OTP.");
});

app.listen(3000, () => console.log("API running on http://localhost:3000"));
