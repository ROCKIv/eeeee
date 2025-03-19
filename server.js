const express = require('express');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const cors = require('cors');
const { install, resolveBuildId } = require('@puppeteer/browsers');
const app = express();

puppeteer.use(StealthPlugin());

const port = process.env.PORT || 3000;

app.use(express.json({ limit: '1mb' }));
app.use(cors({ origin: true, optionsSuccessStatus: 200 }));

// Configuración para instalar Chrome
async function setupBrowser() {
  const cacheDir = process.env.PUPPETEER_CACHE_DIR || '/opt/render/.cache/puppeteer';
  const browser = 'chrome';
  const platform = 'linux'; // Render usa Linux
  const buildId = await resolveBuildId(browser, platform, 'stable'); // Versión estable de Chrome

  console.log(`Instalando Chrome ${buildId} en ${cacheDir}...`);
  await install({
    browser,
    platform,
    buildId,
    cacheDir,
    downloadProgressCallback: (downloadedBytes, totalBytes) => {
      console.log(`Descargando Chrome: ${downloadedBytes}/${totalBytes}`);
    },
  });

  return `${cacheDir}/${browser}/${platform}/${buildId}/chrome-linux/chrome`;
}

// Pool de navegadores
let browserPool = null;
let executablePath = null;

const getBrowser = async () => {
  if (!browserPool) {
    console.log("Configurando Puppeteer...");
    if (!executablePath) {
      executablePath = await setupBrowser(); // Instala Chrome la primera vez
    }
    console.log("Lanzando Puppeteer con Stealth...");
    browserPool = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-extensions',
        '--no-first-run',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
      ],
      executablePath, // Usa la ruta instalada
    });
  }
  return browserPool;
};

// Endpoint POST /track
app.post('/track', async (req, res) => {
  const { trackingNumber } = req.body;

  if (!trackingNumber || typeof trackingNumber !== 'string') {
    return res.status(400).json({ error: 'Valid tracking number is required' });
  }

  try {
    const data = await scrape17track(trackingNumber.trim());
    console.log("Enviando datos al frontend:", data);
    res.json(data);
  } catch (error) {
    console.error("Error en /track:", error.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Función optimizada para scraping
async function scrape17track(trackingNumber) {
  const browser = await getBrowser();
  let page;
  try {
    page = await browser.newPage();

    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const resourceType = req.resourceType();
      if (['image', 'stylesheet', 'font', 'media'].includes(resourceType)) {
        req.abort();
      } else {
        req.continue();
      }
    });

    await page.setCacheEnabled(false);
    await page.setViewport({ width: 1280, height: 720 });

    console.log("Trackeando con número:", trackingNumber);
    const url = `https://t.17track.net/es#nums=${trackingNumber}`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });

    console.log("Esperando contenedor de rastreo...");
    await Promise.all([
      page.waitForSelector('.track-container, .tracklist-item', { timeout: 10000 }),
      page.waitForSelector('.trn-block', { timeout: 10000 }),
    ]);

    console.log("Extrayendo datos...");
    const data = await page.evaluate(() => {
      const courier = document.querySelector('.provider-name')?.textContent.trim() || 'Desconocido';
      const status = document.querySelector('.text-capitalize[title]')?.textContent.trim() ||
                     document.querySelector('.trn-block dd:first-child p')?.textContent.trim() || 'Sin información';

      const eventElements = document.querySelectorAll('.trn-block dd');
      const events = Array.from(eventElements, event => {
        const date = event.querySelector('time')?.textContent.trim() || 'Sin fecha';
        const description = event.querySelector('p')?.textContent.trim() || 'Sin descripción';
        const locationMatch = description.match(/【(.+?)】/) || description.match(/^(.+?),/);
        const location = locationMatch ? locationMatch[1] || locationMatch[0].replace(/,$/, '') : 'Sin ubicación';
        return { date, location, description };
      });

      return { courier, status, events };
    });

    console.log("Datos extraídos:", data);
    return data;
  } catch (error) {
    console.error("Error en scrape17track:", error.message);
    throw error;
  } finally {
    if (page) await page.close();
  }
}

// Cerrar el navegador al apagar el servidor
process.on('SIGTERM', async () => {
  if (browserPool) {
    await browserPool.close();
    browserPool = null;
  }
  process.exit(0);
});

app.get('/health', (req, res) => res.status(200).send('OK'));

app.listen(port, () => {
  console.log(`Backend corriendo en puerto ${port}`);
});