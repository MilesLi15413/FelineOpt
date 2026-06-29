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

  // ── Ingredient lookup via Claude ─────────────────────
  if (req.method === 'GET' && req.url.startsWith('/api/ingredients')) {
    const qs = new URL(`http://x${req.url}`).searchParams;
    const product = (qs.get('product') || '').trim();
    if (!product) {
      res.writeHead(400, { ...headers, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing product' }));
      return;
    }

    const payload = JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 512,
      messages: [{
        role: 'user',
        content: `List the ingredients in "${product}" cat/pet food based on your training knowledge. Reply with ONLY a comma-separated ingredient list — no intro, no explanation, no disclaimers. If you have no knowledge of this product at all, reply with exactly: UNKNOWN`,
      }],
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
      let data = '';
      apiRes.on('data', c => { data += c; });
      apiRes.on('end', () => {
        try {
          const json = JSON.parse(data);
          const text = json.content?.[0]?.text?.trim() || 'UNKNOWN';
          res.writeHead(200, { ...headers, 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ingredients: text === 'UNKNOWN' ? null : text }));
        } catch {
          res.writeHead(500, { ...headers, 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ingredients: null }));
        }
      });
    });
    proxy.on('error', () => {
      res.writeHead(500, { ...headers, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ingredients: null }));
    });
    proxy.write(payload);
    proxy.end();
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
