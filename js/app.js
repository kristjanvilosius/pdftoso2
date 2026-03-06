/* ═══════════════════════════════════════════════════════════════════════════ */
/* PDFtoSO — Frontend Logic                                                   */
/* ═══════════════════════════════════════════════════════════════════════════ */

// ─── State ───────────────────────────────────────────────────────────────────

const state = {
  password: null,
  anthropicApiKey: null,
  katanaApiKey: null,
  pdfFile: null,
  parsedData: null,
  variants: [],
  variantsLoaded: false,
  lineItems: [],       // Enriched with match info
};

// ─── Screen Management ───────────────────────────────────────────────────────

function showScreen(name) {
  document.querySelectorAll('.screen').forEach(el => el.classList.remove('active'));
  document.getElementById('screen-' + name).classList.add('active');
}

// ─── Loading Overlay ─────────────────────────────────────────────────────────

function showLoading(text, steps = []) {
  const overlay = document.getElementById('loading-overlay');
  document.getElementById('loading-text').textContent = text;

  const stepsEl = document.getElementById('loading-steps');
  stepsEl.innerHTML = steps.map((s, i) =>
    `<div class="loading-step" id="lstep-${i}">${s}</div>`
  ).join('');

  overlay.classList.remove('hidden');
}

function updateLoadingStep(index) {
  // Mark previous steps as done
  for (let i = 0; i < index; i++) {
    const el = document.getElementById('lstep-' + i);
    if (el) { el.classList.remove('active'); el.classList.add('done'); }
  }
  // Mark current step as active
  const el = document.getElementById('lstep-' + index);
  if (el) el.classList.add('active');
}

function hideLoading() {
  // Mark all steps done before hiding
  document.querySelectorAll('.loading-step').forEach(el => {
    el.classList.remove('active');
    el.classList.add('done');
  });
  setTimeout(() => {
    document.getElementById('loading-overlay').classList.add('hidden');
  }, 400);
}

// ─── API Helpers ─────────────────────────────────────────────────────────────

async function api(endpoint, options = {}) {
  const headers = { 'x-password': state.password, ...options.headers };
  const res = await fetch(endpoint, { ...options, headers });
  const json = await res.json();
  if (!json.success) throw new Error(json.error || 'Request failed');
  return json;
}

// ─── Auth ────────────────────────────────────────────────────────────────────

function initAuth() {
  const input = document.getElementById('password-input');
  const btn = document.getElementById('btn-auth');
  const error = document.getElementById('auth-error');

  function tryAuth() {
    const pw = input.value.trim();
    if (!pw) return;
    state.password = pw;
    error.classList.add('hidden');
    showScreen('upload');
  }

  btn.addEventListener('click', tryAuth);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') tryAuth();
  });
}

// ─── File Upload ─────────────────────────────────────────────────────────────

function initUpload() {
  const dropZone = document.getElementById('drop-zone');
  const fileInput = document.getElementById('file-input');
  const preview = document.getElementById('file-preview');
  const fileName = document.getElementById('file-name');
  const fileSize = document.getElementById('file-size');
  const removeBtn = document.getElementById('btn-remove-file');
  const parseBtn = document.getElementById('btn-parse');
  const anthropicInput = document.getElementById('anthropic-key');
  const katanaInput = document.getElementById('katana-key');

  function updateParseBtn() {
    parseBtn.disabled = !(state.pdfFile && anthropicInput.value.trim() && katanaInput.value.trim());
  }

  function selectFile(file) {
    if (!file || file.type !== 'application/pdf') return;
    state.pdfFile = file;
    fileName.textContent = file.name;
    fileSize.textContent = formatSize(file.size);
    dropZone.classList.add('hidden');
    preview.classList.remove('hidden');
    updateParseBtn();
  }

  function clearFile() {
    state.pdfFile = null;
    fileInput.value = '';
    dropZone.classList.remove('hidden');
    preview.classList.add('hidden');
    updateParseBtn();
  }

  // Click to browse
  dropZone.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    if (fileInput.files[0]) selectFile(fileInput.files[0]);
  });

  // Drag and drop
  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('drag-over');
  });
  dropZone.addEventListener('dragleave', () => {
    dropZone.classList.remove('drag-over');
  });
  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    if (e.dataTransfer.files[0]) selectFile(e.dataTransfer.files[0]);
  });

  removeBtn.addEventListener('click', clearFile);
  anthropicInput.addEventListener('input', updateParseBtn);
  katanaInput.addEventListener('input', updateParseBtn);

  // Parse button
  parseBtn.addEventListener('click', async () => {
    state.anthropicApiKey = anthropicInput.value.trim();
    state.katanaApiKey = katanaInput.value.trim();
    await parsePDF();
  });
}

// ─── Parse PDF ───────────────────────────────────────────────────────────────

async function parsePDF() {
  const steps = [
    'Uploading PDF to AI parser...',
    'Analyzing document structure...',
    'Extracting fields and line items...',
    'Loading Katana product catalog...',
    'Matching SKUs to variants...',
  ];

  showLoading('Parsing document with AI', steps);

  try {
    // Step 1-3: Parse PDF
    updateLoadingStep(0);
    const formData = new FormData();
    formData.append('pdf', state.pdfFile);
    formData.append('anthropicApiKey', state.anthropicApiKey);

    await sleep(300);
    updateLoadingStep(1);

    const result = await fetch('/api/parse-pdf', {
      method: 'POST',
      headers: { 'x-password': state.password },
      body: formData,
    });

    const parsed = await result.json();

    if (!parsed.success) {
      throw new Error(parsed.error || 'Failed to parse PDF');
    }

    updateLoadingStep(2);
    state.parsedData = parsed.data;

    // Step 4: Load variants
    await sleep(200);
    updateLoadingStep(3);

    if (!state.variantsLoaded) {
      const varResult = await api('/api/lookup-variants', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ katanaApiKey: state.katanaApiKey }),
      });
      state.variants = varResult.variants || [];
      state.variantsLoaded = true;
    }

    // Step 5: Match variants
    updateLoadingStep(4);
    state.lineItems = matchVariants(parsed.data.line_items || []);

    await sleep(300);
    hideLoading();
    await sleep(500);

    renderReviewScreen();
    showScreen('review');

  } catch (err) {
    hideLoading();
    alert('Error: ' + err.message);
  }
}

// ─── Variant Matching ────────────────────────────────────────────────────────

function matchVariants(items) {
  return items.map(item => {
    let match = null;
    let matchType = 'none';
    let candidates = [];

    const searchSku = (item.sku || '').toLowerCase().trim();
    const searchName = (item.product_name || '').toLowerCase().trim();

    // 1. Exact SKU match (also check internal_barcode)
    if (searchSku) {
      match = state.variants.find(v =>
        (v.sku && v.sku.toLowerCase().trim() === searchSku) ||
        (v.internal_barcode && v.internal_barcode.toLowerCase().trim() === searchSku)
      );
      if (match) {
        return { ...item, variant_id: match.id, match, matchType: 'exact', candidates: [] };
      }
    }

    // 2. Exact product name match
    if (searchName) {
      match = state.variants.find(v =>
        v.name && v.name.toLowerCase().trim() === searchName
      );
      if (match) {
        return { ...item, variant_id: match.id, match, matchType: 'exact', candidates: [] };
      }
    }

    // 3. Fuzzy SKU match (contains, Levenshtein)
    if (searchSku) {
      candidates = state.variants.filter(v => {
        const vSku = (v.sku || '').toLowerCase();
        const vBarcode = (v.internal_barcode || '').toLowerCase();
        return (vSku && (vSku.includes(searchSku) || searchSku.includes(vSku) || levenshtein(vSku, searchSku) <= 2)) ||
               (vBarcode && (vBarcode.includes(searchSku) || searchSku.includes(vBarcode)));
      }).slice(0, 10);

      if (candidates.length === 1) {
        return { ...item, variant_id: candidates[0].id, match: candidates[0], matchType: 'fuzzy', candidates };
      }
      if (candidates.length > 1) {
        return { ...item, variant_id: candidates[0].id, match: candidates[0], matchType: 'fuzzy', candidates };
      }
    }

    // 4. Product name token match
    if (searchName) {
      const tokens = searchName.split(/[\s,\-_\/]+/).filter(t => t.length > 2);
      if (tokens.length > 0) {
        const scored = state.variants.map(v => {
          const text = `${v.sku || ''} ${v.name || ''}`.toLowerCase();
          const score = tokens.filter(t => text.includes(t)).length;
          return { variant: v, score };
        }).filter(s => s.score >= 1)
          .sort((a, b) => b.score - a.score)
          .slice(0, 10);

        if (scored.length > 0) {
          candidates = scored.map(s => s.variant);
          match = candidates[0];
          matchType = 'fuzzy';
        }
      }
    }

    return { ...item, variant_id: match?.id || null, match, matchType, candidates };
  });
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const d = Array.from({ length: m + 1 }, (_, i) => [i]);
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      d[i][j] = a[i - 1] === b[j - 1]
        ? d[i - 1][j - 1]
        : 1 + Math.min(d[i - 1][j], d[i][j - 1], d[i - 1][j - 1]);
    }
  }
  return d[m][n];
}

// ─── Review Screen ───────────────────────────────────────────────────────────

function renderReviewScreen() {
  const data = state.parsedData;

  // Populate header fields
  document.getElementById('field-customer').value = data.customer_name || '';
  document.getElementById('field-reference').value = data.reference_number || '';
  document.getElementById('field-order-date').value = data.order_date || '';
  document.getElementById('field-delivery-date').value = data.delivery_date || '';
  document.getElementById('field-notes').value = data.notes || '';

  if (data.currency) {
    const sel = document.getElementById('field-currency');
    const opt = sel.querySelector(`option[value="${data.currency}"]`);
    if (opt) sel.value = data.currency;
  }

  renderLineItems();
}

function renderLineItems() {
  const tbody = document.getElementById('line-items-body');
  tbody.innerHTML = '';

  state.lineItems.forEach((item, i) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="row-num">${i + 1}</td>
      <td><input type="text" class="input" value="${esc(item.product_name || '')}" data-idx="${i}" data-field="product_name"></td>
      <td><input type="text" class="input" value="${esc(item.sku || '')}" data-idx="${i}" data-field="sku"></td>
      <td><input type="number" class="input" value="${item.quantity || 1}" min="1" data-idx="${i}" data-field="quantity"></td>
      <td><input type="number" class="input" value="${item.unit_price || 0}" min="0" step="0.01" data-idx="${i}" data-field="unit_price"></td>
      <td>${renderMatchCell(item, i)}</td>
      <td><button class="btn-icon" data-remove="${i}" title="Remove row">&times;</button></td>
    `;
    tbody.appendChild(tr);
  });

  // Bind input changes
  tbody.querySelectorAll('input[data-field]').forEach(input => {
    input.addEventListener('change', (e) => {
      const idx = parseInt(e.target.dataset.idx);
      const field = e.target.dataset.field;
      let val = e.target.value;
      if (field === 'quantity') val = parseInt(val) || 1;
      if (field === 'unit_price') val = parseFloat(val) || 0;
      state.lineItems[idx][field] = val;
    });
  });

  // Bind variant selects
  tbody.querySelectorAll('.variant-select').forEach(sel => {
    sel.addEventListener('change', (e) => {
      const idx = parseInt(e.target.dataset.idx);
      const varId = e.target.value ? parseInt(e.target.value) : null;
      const variant = state.variants.find(v => v.id === varId);
      state.lineItems[idx].variant_id = varId;
      state.lineItems[idx].match = variant || null;
      state.lineItems[idx].matchType = varId ? 'exact' : 'none';
      renderLineItems(); // Re-render to update badges
    });
  });

  // Bind remove buttons
  tbody.querySelectorAll('[data-remove]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const idx = parseInt(e.target.dataset.remove);
      state.lineItems.splice(idx, 1);
      renderLineItems();
    });
  });

  updateMatchSummary();
  updateCreateButton();
}

function renderMatchCell(item, idx) {
  if (item.matchType === 'exact') {
    return `<span class="match-badge match-exact">&#10003; ${esc(item.match.sku)}</span>`;
  }

  if (item.matchType === 'fuzzy' && item.candidates.length > 0) {
    const options = item.candidates.map(c =>
      `<option value="${c.id}" ${c.id === item.variant_id ? 'selected' : ''}>${esc(c.sku)} — ${esc(c.name)}</option>`
    ).join('');
    return `
      <span class="match-badge match-fuzzy">~ Possible match</span>
      <select class="variant-select" data-idx="${idx}">
        ${options}
        <option value="">— None —</option>
      </select>
    `;
  }

  // No match — show full searchable dropdown
  const options = state.variants.map(c =>
    `<option value="${c.id}" ${c.id === item.variant_id ? 'selected' : ''}>${esc(c.sku)} — ${esc(c.name)}</option>`
  ).join('');
  return `
    <span class="match-badge match-none">&#10007; No match</span>
    <select class="variant-select" data-idx="${idx}">
      <option value="">— Select variant —</option>
      ${options}
    </select>
  `;
}

function updateMatchSummary() {
  const el = document.getElementById('match-summary');
  const total = state.lineItems.length;
  const matched = state.lineItems.filter(i => i.variant_id).length;

  if (total === 0) {
    el.classList.add('hidden');
    return;
  }

  el.classList.remove('hidden');
  if (matched === total) {
    el.className = 'match-summary all-matched';
    el.textContent = `All ${total} items matched to Katana variants.`;
  } else {
    el.className = 'match-summary partial';
    el.textContent = `${matched} of ${total} items matched. Unmatched items will be skipped when creating the SO.`;
  }
}

function updateCreateButton() {
  const btn = document.getElementById('btn-create-so');
  const hasCustomer = document.getElementById('field-customer').value.trim();
  const hasMatched = state.lineItems.some(i => i.variant_id);
  btn.disabled = !(hasCustomer && hasMatched);
}

// ─── Add Row ─────────────────────────────────────────────────────────────────

function initAddRow() {
  document.getElementById('btn-add-row').addEventListener('click', () => {
    state.lineItems.push({
      product_name: '',
      sku: '',
      quantity: 1,
      unit_price: 0,
      variant_id: null,
      match: null,
      matchType: 'none',
      candidates: [],
    });
    renderLineItems();
  });
}

// ─── Create Sales Order ──────────────────────────────────────────────────────

function initCreateSO() {
  document.getElementById('btn-create-so').addEventListener('click', createSalesOrder);
}

async function createSalesOrder() {
  const steps = [
    'Looking up customer in Katana...',
    'Creating Sales Order...',
    'Confirming order details...',
  ];

  showLoading('Creating Sales Order', steps);

  try {
    updateLoadingStep(0);
    await sleep(300);

    const payload = {
      katanaApiKey: state.katanaApiKey,
      customer_name: document.getElementById('field-customer').value.trim(),
      order_date: document.getElementById('field-order-date').value || null,
      delivery_date: document.getElementById('field-delivery-date').value || null,
      reference_number: document.getElementById('field-reference').value.trim() || null,
      currency: document.getElementById('field-currency').value,
      notes: document.getElementById('field-notes').value.trim() || null,
      line_items: state.lineItems.map(item => ({
        product_name: item.product_name,
        sku: item.sku,
        quantity: item.quantity,
        unit_price: item.unit_price,
        variant_id: item.variant_id,
      })),
    };

    updateLoadingStep(1);

    const result = await api('/api/create-so', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    updateLoadingStep(2);
    await sleep(400);

    hideLoading();
    await sleep(500);

    renderSuccess(result);
    showScreen('success');

  } catch (err) {
    hideLoading();
    alert('Error creating Sales Order: ' + err.message);
  }
}

// ─── Success Screen ──────────────────────────────────────────────────────────

function renderSuccess(result) {
  const details = document.getElementById('success-details');
  const so = result.sales_order || {};
  const customer = result.customer || {};

  let html = '';
  if (so.order_no) {
    html += `<div><span class="detail-label">Order Number</span><br><span class="detail-value">${esc(so.order_no)}</span></div>`;
  }
  if (so.id) {
    html += `<div><span class="detail-label">Katana SO ID</span><br><span class="detail-value">${so.id}</span></div>`;
  }
  html += `<div><span class="detail-label">Customer</span><br><span class="detail-value">${esc(customer.name || '')}${customer.created ? ' (new)' : ''}</span></div>`;
  html += `<div><span class="detail-label">Items</span><br><span class="detail-value">${result.rows_created || 0} created, ${result.rows_skipped || 0} skipped</span></div>`;

  if (result.warnings && result.warnings.length > 0) {
    html += `<div class="detail-warning">Warnings:<br>${result.warnings.map(w => '• ' + esc(w)).join('<br>')}</div>`;
  }

  details.innerHTML = html;
}

function initSuccess() {
  document.getElementById('btn-upload-another').addEventListener('click', () => {
    // Reset parse state but keep API key and password
    state.pdfFile = null;
    state.parsedData = null;
    state.lineItems = [];

    // Reset file input UI
    document.getElementById('file-input').value = '';
    document.getElementById('drop-zone').classList.remove('hidden');
    document.getElementById('file-preview').classList.add('hidden');
    document.getElementById('btn-parse').disabled = true;

    showScreen('upload');
  });
}

// ─── Back button ─────────────────────────────────────────────────────────────

function initBackButton() {
  document.getElementById('btn-back-upload').addEventListener('click', () => {
    showScreen('upload');
  });
}

// ─── Customer field change listener ──────────────────────────────────────────

function initFieldListeners() {
  document.getElementById('field-customer').addEventListener('input', updateCreateButton);
}

// ─── Utilities ───────────────────────────────────────────────────────────────

function esc(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Init ────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  initAuth();
  initUpload();
  initAddRow();
  initCreateSO();
  initSuccess();
  initBackButton();
  initFieldListeners();
});
