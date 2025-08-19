const express = require("express");
const bodyParser = require("body-parser");
const puppeteer = require("puppeteer");
const cron = require("node-cron");
const cors = require("cors");


const app = express();
const PORT = 3000;
const nodemailer = require('nodemailer');
app.use(bodyParser.json());
const sendEmail = async (url, email) => {
  // Cấu hình nodemailer
  var transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: {
      user: 'sephora19894@gmail.com',
      pass: 'dxdy odzr pxhb azjk'
    }
  }); 


  var mailOptions = {
    from: 'sephora19894@gmail.com',
    to: [email],
    subject: `${url} Đã kết thúc`,
    text: `${url} Đã kết thúc`
  };

  transporter.sendMail(mailOptions, function (error, info) {
    if (error) {
      console.log(error);
    } else {
      console.log('Email sent: ' + info.response);
      lastSendTime = new Date();
      lastString = str
    }
  });
};

app.use(cors());
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
  try {
    const browser = await puppeteer.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });

    if (await page.$("div.status-tag_inProgress-activity__6dWxx")) {
      status = "Đang diễn ra";
    } else if (await page.$("div.status-tag_ended-activity__UHnet")) {
      status = "Đã kết thúc";
    } else {
      status = "Không rõ";
    }

    await browser.close();
  } catch (err) {
    console.error("Lỗi crawl:", err.message);
  }
  return status;
}

/**
 * API thêm link mới + email
 */
app.post("/add-links", async (req, res) => {
  const { urls, email } = req.body;
  if (!urls || !Array.isArray(urls)) {
    return res.status(400).json({ error: "urls phải là 1 mảng" });
  }
  if (!email) {
    return res.status(400).json({ error: "Cần nhập email" });
  }

  // Thêm link mới chưa có
  for (let url of urls) {
    if (!monitoredLinks.find(l => l.url === url)) {
      monitoredLinks.push({
        url,
        email,
        status: "Chưa kiểm tra",
        lastChecked: null,
        active: true
      });
    }
  }

  res.json({ message: "Đã thêm link", monitoredLinks });
});

/**
 * API lấy danh sách link
 */
app.get("/status", (req, res) => {
  res.json(monitoredLinks);
});

// Cron job mỗi phút
cron.schedule("*/5 * * * * *", async () => {
  console.log("⏳ Cron chạy...");
  for (let link of monitoredLinks) {
    if (!link.active) continue; // nếu đã kết thúc thì bỏ qua

    const status = await crawlLink(link.url);
    link.status = status;
    link.lastChecked = new Date().toLocaleString();

    console.log(`✔ ${link.url}: ${status}`);

    if (status === "Đã kết thúc") {
      link.active = false; // không theo dõi nữa
      console.log(`🛑 Ngừng theo dõi: ${link.url} (email: ${link.email})`);

      sendEmail(link.url, link.email)
    }
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Server chạy tại http://localhost:${PORT}`);
});


