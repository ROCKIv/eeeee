const express = require('express');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const cors = require('cors');
const { install, resolveBuildId } = require('@puppeteer/browsers');
const fs = require('fs').promises;
const path = require('path');
const app = express();

puppeteer.use(StealthPlugin());

const port = process.env.PORT || 3000;

app.use(express.json({ limit: '1mb' }));
app.use(cors({ origin: true, optionsSuccessStatus: 200 }));

// Configuración para instalar Chrome
async function setupBrowser() {
  const cacheDir = process.env.PUPPETEER_CACHE_DIR || '/opt/render/.cache/puppeteer';
  const browser = 'chrome';
  const platform = 'linux';
  const buildId = await resolveBuildId(browser, platform, 'stable');

  const basePath = `${cacheDir}/${browser}/${platform}/${buildId}/chrome-linux`;
  const expectedPath = `${basePath}/chrome`;
  console.log(`Verificando si Chrome existe en: ${expectedPath}`);

  try {
    await fs.access(expectedPath);
    console.log(`Chrome encontrado en ${expectedPath}`);
  } catch (error) {
    console.log(`Chrome no encontrado. Instalando ${buildId} en ${cacheDir}...`);
    await install({
      browser,
      platform,
      buildId,
      cacheDir,
      downloadProgressCallback: (downloadedBytes, totalBytes) => {
        console.log(`Descargando Chrome: ${downloadedBytes}/${totalBytes}`);
      },
    });
    console.log(`Instalación reportada como completada en ${basePath}`);

    // Verificar si el directorio existe y tiene contenido
    try {
      const dirContents = await fs.readdir(basePath);
      console.log(`Contenido del directorio ${basePath}:`, dirContents);
      if (!dirContents.includes('chrome')) {
        throw new Error(`El ejecutable 'chrome' no está presente en ${basePath}`);
      }
      await fs.chmod(expectedPath, 0o755); // Asegurar permisos de ejecución
      console.log(`Permisos ajustados para ${expectedPath}`);
    } catch (dirError) {
      console.error(`Error al verificar el directorio ${basePath}:`, dirError.message);
      throw dirError;
    }
  }

  return expectedPath;
}

// Pool de navegadores
let browserPool = null;
let executablePath = null;

const initializeBrowser = async () => {
  console.log("Inicializando Puppeteer al arrancar el servidor...");
  try {
    executablePath = await setupBrowser();
    console.log(`Confirmado: ${executablePath} existe y es accesible`);

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
      executablePath,
    });
    console.log("Puppeteer lanzado exitosamente");
  } catch (error) {
    console.error("Error al inicializar el navegador:", error.message);
    throw error;
  }
};

// Función para obtener el navegador
const getBrowser = async () => {
  if (!browserPool) {
    throw new Error("El navegador no se inicializó correctamente al arrancar el servidor.");
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

// Iniciar el servidor y el navegador
const startServer = async () => {
  try {
    await initializeBrowser();
    app.listen(port, () => {
      console.log(`Backend corriendo en puerto ${port}`);
    });
  } catch (error) {
    console.error("Error al iniciar el servidor:", error.message);
    process.exit(1);
  }
};

startServer();