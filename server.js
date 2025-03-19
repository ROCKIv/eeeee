const express = require('express');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const cors = require('cors');
const app = express();

puppeteer.use(StealthPlugin());

const port = process.env.PORT || 3000;

app.use(express.json({ limit: '1mb' })); // Limitar el tamaño del payload
app.use(cors({ origin: true, optionsSuccessStatus: 200 }));

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

// Pool de navegadores para reutilizar instancias
let browserPool = null;
const getBrowser = async () => {
  if (!browserPool) {
    console.log("Lanzando Puppeteer con Stealth...");
    browserPool = await puppeteer.launch({
      headless: 'new', // Usar headless moderno
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu', // Deshabilitar GPU
        '--disable-extensions', // Reducir overhead
        '--no-first-run',
        '--disable-background-timer-throttling', // Evitar retrasos
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
      ],
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined, // Usar Chromium preinstalado si está disponible
    });
  }
  return browserPool;
};

// Función optimizada para scraping
async function scrape17track(trackingNumber) {
  const browser = await getBrowser();
  let page;
  try {
    page = await browser.newPage();

    // Optimizar recursos de la página
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const resourceType = req.resourceType();
      if (['image', 'stylesheet', 'font', 'media'].includes(resourceType)) {
        req.abort(); // Bloquear recursos innecesarios
      } else {
        req.continue();
      }
    });

    await page.setCacheEnabled(false); // Deshabilitar cache del navegador
    await page.setViewport({ width: 1280, height: 720 }); // Tamaño mínimo razonable

    console.log("Trackeando con número:", trackingNumber);
    const url = `https://t.17track.net/es#nums=${trackingNumber}`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 }); // Más rápido que networkidle2

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
    if (page) await page.close(); // Cerrar página para liberar memoria
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