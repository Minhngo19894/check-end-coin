// server.js
require('dotenv').config();
const express = require("express");
const bodyParser = require("body-parser");
const puppeteer = require("puppeteer");
const cron = require("node-cron");
const cors = require("cors");
const pLimit = require("p-limit");
const nodemailer = require('nodemailer');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(bodyParser.json());
app.use(cors({
  origin: "*",
  methods: ["GET", "POST"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));

// List theo dõi
let monitoredLinks = [];

// Setup Nodemailer (dùng biến môi trường)
const transporter = nodemailer.createTransport({
  host: 'smtp.gmail.com',
  port: 465,
  secure: true,
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_PASS
  }
});

// Hàm gửi email
async function sendEmail(coin, email, url) {
  try {
    const mailOptions = {
      from: process.env.GMAIL_USER,
      to: email,
      subject: coin ? `${coin} Đã kết thúc` : 'Server tràn bộ nhớ ',
      text: `${url}`
    };
    const info = await transporter.sendMail(mailOptions);
    console.log('Email sent:', info.response);
  } catch (err) {
    console.error('Lỗi gửi email:', err.message);
  }
}

// Puppeteer browser singleton
let browser;
async function getBrowser() {
  if (!browser) {
    browser = await puppeteer.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu"
      ]
    });
  }
  return browser;
}

// Crawl 1 link
async function crawlLink(url, email) {
  let status = "Không lấy được";
  let coin = "";
  let page;
  try {
    const browser = await getBrowser();
    page = await browser.newPage();

    // Chặn image/font/css để giảm load
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      if (["image", "stylesheet", "font"].includes(req.resourceType())) {
        req.abort();
      } else {
        req.continue();
      }
    });

    await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });

    status = await page.$eval('div.v2_statusTag-activity__44BHZ span', el => el.textContent.trim());
    coin = await page.$eval('div.v2_title-activity___S0uO span', el => el.textContent.trim());

  } catch (err) {
    console.error("Lỗi crawl:", err.message);
    await sendEmail('', email, url);
  } finally {
    if (page) await page.close(); // close tab
  }
  return { status, coin };
}

// API thêm link
app.post("/add-links", (req, res) => {
  const { urls, email } = req.body;
  if (!urls || !Array.isArray(urls)) return res.status(400).json({ error: "urls phải là 1 mảng" });
  if (!email) return res.status(400).json({ error: "Cần nhập email" });

  for (let url of urls) {
    if (!monitoredLinks.find(l => l.url === url)) {
      monitoredLinks.push({ url, email, status: "Chưa kiểm tra", lastChecked: null, active: true });
    }
  }

  res.json({ message: "Đã thêm link", monitoredLinks });
});

// API xoá link
app.post("/remove-link", (req, res) => {
  const { url } = req.body;
  const index = monitoredLinks.findIndex(l => l.url === url);
  if (index === -1) return res.status(404).json({ error: "Không tìm thấy link" });

  monitoredLinks.splice(index, 1);
  res.json({ message: `Đã xoá link ${url}`, monitoredLinks });
});

// API lấy status
app.get("/status", (req, res) => {
  res.json(monitoredLinks);
});

// Cron job mỗi phút, giới hạn 2 tab cùng lúc
cron.schedule("* * * * *", async () => {
  if (!monitoredLinks.length) return;
  console.log("⏳ Cron chạy...", new Date().toLocaleString());

  const limit = pLimit(2); // max 2 tab cùng lúc
  await Promise.all(monitoredLinks.map(link => limit(async () => {
    if (!link.active) return;

    const { status, coin } = await crawlLink(link.url, link.email);
    link.status = status;
    link.coin = coin;
    link.lastChecked = new Date().toLocaleString();

    console.log(`✔ ${link.url}: ${status}`);

    if (status === "Đã kết thúc") {
      link.active = false;
      console.log(`🛑 Ngừng theo dõi: ${link.url} (email: ${link.email})`);
      await sendEmail(coin, link.email, link.url);
    }
  })));
});

// Close browser khi server tắt
process.on('SIGINT', async () => {
  console.log("🛑 Server tắt, đóng browser...");
  if (browser) await browser.close();
  process.exit();
});

app.listen(PORT, () => console.log(`🚀 Server chạy tại http://localhost:${PORT}`));
