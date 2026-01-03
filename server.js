const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Health Check
app.get('/', (req, res) => {
  res.json({ status: 'Server läuft', version: '1.0.0' });
});

// Scrape Car Data from Mobile.de
app.post('/api/scrape', async (req, res) => {
  try {
    const { url } = req.body;

    if (!url || !url.includes('mobile.de')) {
      return res.status(400).json({ error: 'Ungültige Mobile.de URL' });
    }

    // Fetch the page
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });

    const $ = cheerio.load(response.data);

    // Extract car data
    const carData = {
      modell: '',
      motor: '',
      ps: 0,
      laufleistung: 0,
      baujahr: 0,
      preis: 0,
      bilder: []
    };

    // Titel/Modell
    carData.modell = $('h1[data-testid="ad-title"]').text().trim() || 
                     $('.h2.u-text-bold').first().text().trim() ||
                     $('h1').first().text().trim();

    // Preis
    const preisText = $('[data-testid="prime-price"]').text().trim() ||
                      $('.h3.u-text-bold').first().text().trim();
    carData.preis = parseInt(preisText.replace(/[^\d]/g, '')) || 0;

    // Technische Daten durchgehen
    $('.techdata--list-item, [data-testid="feature-item"]').each((i, elem) => {
      const label = $(elem).find('.techdata--label, dt').text().trim().toLowerCase();
      const value = $(elem).find('.techdata--value, dd').text().trim();

      if (label.includes('leistung') || label.includes('ps')) {
        const psMatch = value.match(/(\d+)\s*PS/i);
        if (psMatch) carData.ps = parseInt(psMatch[1]);
      }

      if (label.includes('kilometerstand') || label.includes('laufleistung')) {
        const kmMatch = value.replace(/[^\d]/g, '');
        carData.laufleistung = parseInt(kmMatch) || 0;
      }

      if (label.includes('erstzulassung') || label.includes('baujahr')) {
        const yearMatch = value.match(/\d{4}/);
        if (yearMatch) carData.baujahr = parseInt(yearMatch[0]);
      }

      if (label.includes('kraftstoff') || label.includes('getriebe')) {
        if (!carData.motor) {
          carData.motor = value;
        } else {
          carData.motor += ' ' + value;
        }
      }
    });

    // Alternative: Daten aus JSON-LD Script
    $('script[type="application/ld+json"]').each((i, elem) => {
      try {
        const jsonData = JSON.parse($(elem).html());
        
        if (jsonData['@type'] === 'Car' || jsonData['@type'] === 'Vehicle') {
          if (!carData.modell && jsonData.name) carData.modell = jsonData.name;
          if (!carData.baujahr && jsonData.modelDate) {
            const year = new Date(jsonData.modelDate).getFullYear();
            if (year > 1900) carData.baujahr = year;
          }
          if (!carData.laufleistung && jsonData.mileageFromOdometer) {
            carData.laufleistung = parseInt(jsonData.mileageFromOdometer.value) || 0;
          }
          if (!carData.motor && jsonData.fuelType) {
            carData.motor = jsonData.fuelType;
          }
        }

        if (jsonData.offers && jsonData.offers.price) {
          if (!carData.preis) {
            carData.preis = parseInt(jsonData.offers.price) || 0;
          }
        }
      } catch (e) {
        // JSON parsing failed, continue
      }
    });

    // Bilder extrahieren
    const imageSelectors = [
      'img[data-testid="ad-image"]',
      '.gallery-picture__image',
      '.image-gallery img',
      'img[src*="vehicle"]'
    ];

    imageSelectors.forEach(selector => {
      $(selector).each((i, elem) => {
        const src = $(elem).attr('src') || $(elem).attr('data-src');
        if (src && !carData.bilder.includes(src)) {
          // Filter out small thumbnails and icons
          if (!src.includes('icon') && !src.includes('logo') && src.startsWith('http')) {
            carData.bilder.push(src);
          }
        }
      });
    });

    // Fallback Bild
    if (carData.bilder.length === 0) {
      carData.bilder.push("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='800' height='600'%3E%3Crect width='800' height='600' fill='%23334155'/%3E%3Ctext x='50%25' y='50%25' font-family='Arial' font-size='48' fill='%23cbd5e1' text-anchor='middle' dominant-baseline='middle'%3EKein Bild%3C/text%3E%3C/svg%3E");
    }

    // Limit images to 10
    carData.bilder = carData.bilder.slice(0, 10);

    // Validation
    if (!carData.preis || carData.preis === 0) {
      return res.status(400).json({ 
        error: 'Keine Preisdaten gefunden',
        debug: carData 
      });
    }

    if (!carData.modell) {
      return res.status(400).json({ 
        error: 'Kein Modell gefunden',
        debug: carData 
      });
    }

    res.json({
      success: true,
      data: {
        id: Date.now() + Math.random(),
        ...carData,
        url
      }
    });

  } catch (error) {
    console.error('Scraping error:', error.message);
    res.status(500).json({ 
      error: 'Fehler beim Scrapen',
      message: error.message 
    });
  }
});

// Batch Import
app.post('/api/scrape-batch', async (req, res) => {
  try {
    const { urls } = req.body;

    if (!Array.isArray(urls) || urls.length === 0) {
      return res.status(400).json({ error: 'Keine URLs angegeben' });
    }

    const results = [];
    const errors = [];

    for (const url of urls) {
      try {
        const response = await axios.post(`http://localhost:${PORT}/api/scrape`, { url });
        results.push(response.data.data);
        
        // Small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 1000));
      } catch (error) {
        errors.push({ url, error: error.message });
      }
    }

    res.json({
      success: true,
      imported: results.length,
      failed: errors.length,
      data: results,
      errors: errors
    });

  } catch (error) {
    console.error('Batch import error:', error);
    res.status(500).json({ error: 'Batch Import Fehler' });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Server läuft auf Port ${PORT}`);
});
