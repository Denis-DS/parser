import express from "express";
import fs from "fs";
import os from "os";
import path from "path";
import JSZip from "jszip";
import { fileURLToPath } from "url";
import puppeteer from "puppeteer"; // <-- puppeteer (не puppeteer-core)
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import puppeteerExtra from "puppeteer-extra";
import proxyChain from "proxy-chain";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3000;

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static("public"));

puppeteerExtra.use(StealthPlugin());

async function replaceAsync(str, regex, asyncFn) {
  const matches = [];
  str.replace(regex, (match, ...args) => matches.push(asyncFn(match, ...args)));
  return Promise.all(matches).then((results) =>
    str.replace(regex, () => results.shift())
  );
}

async function downloadResource(url, baseUrl, zip, downloaded, folder = "assets") {
  if (downloaded[url]) return downloaded[url];
  try {
    const fullUrl = new URL(url, baseUrl).href;
    console.log(`⬇️  Скачиваем ресурс: ${fullUrl}`);
    const res = await fetch(fullUrl);
    if (!res.ok) {
      console.warn(`⚠️  Ресурс недоступен: ${fullUrl}`);
      return null;
    }

    const buffer = await res.arrayBuffer();
    let filename = decodeURIComponent(
      fullUrl.split("/").pop().split("?")[0] || `file_${Date.now()}`
    );
    if (!filename.includes(".")) filename += ".bin";
    const relPath = `${folder}/${filename}`;
    downloaded[url] = relPath;

    const contentType = res.headers.get("content-type") || "";
    if (contentType.includes("text/css")) {
      let text = new TextDecoder().decode(buffer);
      text = await processCss(text, fullUrl, zip, downloaded, folder);
      zip.file(relPath, text);
    } else if (contentType.includes("javascript") || filename.endsWith(".js")) {
      let text = new TextDecoder().decode(buffer);
      text = await processJs(text, fullUrl, zip, downloaded, folder);
      zip.file(relPath, text);
    } else {
      zip.file(relPath, Buffer.from(buffer));
    }

    return relPath;
  } catch (e) {
    console.error(`❌ Ошибка при скачивании: ${url} — ${e.message}`);
    return null;
  }
}

async function processCss(css, baseUrl, zip, downloaded, folder) {
  const importRegex = /@import\s+(?:url\()?['"]?([^'")]+)['"]?\)?;/g;
  css = await replaceAsync(css, importRegex, async (match, url) => {
    const newPath = await downloadResource(url, baseUrl, zip, downloaded, folder);
    return newPath ? `@import url(../${newPath});` : match;
  });

  const urlRegex = /url\((['"]?)([^'")]+)\1\)/g;
  css = await replaceAsync(css, urlRegex, async (match, quote, url) => {
    if (url.startsWith("data:")) return match;
    const newPath = await downloadResource(url, baseUrl, zip, downloaded, folder);
    return newPath ? `url(../${newPath})` : match;
  });

  return css;
}

async function processJs(js, baseUrl, zip, downloaded, folder) {
  const urlRegex =
    /(['"])(https?:\/\/[^'"]+\.(png|jpe?g|gif|svg|woff2?|ttf|eot|js|css))\1/g;
  return await replaceAsync(js, urlRegex, async (match, quote, url) => {
    const newPath = await downloadResource(url, baseUrl, zip, downloaded, folder);
    return newPath ? `"../${newPath}"` : match;
  });
}

async function parseSite(url, proxyOptions) {
  console.log("🚀 Начинаем парсинг:", url);
  const zip = new JSZip();
  const downloaded = {};

  const chromePath = puppeteer.executablePath();  
  const launchOptions = {
    headless: true,
    executablePath: chromePath,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  };

  if (proxyOptions.host && proxyOptions.port && proxyOptions.type) {
    const { type, username, password, host, port } = proxyOptions;
    let proxyUrl = `${type}://`;
    if (username && password) {
      proxyUrl += `${encodeURIComponent(username)}:${encodeURIComponent(password)}@`;
    }
    proxyUrl += `${host}:${port}`;

    proxyUrl = await proxyChain.anonymizeProxy(proxyUrl);
    launchOptions.args.push(`--proxy-server=${proxyUrl}`);
    console.log(`🌐 Используем прокси: ${proxyUrl}`);
  }

  const browser = await puppeteerExtra.launch(launchOptions);
  const page = await browser.newPage();

  if (proxyOptions.username && proxyOptions.password) {
    await page.authenticate({
      username: proxyOptions.username,
      password: proxyOptions.password,
    });
  }

  await page.setUserAgent(
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
      "KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36"
  );

  await page.setExtraHTTPHeaders({
    "Accept-Language": "ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7",
    "Upgrade-Insecure-Requests": "1",
  });

  console.log("🌍 Загружаем страницу...");
  await page.goto(url, { waitUntil: "networkidle0", timeout: 0 });
  await new Promise((resolve) => setTimeout(resolve, 2000));

  let html = await page.content();
  const resourceRegex = /(href|src)=["']([^"']+)["']/g;
  let match;

  while ((match = resourceRegex.exec(html)) !== null) {
    const origUrl = match[2];
    if (
      origUrl.startsWith("data:") ||
      origUrl.startsWith("javascript:") ||
      origUrl.startsWith("#")
    )
      continue;

    const newPath = await downloadResource(origUrl, url, zip, downloaded, "assets");
    if (newPath) {
      html = html.replaceAll(match[0], `${match[1]}="./${newPath}"`);
    }
  }

  zip.file("index.html", html);
  await browser.close();

  const zipPath = path.join(os.tmpdir(), `site_${Date.now()}.zip`);
  const buffer = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
  });
  fs.writeFileSync(zipPath, buffer);

  console.log("✅ Архив создан:", zipPath);
  return zipPath;
}

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.post("/parse", async (req, res) => {
  const { url, proxyType, proxyHost, proxyPort, proxyUsername, proxyPassword } = req.body;

  console.log("📥 Получен запрос на парсинг:", req.body);

  if (!url) return res.status(400).send("URL обязателен.");

  try {
    const proxyOptions = {
      type: proxyType || "",
      host: proxyHost || "",
      port: proxyPort || "",
      username: proxyUsername || "",
      password: proxyPassword || "",
    };

    const zipPath = await parseSite(url, proxyOptions);

    res.download(zipPath, "site_archive.zip", (err) => {
      if (err) {
        console.error("❌ Ошибка при отправке архива:", err);
        return res.status(500).send("Ошибка при отправке архива.");
      }
      fs.unlink(zipPath, () => {
        console.log("🧹 Временный архив удалён:", zipPath);
      });
    });
  } catch (e) {
    console.error("❌ Ошибка при обработке запроса:", e);
    res.status(500).send("Ошибка при парсинге сайта.");
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Сервер запущен: http://localhost:${PORT}`);
});
