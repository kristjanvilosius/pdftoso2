const express = require('express');
const cors = require('cors');
const multer = require('multer');
const Anthropic = require('@anthropic-ai/sdk');
const https = require('https');

// ─── Constants ───────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3456;
const PASSWORD = process.env.PASSWORD || 'cuttingedge';
const KATANA_BASE = 'https://api.katanamrp.com/v1';

// ─── Anthropic Client (per API key) ─────────────────────────────────────────

const anthropicClients = new Map();
function getAnthropic(apiKey) {
  if (!apiKey) throw new Error('Anthropic API key is required');
  if (!anthropicClients.has(apiKey)) {
    anthropicClients.set(apiKey, new Anthropic({ apiKey }));
  }
  return anthropicClients.get(apiKey);
}

// ─── Express Setup ───────────────────────────────────────────────────────────

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(__dirname));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf') cb(null, true);
    else cb(new Error('Only PDF files are allowed'));
  }
});

// ─── Auth Middleware ─────────────────────────────────────────────────────────

function checkAuth(req, res, next) {
  if (req.headers['x-password'] !== PASSWORD) {
    return res.status(401).json({ success: false, error: 'Invalid password' });
  }
  next();
}

// ─── Katana API Helpers ──────────────────────────────────────────────────────

function katanaRequest(apiKey, method, endpoint, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(KATANA_BASE + endpoint);
    const options = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method,
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 429) {
          const retryAfter = parseInt(res.headers['retry-after'] || '5', 10);
          setTimeout(() => {
            katanaRequest(apiKey, method, endpoint, body).then(resolve).catch(reject);
          }, retryAfter * 1000);
          return;
        }
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 400) {
            reject({ status: res.statusCode, body: parsed });
          } else {
            resolve(parsed);
          }
        } catch (e) {
          reject({ status: res.statusCode, body: data });
        }
      });
    });

    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function katanaGetAll(apiKey, endpoint, maxPages = 20) {
  let all = [];
  for (let page = 1; page <= maxPages; page++) {
    const sep = endpoint.includes('?') ? '&' : '?';
    const raw = await katanaRequest(apiKey, 'GET', `${endpoint}${sep}limit=50&page=${page}`);
    // Katana wraps responses in { data: [...] }
    const results = Array.isArray(raw) ? raw : (Array.isArray(raw?.data) ? raw.data : []);
    all = all.concat(results);
    if (results.length < 50) break;
  }
  return all;
}

// ─── Variant cache (per API key, 5 min TTL) ─────────────────────────────────

const variantCache = new Map();

async function getCachedVariants(apiKey) {
  const cached = variantCache.get(apiKey);
  if (cached && Date.now() - cached.timestamp < 5 * 60 * 1000) {
    console.log(`Using cached variants: ${cached.data.length} items`);
    return cached.data;
  }
  console.log('Cache miss — fetching variants and products from Katana...');
  // Fetch sequentially to avoid connection overload
  const variants = await katanaGetAll(apiKey, '/variants');
  console.log(`  Fetched ${variants.length} variants, now fetching products...`);
  const products = await katanaGetAll(apiKey, '/products');
  const productMap = new Map(products.map(p => [p.id, p]));
  const enriched = variants.map(v => ({
    ...v,
    _product_name: productMap.get(v.product_id)?.name || '',
  }));
  console.log(`Fetched ${variants.length} variants, ${products.length} products. Sample:`,
    JSON.stringify(enriched[0], null, 2));
  variantCache.set(apiKey, { data: enriched, timestamp: Date.now() });
  return enriched;
}

// ─── Customer lookup / create ────────────────────────────────────────────────

async function findOrCreateCustomer(apiKey, customerName) {
  const customers = await katanaGetAll(apiKey, '/customers');
  const nameLower = customerName.toLowerCase().trim();

  // Exact match
  const exact = customers.find(c => c.name?.toLowerCase().trim() === nameLower);
  if (exact) return { customer: exact, created: false };

  // Contains match
  const fuzzy = customers.find(c =>
    c.name?.toLowerCase().includes(nameLower) ||
    nameLower.includes(c.name?.toLowerCase())
  );
  if (fuzzy) return { customer: fuzzy, created: false };

  // Create new
  const newCustomer = await katanaRequest(apiKey, 'POST', '/customers', { name: customerName });
  return { customer: newCustomer, created: true };
}

// ─── PDF Extraction Prompt ───────────────────────────────────────────────────

const EXTRACTION_PROMPT = `You are a document parser for a manufacturing ERP system. Extract the following fields from this sales order / invoice / purchase order PDF and return ONLY valid JSON (no markdown, no code blocks, no explanation).

Return this exact JSON structure:
{
  "customer_name": "string — the buyer/customer company or person name",
  "order_date": "YYYY-MM-DD or null",
  "delivery_date": "YYYY-MM-DD or null",
  "reference_number": "string — PO number, order reference, invoice number, or null",
  "currency": "3-letter ISO code like EUR, USD, GBP — default EUR if unclear",
  "notes": "string — any special instructions, shipping notes, or additional info, or null",
  "line_items": [
    {
      "product_name": "string — full product name/description",
      "sku": "string or null — product code, item number, SKU, article number",
      "quantity": number,
      "unit_price": number
    }
  ]
}

Rules:
- Extract ALL line items from the document
- For unit_price, use the price BEFORE tax/VAT
- If the document shows total line price but not unit price, calculate unit_price = total / quantity
- If currency symbol is € use EUR, $ use USD, £ use GBP
- Dates should be in YYYY-MM-DD format, convert from any format found in the document
- If a field is genuinely not present in the document, use null
- For SKU: look for fields labeled SKU, Item Code, Article No., Product Code, Part Number, etc.
- Return ONLY the JSON object, nothing else`;

// ─── Routes ──────────────────────────────────────────────────────────────────

// Parse PDF with Claude
app.post('/api/parse-pdf', checkAuth, upload.single('pdf'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No PDF file uploaded' });
    }

    const anthropicApiKey = req.body.anthropicApiKey;
    if (!anthropicApiKey) {
      return res.status(400).json({ success: false, error: 'Anthropic API key required' });
    }

    const pdfBase64 = req.file.buffer.toString('base64');

    const response = await getAnthropic(anthropicApiKey).messages.create({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 4096,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'document',
            source: {
              type: 'base64',
              media_type: 'application/pdf',
              data: pdfBase64,
            },
          },
          {
            type: 'text',
            text: EXTRACTION_PROMPT,
          }
        ]
      }]
    });

    let text = response.content[0].text;

    // Strip markdown code fences if Claude wrapped the JSON
    text = text.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();

    // Try to extract JSON object if there's extra text
    if (!text.startsWith('{')) {
      const match = text.match(/\{[\s\S]*\}/);
      if (match) text = match[0];
    }

    const data = JSON.parse(text);
    res.json({ success: true, data });

  } catch (err) {
    console.error('Parse PDF error:', err);
    const message = err instanceof SyntaxError
      ? 'Failed to parse AI response as JSON. The PDF may be unclear or unsupported.'
      : (err.message || 'Failed to parse PDF');
    res.status(500).json({ success: false, error: message });
  }
});

// Lookup variants from Katana
app.post('/api/lookup-variants', checkAuth, async (req, res) => {
  try {
    const { katanaApiKey } = req.body;
    if (!katanaApiKey) {
      return res.status(400).json({ success: false, error: 'Katana API key required' });
    }

    const variants = await getCachedVariants(katanaApiKey);
    // Return simplified variant objects for the frontend
    // Name comes from joined product data (_product_name)
    const simplified = variants.map(v => ({
      id: v.id,
      sku: v.sku || '',
      name: v._product_name || v.sku || `variant-${v.id}`,
      sales_price: v.sales_price || 0,
      internal_barcode: v.internal_barcode || '',
    }));

    res.json({ success: true, variants: simplified });

  } catch (err) {
    console.error('Lookup variants error:', err);
    let message = 'Failed to fetch variants';
    if (err.status === 401) message = 'Invalid Katana API key';
    else if (err.code === 'ETIMEDOUT' || err.code === 'ECONNABORTED') message = 'Connection to Katana API timed out. Please try again.';
    else if (err.body?.error) message = err.body.error;
    res.status(err.status || 500).json({ success: false, error: message });
  }
});

// Create Sales Order in Katana
app.post('/api/create-so', checkAuth, async (req, res) => {
  try {
    const {
      katanaApiKey,
      customer_name,
      order_date,
      delivery_date,
      reference_number,
      currency,
      notes,
      line_items,
    } = req.body;

    if (!katanaApiKey) {
      return res.status(400).json({ success: false, error: 'Katana API key required' });
    }
    if (!customer_name) {
      return res.status(400).json({ success: false, error: 'Customer name required' });
    }
    if (!line_items || line_items.length === 0) {
      return res.status(400).json({ success: false, error: 'At least one line item required' });
    }

    // 1. Find or create customer
    const { customer, created: customerCreated } = await findOrCreateCustomer(katanaApiKey, customer_name);

    // 2. Build SO rows (only items with variant_id)
    const warnings = [];
    const soRows = [];

    for (const item of line_items) {
      if (!item.variant_id) {
        warnings.push(`"${item.product_name || item.sku}" skipped — no variant matched`);
        continue;
      }
      soRows.push({
        variant_id: item.variant_id,
        quantity: item.quantity || 1,
        price_per_unit: item.unit_price || 0,
      });
    }

    if (soRows.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'No line items have matched variants. Match at least one item to a Katana variant.',
        warnings,
      });
    }

    // 3. Build SO payload
    const soPayload = {
      customer_id: customer.id,
      sales_order_rows: soRows,
    };

    if (delivery_date) soPayload.delivery_date = delivery_date;
    if (reference_number) soPayload.customer_ref = reference_number;
    if (notes) soPayload.additional_info = notes;
    if (currency) soPayload.currency = currency;
    if (order_date) soPayload.order_created_date = order_date;

    // 4. Create the Sales Order
    const salesOrder = await katanaRequest(katanaApiKey, 'POST', '/sales_orders', soPayload);

    res.json({
      success: true,
      sales_order: salesOrder,
      customer: { id: customer.id, name: customer.name, created: customerCreated },
      warnings,
      rows_created: soRows.length,
      rows_skipped: line_items.length - soRows.length,
    });

  } catch (err) {
    console.error('Create SO error:', err);
    const message = err.status === 401
      ? 'Invalid Katana API key'
      : (err.body?.errors?.[0]?.message || err.body?.error || err.message || 'Failed to create Sales Order');
    res.status(err.status || 500).json({ success: false, error: message, details: err.body });
  }
});

// ─── Start Server ────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`PDFtoSO running at http://localhost:${PORT}`);
});
