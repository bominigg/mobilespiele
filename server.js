const express = require('express');
const puppeteer = require('puppeteer');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Scrape a single car from mobile.de
app.post('/api/scrape', async (req, res) => {
  const { url } = req.body;
  
  if (!url) {
    return res.status(400).json({ error: 'URL is required' });
  }

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu'
      ]
    });

    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    
    // Wait a bit for dynamic content
    await page.waitForTimeout(2000);
    
    // Extract car data
    const carData = await page.evaluate(() => {
      // Helper function to extract text
      const getText = (selector) => {
        const el = document.querySelector(selector);
        return el ? el.textContent.trim() : '';
      };

      // Helper function to extract number from text
      const extractNumber = (text) => {
        const match = text.replace(/\./g, '').match(/\d+/);
        return match ? parseInt(match[0]) : 0;
      };

      // Extract model/title
      const modell = getText('h1[class*="Heading"]') || 
                     getText('h1') || 
                     getText('[data-testid="ad-title"]') || 
                     'Unbekanntes Modell';

      // Extract price - try multiple selectors
      let preis = 0;
      const priceSelectors = [
        '[class*="PriceInfo"]',
        '[data-testid="prime-price"]',
        '[class*="price"]',
        'span[class*="Price"]'
      ];
      
      for (const selector of priceSelectors) {
        const el = document.querySelector(selector);
        if (el) {
          const priceText = el.textContent.trim();
          preis = extractNumber(priceText);
          if (preis > 0) break;
        }
      }

      // Extract technical details
      const details = {
        motor: 'N/A',
        ps: 0,
        laufleistung: 0,
        baujahr: 2020
      };
      
      // Try to find all text on the page and extract info
      const allText = document.body.innerText;
      
      // Extract PS (Leistung)
      const psMatches = allText.match(/(\d+)\s*PS/i);
      if (psMatches) details.ps = parseInt(psMatches[1]);
      
      // Extract KW and convert to PS if PS not found
      if (details.ps === 0) {
        const kwMatches = allText.match(/(\d+)\s*kW/i);
        if (kwMatches) details.ps = Math.round(parseInt(kwMatches[1]) * 1.36);
      }
      
      // Extract Kilometerstand
      const kmMatches = allText.match(/(\d+\.?\d*)\s*km/i);
      if (kmMatches) {
        details.laufleistung = parseInt(kmMatches[1].replace('.', ''));
      }
      
      // Extract Baujahr/Erstzulassung
      const yearMatches = allText.match(/(19|20)\d{2}/);
      if (yearMatches) {
        const year = parseInt(yearMatches[0]);
        if (year >= 1990 && year <= 2025) {
          details.baujahr = year;
        }
      }
      
      // Extract Kraftstoff
      const fuelTypes = ['Benzin', 'Diesel', 'Elektro', 'Hybrid', 'Autogas', 'Erdgas'];
      for (const fuel of fuelTypes) {
        if (allText.includes(fuel)) {
          details.motor = fuel;
          break;
        }
      }

      // Extract images - try multiple strategies
      const imageUrls = new Set();
      
      // Strategy 1: Find images in gallery
      const galleryImages = document.querySelectorAll('img[src*="mobile"], img[data-src*="mobile"]');
      galleryImages.forEach(img => {
        const src = img.src || img.getAttribute('data-src');
        if (src && src.includes('mobile.de') && !src.includes('logo') && !src.includes('icon')) {
          // Convert thumbnail to larger image
          const largeSrc = src.replace(/\/s\//g, '/l/').replace(/\/(xs|s|m)\//g, '/l/');
          imageUrls.add(largeSrc);
        }
      });
      
      // Strategy 2: Check srcset attributes
      const srcsetImages = document.querySelectorAll('img[srcset]');
      srcsetImages.forEach(img => {
        const srcset = img.getAttribute('srcset');
        if (srcset && srcset.includes('mobile.de')) {
          const urls = srcset.split(',').map(s => s.trim().split(' ')[0]);
          urls.forEach(url => {
            if (url.includes('mobile.de') && !url.includes('logo') && !url.includes('icon')) {
              imageUrls.add(url);
            }
          });
        }
      });
      
      // Strategy 3: Look for background images
      const elementsWithBg = document.querySelectorAll('[style*="background-image"]');
      elementsWithBg.forEach(el => {
        const style = el.getAttribute('style');
        const urlMatch = style.match(/url\(['"]?([^'"]+)['"]?\)/);
        if (urlMatch && urlMatch[1].includes('mobile.de')) {
          imageUrls.add(urlMatch[1]);
        }
      });

      const bilder = Array.from(imageUrls).slice(0, 10);

      return {
        modell,
        motor: details.motor,
        ps: details.ps,
        laufleistung: details.laufleistung,
        baujahr: details.baujahr,
        preis,
        bilder: bilder.length > 0 ? bilder : ["data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='800' height='600'%3E%3Crect width='800' height='600' fill='%23334155'/%3E%3Ctext x='50%25' y='50%25' font-family='Arial' font-size='48' fill='%23cbd5e1' text-anchor='middle' dominant-baseline='middle'%3EKein Bild%3C/text%3E%3C/svg%3E"]
      };
    });

    await browser.close();

    if (!carData.preis || carData.preis === 0) {
      return res.status(400).json({ error: 'Konnte keine Preisdaten extrahieren' });
    }

    console.log('Scraped car data:', carData);
    res.json(carData);

  } catch (error) {
    if (browser) await browser.close();
    console.error('Scraping error:', error);
    res.status(500).json({ error: 'Fehler beim Scrapen: ' + error.message });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Serve index.html for all other routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
