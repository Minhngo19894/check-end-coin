require('dotenv').config();
const express = require("express");
const bodyParser = require("body-parser");
const puppeteer = require("puppeteer");
const cron = require("node-cron");
const cors = require("cors");


const app = express();
const PORT = 3000;
const nodemailer = require('nodemailer');
app.use(bodyParser.json());
const transporter = nodemailer.createTransport({
  host: 'smtp.gmail.com',
  port: 465,
  secure: true,
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_PASS
  }
});

async function sendEmails(coin, emails, url) {
  if (!emails || !emails.length) return;
  try {
    await transporter.sendMail({
      from: process.env.GMAIL_USER,
      to: emails.join(","),
      subject: `${coin} Đã kết thúc`,
      text: `${url}`
    });
    console.log("Email sent to", emails);
  } catch (err) {
    console.error("Email error:", err.message);
  }
}

app.use(cors({
  origin: "*",                // Cho phép tất cả domain
  methods: ["GET", "POST"],    // Cho phép method nào
  allowedHeaders: ["Content-Type", "Authorization"]
}));
// Cho phép mọi origin (kể cả file://)
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  next();
});

// Danh sách link cần theo dõi
let monitoredLinks = [];

/**
 * Crawl 1 link
 */
async function crawlLink(url) {
  let status = "Không lấy được";
  let coin = ""
  try {
    const browser = await puppeteer.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu"
      ]
    });
    const page = await browser.newPage();
    await page.setRequestInterception(true);
    page.on("request", req => {
      if (["image", "stylesheet", "font"].includes(req.resourceType())) req.abort();
      else req.continue();
    });

    await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });


    page.on("request", (req) => {
      if (["image", "stylesheet", "font"].includes(req.resourceType())) {
        req.abort();
      } else {
        req.continue();
      }
    });
    status = await page.$eval('div.v2_statusTag-activity__44BHZ span', el => el.textContent.trim());
    coin = await page.$eval('div.v2_title-activity___S0uO span', el => el.textContent.trim());
    await browser.close();
  } catch (err) {
    console.error("Lỗi crawl:", err.message);
  }
  finally { if (page) await page.close(); }
  return { status, coin };
}

/**
 * API thêm link mới + email
 */
app.post("/add-links", (req, res) => {
  const { urls } = req.body;
  if (!urls || !Array.isArray(urls)) return res.status(400).json({ error: "urls phải là mảng" });
  for (let item of urls) {
    const { url, emails } = item;
    if (!url || !emails || !Array.isArray(emails)) continue;
    const exist = monitoredLinks.find(l => l.url === url);
    if (exist) exist.emails = Array.from(new Set([...exist.emails, ...emails]));
    else monitoredLinks.push({ url, emails, status: "Chưa kiểm tra", lastChecked: null, active: true });
  }
  res.json({ message: "Đã thêm link", monitoredLinks });
});

app.post("/remove-link", async (req, res) => {
  const { url } = req.body;

  if (!url) {
    return res.status(400).json({ error: "Cần nhập url" });
  }

  const index = monitoredLinks.findIndex(l => l.url === url);
  if (index === -1) {
    return res.status(404).json({ error: "Không tìm thấy link" });
  }

  monitoredLinks.splice(index, 1);

  res.json({ message: `Đã xoá link ${url}`, monitoredLinks });
});

app.post("/add-email", (req, res) => {
  const { url, email } = req.body;
  if (!url || !email) return res.status(400).json({ error: "Cần url và email" });
  const link = monitoredLinks.find(l => l.url === url);
  if (!link) return res.status(404).json({ error: "Không tìm thấy URL" });
  if (!link.emails.includes(email)) link.emails.push(email);
  res.json({ message: `Đã thêm email ${email}`, emails: link.emails });
});

/**
 * API lấy danh sách link
 */
app.get("/status", (req, res) => {
  res.json(monitoredLinks);
});

// Cron job mỗi phút
cron.schedule("* * * * *", async () => {
  console.log("⏳ Cron chạy...");
  for (let link of monitoredLinks) {
    if (!link.active) continue; // nếu đã kết thúc thì bỏ qua

    const { status, coin } = await crawlLink(link.url);
    link.status = status;
    link.coin = coin
    link.lastChecked = new Date().toLocaleString();

    console.log(`✔ ${link.url}: ${status}`);

    if (status === "Đã kết thúc") {
      link.active = false; // không theo dõi nữa
      console.log(`🛑 Ngừng theo dõi: ${link.url} `);

      sendEmails(coin, link.emails, link.url)
    }
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Server chạy tại http://localhost:${PORT}`);
});


