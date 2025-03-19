const express = require('express');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const cors = require('cors');
const app = express();

// Usar el puerto de la variable de entorno PORT (Render lo asigna como 8080) o 3000 como fallback
const port = process.env.PORT || 3000;

puppeteer.use(StealthPlugin()); // Activar el modo stealth

app.use(express.json());
app.use(cors());

// Endpoint POST /track
app.post('/track', async (req, res) => {
    const { trackingNumber } = req.body;

    if (!trackingNumber) {
        return res.status(400).json({ error: 'Tracking number is required' });
    }

    try {
        const data = await scrape17track(trackingNumber);
        console.log("Enviando datos al frontend:", data);
        res.json(data);
    } catch (error) {
        console.error("Error en /track:", error);
        res.status(500).json({ error: error.message });
    }
});

// Función para hacer scraping en 17track
async function scrape17track(trackingNumber) {
    console.log("Lanzando Puppeteer con Stealth...");
    const browser = await puppeteer.launch({
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage', // Optimiza memoria en Render
            '--disable-cache',
            '--single-process', // Reduce uso de recursos
            '--no-zygote' // Reduce overhead en contenedores
        ]
    });
    const page = await browser.newPage();

    await page.setCacheEnabled(false);

    console.log("Trackeando con número:", trackingNumber);
    const url = `https://t.17track.net/es#nums=${trackingNumber}`;
    await page.goto(url, {
        waitUntil: 'networkidle2',
        timeout: 20000
    });

    console.log("Forzando recarga de datos...");
    await page.reload({ waitUntil: 'networkidle2', timeout: 20000 });

    const pageTitle = await page.title();
    console.log("Título de la página:", pageTitle);

    const displayedTrackingNumber = await page.evaluate(() => {
        const input = document.querySelector('input[name="nums"]') || document.querySelector('.track-num');
        return input ? input.value || input.textContent.trim() : 'No encontrado';
    });
    console.log("Número de seguimiento mostrado en la página:", displayedTrackingNumber);

    console.log("Esperando el contenedor de rastreo...");
    try {
        await page.waitForSelector('.track-container, .tracklist-item', { timeout: 15000 });
        await page.waitForSelector('.trn-block', { timeout: 15000 });
    } catch (error) {
        console.error("Error esperando selectores:", error);
        await browser.close();
        throw new Error('No se encontraron los elementos de rastreo');
    }

    console.log("Extrayendo datos...");
    const data = await page.evaluate(() => {
        const courier = document.querySelector('.provider-name')?.textContent.trim() || 'Desconocido';
        const statusElement = document.querySelector('.text-capitalize[title]');
        const status = statusElement ? statusElement.textContent.trim() : document.querySelector('.trn-block dd:first-child p')?.textContent.trim() || 'Sin información';

        const eventElements = document.querySelectorAll('.trn-block dd');
        const events = Array.from(eventElements).map(event => {
            const date = event.querySelector('time')?.textContent.trim() || 'Sin fecha';
            const description = event.querySelector('p')?.textContent.trim() || 'Sin descripción';
            const locationMatch = description.match(/【(.+?)】/) || description.match(/^(.+?),/);
            const location = locationMatch ? locationMatch[1] || locationMatch[0].replace(/,$/, '') : 'Sin ubicación';
            return { date, location, description };
        });

        return { courier, status, events };
    });

    console.log("Datos extraídos:", data);
    await browser.close();
    return data;
}

// Endpoint básico para verificar que el servidor está vivo
app.get('/health', (req, res) => {
    res.status(200).send('OK');
});

// Escuchar en el puerto asignado por Render
app.listen(port, () => {
    console.log(`Backend corriendo en puerto ${port}`);
});