// server.js
require('dotenv').config();
const express = require("express");
const bodyParser = require("body-parser");
const puppeteer = require("puppeteer");
const cron = require("node-cron");
const cors = require("cors");
const nodemailer = require('nodemailer');
const pLimit = require("p-limit@3"); // nếu lỗi, cài p-limit@3: npm install p-limit@3

const app = express();
const PORT = process.env.PORT || 3000;

app.use(bodyParser.json());
app.use(cors({
  origin: "*",
  methods: ["GET", "POST"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));

// Danh sách link theo dõi
let monitoredLinks = [];

// Nodemailer setup dùng biến môi trường
const transporter = nodemailer.createTransport({
  host: 'smtp.gmail.com',
  port: 465,
  secure: true,
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_PASS
  }
});

// Hàm gửi email cho nhiều email
async function sendEmails(coin, emails, url) {
  try {
    const mailOptions = {
      from: process.env.GMAIL_USER,
      to: emails.join(","),
      subject: `${coin} Đã kết thúc`,
      text: `${url}`
    };
    const info = await transporter.sendMail(mailOptions);
    console.log('Email sent to', emails, info.response);
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
    sendEmails('', email, url)
  } finally {
    if (page) await page.close(); // chỉ close tab
  }
  return { status, coin };
}

// API thêm link (mỗi URL có thể nhiều email)
app.post("/add-links", (req, res) => {
  const { urls } = req.body; // urls = [{url, emails: []}, ...]
  if (!urls || !Array.isArray(urls)) return res.status(400).json({ error: "urls phải là 1 mảng" });

  for (let item of urls) {
    const { url, emails } = item;
    if (!url || !emails || !Array.isArray(emails)) continue;

    const existing = monitoredLinks.find(l => l.url === url);
    if (existing) {
      existing.emails = Array.from(new Set([...existing.emails, ...emails]));
    } else {
      monitoredLinks.push({
        url,
        emails,
        status: "Chưa kiểm tra",
        lastChecked: null,
        active: true
      });
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

    const { status, coin } = await crawlLink(link.url, link.emails, link.url);
    link.status = status;
    link.coin = coin;
    link.lastChecked = new Date().toLocaleString();

    console.log(`✔ ${link.url}: ${status}`);

    if (status === "Đã kết thúc") {
      link.active = false;
      console.log(`🛑 Ngừng theo dõi: ${link.url} (emails: ${link.emails})`);
      await sendEmails(coin, link.emails, link.url);
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
