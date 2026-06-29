require('dotenv').config();
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

// ── Put your Anthropic API key here ──────────────────
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'YOUR_KEY_HERE';
// ─────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;

const MIME = {
  '.html': 'text/html',
  '.css':  'text/css',
  '.js':   'application/javascript',
  '.json': 'application/json',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
};

// ── Web-scraping helpers ─────────────────────────────
function httpsGetPage(url, extraHeaders = {}, _redirects = 0) {
  if (_redirects > 4) return Promise.reject(new Error('Too many redirects'));
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { return reject(e); }
    const r = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'identity',
        ...extraHeaders,
      },
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const loc = res.headers.location.startsWith('http')
          ? res.headers.location : `https://${u.hostname}${res.headers.location}`;
        res.resume();
        return httpsGetPage(loc, extraHeaders, _redirects + 1).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => resolve(data));
    });
    r.on('error', reject);
    r.setTimeout(10000, () => { r.destroy(); reject(new Error('timeout')); });
    r.end();
  });
}

function extractIngredientsFromHtml(html) {
  // Strategy 1: Next.js __NEXT_DATA__ (Chewy, PetSmart)
  const nextM = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (nextM) {
    try {
      const str = nextM[1];
      const m = str.match(/"(?:ingredient[sS]?(?:List|Text)?)"\s*:\s*"([^"\\]{20,})"/);
      if (m) return m[1].replace(/\\n/g, ' ').replace(/\\u([0-9a-f]{4})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
    } catch {}
  }

  // Strategy 2: JSON-LD schema Product description
  const ldRe = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = ldRe.exec(html)) !== null) {
    try {
      const obj = JSON.parse(m[1]);
      const desc = (Array.isArray(obj) ? obj[0] : obj).description || '';
      const ing = desc.match(/[Ii]ngredients?\s*[:\-]\s*([A-Z][^.]{20,})/);
      if (ing) return ing[1].trim();
    } catch {}
  }

  // Strategy 3: HTML text pattern — "Ingredients" heading followed by list text
  const noScript = html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '');
  const textM = noScript.match(/[Ii]ngredients?\s*(?:<[^>]+>)*\s*:?\s*(?:<[^>]+>)*([A-Z][^<]{30,})/);
  if (textM) {
    return textM[1]
      .replace(/<[^>]+>/g, ' ')
      .replace(/&amp;/g, '&').replace(/&#x27;|&#39;/g, "'").replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ').trim();
  }

  return null;
}

const server = http.createServer((req, res) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (req.method === 'OPTIONS') {
    res.writeHead(204, headers);
    res.end();
    return;
  }

  // ── Ingredient lookup: database → web scrape → AI ───
  if (req.method === 'GET' && req.url.startsWith('/api/ingredients')) {
    const qs = new URL(`http://x${req.url}`).searchParams;
    const product = (qs.get('product') || '').trim();
    if (!product) {
      res.writeHead(400, { ...headers, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing product' }));
      return;
    }

    const respond = (ingredients, source) => {
      res.writeHead(200, { ...headers, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ingredients: ingredients || null, source: source || null }));
    };

    (async () => {
      // Build a list of search queries from specific → short (databases work better with fewer words)
      const words = product.split(/\s+/);
      const queries = [...new Set([product, words.slice(0, 3).join(' '), words.slice(0, 2).join(' '), words[0]])].filter(Boolean);

      // 1. Open Pet Food Facts name search
      for (const q of queries) {
        try {
          const body = await httpsGetPage(`https://world.openpetfoodfacts.org/cgi/search.pl?search_terms=${encodeURIComponent(q)}&search_simple=1&json=1&fields=product_name,ingredients_text&page_size=10`);
          const data = JSON.parse(body);
          for (const p of (data.products || [])) {
            const ing = (p.ingredients_text || '').trim();
            if (ing.length > 10) return respond(ing, 'openpetfoodfacts');
          }
        } catch {}
      }

      // 2. Open Food Facts name search
      for (const q of queries) {
        try {
          const body = await httpsGetPage(`https://world.openfoodfacts.org/cgi/search.pl?search_terms=${encodeURIComponent(q)}&search_simple=1&json=1&fields=product_name,ingredients_text&page_size=10`);
          const data = JSON.parse(body);
          for (const p of (data.products || [])) {
            const ing = (p.ingredients_text || '').trim();
            if (ing.length > 10) return respond(ing, 'openfoodfacts');
          }
        } catch {}
      }

      // 3. DuckDuckGo → scrape first product page from known pet retailers
      try {
        const ddgQuery = `${product} cat food ingredients site:chewy.com OR site:petsmart.com OR site:petco.com`;
        const ddgHtml = await httpsGetPage(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(ddgQuery)}`);
        const urlRe = /uddg=([^"&]+)/g;
        let urlM;
        const tried = new Set();
        while ((urlM = urlRe.exec(ddgHtml)) !== null) {
          let target;
          try { target = decodeURIComponent(urlM[1]); } catch { continue; }
          if (!/chewy\.com|petsmart\.com|petco\.com/i.test(target)) continue;
          if (tried.has(target) || tried.size >= 3) break;
          tried.add(target);
          try {
            const html = await httpsGetPage(target);
            const ing = extractIngredientsFromHtml(html);
            if (ing && ing.length > 10) {
              const src = /chewy\.com/i.test(target) ? 'chewy'
                : /petsmart\.com/i.test(target) ? 'petsmart' : 'petco';
              return respond(ing, src);
            }
          } catch {}
        }
      } catch {}

      // 5. Claude AI last resort
      const payload = JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 512,
        messages: [{
          role: 'user',
          content: `List the ingredients in "${product}" cat/pet food based on your training knowledge. Reply with ONLY a comma-separated ingredient list — no intro, no explanation, no disclaimers. If you have no knowledge of this product at all, reply with exactly: UNKNOWN`,
        }],
      });
      const apiReq = https.request({
        hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      }, (apiRes) => {
        let data = '';
        apiRes.on('data', c => { data += c; });
        apiRes.on('end', () => {
          try {
            const json = JSON.parse(data);
            const text = (json.content?.[0]?.text || '').trim();
            respond(text && text !== 'UNKNOWN' ? text : null, 'ai');
          } catch { respond(null, null); }
        });
      });
      apiReq.on('error', () => respond(null, null));
      apiReq.write(payload);
      apiReq.end();
    })();
    return;
  }

  // ── Chat proxy endpoint ──────────────────────────────
  if (req.method === 'POST' && req.url === '/api/chat') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      let parsed;
      try { parsed = JSON.parse(body); } catch {
        res.writeHead(400, { ...headers, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
        return;
      }

      const payload = JSON.stringify({ // chat payload
        model: 'claude-sonnet-4-6',
        max_tokens: 1024,
        stream: true,
        system: `You are a veterinary medicine and feline nutrition expert with deep knowledge of:
- Cat physiology, metabolism, and dietary requirements
- Commercial pet food ingredients, additives, preservatives, and dyes
- How the pet food industry formulates products and where it cuts corners
- Known harmful ingredients (carrageenan, BHA/BHT, ethoxyquin, artificial dyes, carrageenan, rendered meats, by-products)
- AAFCO nutritional standards and what they actually mean
- FDA and USDA pet food recalls and their causes
- Raw, wet, dry, and freeze-dried diets and their tradeoffs
- Common feline health conditions linked to diet (urinary issues, obesity, diabetes, IBD, kidney disease)
- How to read and interpret a pet food label
- Scientific studies and veterinary literature on feline nutrition

When answering:
- Be direct, specific, and accurate
- Cite specific ingredients, studies, or known data when relevant
- Flag ingredients or practices that are harmful or controversial
- Do not sugarcoat industry practices that harm animal health
- If something is debated in veterinary literature, say so
- Never recommend a specific brand unless asked
- Always suggest consulting a veterinarian for medical decisions

When a user asks about a specific product or ingredient, always respond using EXACTLY this format (no deviations):

Product:
[Name of the product or ingredient in ALL CAPS]

About:
[1-2 sentence explanation of what it is]

Harm to cats:
[Start with YES or NO, then a brief explanation grounded in known toxicology, studies, or veterinary literature]

Benefit if any:
[Any real benefit, or "None" if there is no benefit]

Sources:
1) [Title](URL)
2) [Title](URL)
3) [Title](URL)

List 2-4 real, verifiable scientific sources using that exact numbered format. Use PubMed (https://pubmed.ncbi.nlm.nih.gov/), NCBI (https://www.ncbi.nlm.nih.gov/), or established veterinary/regulatory references. Only include URLs you are confident are real and accurate.`,
        messages: parsed.messages || [],
      });

      const options = {
        hostname: 'api.anthropic.com',
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
      };

      const proxy = https.request(options, (apiRes) => {
        res.writeHead(apiRes.statusCode, {
          ...headers,
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
        });
        apiRes.pipe(res);
      });

      proxy.on('error', (e) => {
        res.writeHead(500, { ...headers, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      });

      proxy.write(payload);
      proxy.end();
    });
    return;
  }

  // ── Recalls endpoint (FDA CVM + RSS) ────────────────
  if (req.method === 'GET' && req.url === '/api/recalls') {
    const allRecalls = [];
    const seen = new Set();
    let pending = 0;

    const CAT_RE    = /\b(cat|cats|feline|kitten|kittens)\b/i;
    const ANIMAL_RE = /\b(animal|veterinary|canine|feline|cat|cats|dog|dogs|kitten|puppy|puppies|pet food|equine|livestock)\b/i;

    const addRecalls = (items) => {
      for (const r of items) {
        const pathKey = r.fdaPath ? r.fdaPath.replace(/\/$/, '') : null;
        const titleKey = (r.title + '|' + r.date).toLowerCase().replace(/\s+/g, '');
        if ((pathKey && seen.has(pathKey)) || seen.has(titleKey)) continue;
        if (pathKey) seen.add(pathKey);
        seen.add(titleKey);
        allRecalls.push(r);
      }
    };

    const done = () => {
      if (--pending > 0) return;
      allRecalls.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
      res.writeHead(200, { ...headers, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ recalls: allRecalls, label: 'Animal & Veterinary Recalls (FDA)' }));
    };

    const fetchHttp = (opts, body, cb) => {
      pending++;
      if (body) {
        opts.headers['Content-Type']   = 'application/x-www-form-urlencoded';
        opts.headers['Content-Length'] = Buffer.byteLength(body);
      }
      const r = https.request(opts, (apiRes) => {
        let data = '';
        apiRes.on('data', c => { data += c; });
        apiRes.on('end', () => { try { cb(data); } catch {} done(); });
      });
      r.on('error', done);
      if (body) r.write(body);
      r.end();
    };

    const getXml = (xml, tag) => {
      const m = new RegExp(`<${tag}(?:\\s[^>]*)?>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tag}>`).exec(xml);
      return m ? m[1].trim() : '';
    };

    // Source 1: FDA CVM Animal & Veterinary Recalls table (Drupal view)
    const body = [
      'view_name=recall_solr_index',
      'view_display_id=cvm_recall_datatable_block_1',
      'view_path=/animal-veterinary/safety-health/recalls-withdrawals',
      'view_base_path=animal-veterinary/safety-health/recalls-withdrawals',
      'view_dom_id=felineopt',
      'pager_element=0',
    ].join('&');

    fetchHttp(
      { hostname: 'www.fda.gov', path: '/views/ajax', method: 'POST',
        headers: { 'User-Agent': 'FelineOpt/1.0', 'Accept': 'application/json' } },
      body,
      (data) => {
        const items = [];
        try {
          const arr    = JSON.parse(data);
          const insert = arr.find(a => a.command === 'insert');
          const html   = insert?.data || '';
          const trs    = html.match(/<tr[^>]*>([\s\S]*?)<\/tr>/g) || [];
          for (const tr of trs.slice(1)) {
            const tds = tr.match(/<td[^>]*>([\s\S]*?)<\/td>/g) || [];
            if (tds.length < 4) continue;
            const dateM   = tds[0].match(/datetime="([^"]+)"/);
            const date    = dateM ? dateM[1].slice(0, 10) : '';
            const brand   = tds[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
            const linkM   = tds[1].match(/href="([^"]+)"/);
            const fdaPath = linkM ? linkM[1] : '';
            const title   = tds[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
            const reason  = tds[3].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
            const company = tds[4] ? tds[4].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : brand;
            const catSpecific = CAT_RE.test(`${brand} ${title} ${reason} ${company}`);
            items.push({ brand, title, reason, company, reasonType: reason,
              classification: '', date, fdaPath, terms: 'Animal & Veterinary', catSpecific });
          }
        } catch {}
        addRecalls(items);
      }
    );

    // Source 2: FDA RSS — catches very recent items before CVM table updates
    fetchHttp(
      { hostname: 'www.fda.gov',
        path: '/about-fda/contact-fda/stay-informed/rss-feeds/recalls/rss.xml',
        method: 'GET', headers: { 'User-Agent': 'FelineOpt/1.0' } },
      null,
      (data) => {
        const items = [];
        const itemRe = /<item>([\s\S]*?)<\/item>/g;
        let m;
        while ((m = itemRe.exec(data)) !== null) {
          const xml  = m[1];
          const title = getXml(xml, 'title');
          const desc  = getXml(xml, 'description');
          if (!ANIMAL_RE.test(title + ' ' + desc)) continue;
          const link = getXml(xml, 'link') || getXml(xml, 'guid');
          const pub  = getXml(xml, 'pubDate');
          const coM  = title.match(/^(.+?)(?:\s+(?:Voluntarily\s+)?Recalls?\b)/i);
          const company = coM ? coM[1].trim() : title.split(' ').slice(0, 4).join(' ');
          const afterRecalls = title.replace(/^.*?\bRecalls?\s*/i, '');
          const productM = afterRecalls.match(/^(.+?)\s+(?:Due to|Because of|Following|After)\b/i);
          const reasonM  = afterRecalls.match(/(?:Due to|Because of|Following|After)\s+(.+)$/i);
          const product  = productM ? productM[1].trim() : afterRecalls.split(' ').slice(0, 6).join(' ');
          const reason   = reasonM  ? reasonM[1].trim()  : desc.slice(0, 150);
          let date = '';
          if (pub) { const d = new Date(pub); if (!isNaN(d)) date = d.toISOString().slice(0, 10); }
          let fdaPath = '';
          try { fdaPath = new URL(link).pathname; } catch {}
          items.push({ brand: company, title: product, reason, company, reasonType: reason,
            classification: '', date, fdaPath, terms: 'Animal & Veterinary',
            catSpecific: CAT_RE.test(title + ' ' + desc) });
        }
        addRecalls(items);
      }
    );

    return;
  }

  // ── Recall image scraper ────────────────────────────
  if (req.method === 'GET' && req.url.startsWith('/api/recall-image')) {
    const qs = new URL(`http://x${req.url}`).searchParams;
    const fdaPath = qs.get('path') || '';
    if (!fdaPath.startsWith('/safety/')) {
      res.writeHead(400, { ...headers, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ images: [] }));
      return;
    }
    const imgReq = https.request({
      hostname: 'www.fda.gov',
      path: fdaPath,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
      },
    }, (imgRes) => {
      let html = '';
      imgRes.on('data', chunk => { html += chunk; });
      imgRes.on('end', () => {
        const images = [];
        const re = /<img[^>]+src="([^"]+)"[^>]*>/gi;
        let m;
        while ((m = re.exec(html)) !== null) {
          const src = m[1];
          if (/\/(files|media)\//i.test(src) && !/icon|logo|seal|banner|sprite/i.test(src)) {
            const full = src.startsWith('http') ? src : `https://www.fda.gov${src}`;
            if (!images.includes(full)) images.push(full);
          }
        }
        res.writeHead(200, { ...headers, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ images: images.slice(0, 4) }));
      });
    });
    imgReq.on('error', () => {
      res.writeHead(200, { ...headers, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ images: [] }));
    });
    imgReq.end();
    return;
  }

  // ── Serve static files ───────────────────────────────
  let filePath = req.url === '/' ? '/index.html' : req.url;
  filePath = path.join(__dirname, filePath);

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, headers);
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { ...headers, 'Content-Type': MIME[ext] || 'text/plain' });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`FelineOpt running at http://localhost:${PORT}`);
});
