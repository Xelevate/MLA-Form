/* ================================================================
   MLA Transfer Intake — app.js
   - Parses unstructured customer text into structured fields
   - DNC sheet check against Google Sheet (live fetch)
   - Card format validation (Luhn + brand detection — same math as
     stevemorse.org/ssn/cc.html)
   - Builds pre-filled Google Form URL and opens in new tab
================================================================ */

const DNC_SHEET_URL =
  'https://docs.google.com/spreadsheets/d/1tftqIjhDt7PLWPMT6OuXZU3Et2a-KGMNbKu7l7oRdSU/gviz/tq?tqx=out:csv&gid=0';

const FORM_VIEW_URL =
  'https://docs.google.com/forms/d/e/1FAIpQLSf4fudshUOpniPJ2jTLRo8DxGc2WkWDRDJRCwW22nNkrwM2_g/viewform';

const STATE_ABBR = {
  alabama:'AL', alaska:'AK', arizona:'AZ', arkansas:'AR', california:'CA',
  colorado:'CO', connecticut:'CT', delaware:'DE', florida:'FL', georgia:'GA',
  hawaii:'HI', idaho:'ID', illinois:'IL', indiana:'IN', iowa:'IA', kansas:'KS',
  kentucky:'KY', louisiana:'LA', maine:'ME', maryland:'MD', massachusetts:'MA',
  michigan:'MI', minnesota:'MN', mississippi:'MS', missouri:'MO', montana:'MT',
  nebraska:'NE', nevada:'NV', 'new hampshire':'NH', 'new jersey':'NJ',
  'new mexico':'NM', 'new york':'NY', 'north carolina':'NC', 'north dakota':'ND',
  ohio:'OH', oklahoma:'OK', oregon:'OR', pennsylvania:'PA', 'rhode island':'RI',
  'south carolina':'SC', 'south dakota':'SD', tennessee:'TN', texas:'TX',
  utah:'UT', vermont:'VT', virginia:'VA', washington:'WA', 'west virginia':'WV',
  wisconsin:'WI', wyoming:'WY', 'district of columbia':'DC'
};
const STATE_CODES = new Set(Object.values(STATE_ABBR));

const RELATIONSHIPS = [
  'daughter','son','wife','husband','mother','father','mom','dad','sister',
  'brother','niece','nephew','aunt','uncle','cousin','friend','grandson',
  'granddaughter','grandmother','grandfather','partner','spouse','neighbor',
  'caregiver','caretaker','guardian','parent','child','sibling','in-law'
];

/* ---------------- helpers ---------------- */
function $(id) { return document.getElementById(id); }
function normalizePhone(s) {
  if (!s) return '';
  const d = String(s).replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('1')) return d.slice(1);
  return d;
}
function fmtPhone(p) {
  const d = normalizePhone(p);
  if (d.length !== 10) return p;
  return `(${d.slice(0,3)}) ${d.slice(3,6)}-${d.slice(6)}`;
}

/* ---------------- parsing ---------------- */
const FIELDS = [
  ['phone',           'Phone'],
  ['device',          'Device'],
  ['firstName',       'First name'],
  ['lastName',        'Last name'],
  ['dob',             'Date of birth'],
  ['address',         'Street address'],
  ['city',            'City'],
  ['state',           'State'],
  ['zip',             'Zip'],
  ['emergFirst',      'Emergency 1st'],
  ['emergLast',       'Emergency last'],
  ['emergPhone',      'Emergency phone'],
  ['emergRel',        'Emergency relation'],
  ['paymentMethod',   'Payment method'],
  ['cardType',        'Card type'],
  ['cardNumber',      'Card number'],
  ['expDate',         'Exp date'],
  ['cvv',             'CVV'],
  ['billingDate',     'Billing date'],
  ['firstTime',       'First-time device'],
];

const REQUIRED_FIELDS = [
  'phone','device','firstName','lastName','dob','address','city','state','zip',
  'paymentMethod','cardNumber','expDate','cvv','billingDate','firstTime'
];

function parseText(raw) {
  const out = {};
  if (!raw) return out;
  const text = raw.replace(/\u00A0/g, ' ');
  const lower = text.toLowerCase();

  /* ---- phones: capture all then split into main vs emergency ---- */
  const allPhones = [];
  const phoneRe = /(\+?1[\s\-.()]*)?\(?(\d{3})\)?[\s\-.]?(\d{3})[\s\-.]?(\d{4})/g;
  let pm;
  while ((pm = phoneRe.exec(text)) !== null) {
    const num = pm[2] + pm[3] + pm[4];
    // skip if this is actually part of a longer digit sequence (card)
    const before = text[pm.index - 1];
    const after = text[pm.index + pm[0].length];
    if (before && /\d/.test(before)) continue;
    if (after && /\d/.test(after)) continue;
    allPhones.push({ value: num, index: pm.index, raw: pm[0] });
  }

  /* labeled emergency phone first */
  let emergPhoneIdx = -1;
  const emergLabelRe = /emergency[^a-z0-9]*(?:contact)?[^a-z0-9]*(?:phone|number|#|cell|tel)/i;
  const emLabel = text.search(emergLabelRe);
  if (emLabel >= 0) {
    // find first phone within ~50 chars after the label
    const cand = allPhones.find(p => p.index >= emLabel && p.index <= emLabel + 80);
    if (cand) {
      out.emergPhone = cand.value;
      emergPhoneIdx = allPhones.indexOf(cand);
    }
  }
  /* main phone: first unconsumed phone */
  for (let i = 0; i < allPhones.length; i++) {
    if (i === emergPhoneIdx) continue;
    if (!out.phone) { out.phone = allPhones[i].value; continue; }
    if (!out.emergPhone) { out.emergPhone = allPhones[i].value; }
  }

  /* ---- device ---- */
  if (/necklace/i.test(text)) out.device = 'Necklace $39.95';
  else if (/smart\s*watch|smartwatch|watch/i.test(text)) out.device = 'Smartwatch $44.95$';

  /* ---- dob ---- */
  const dobLabel = text.match(/(?:dob|date\s*of\s*birth|birth\s*date|born)[^a-z0-9\/.-]*([0-9]{1,2}[\/\-.][0-9]{1,2}[\/\-.][0-9]{2,4}|[0-9]{4}[\/\-.][0-9]{1,2}[\/\-.][0-9]{1,2})/i);
  if (dobLabel) out.dob = dobLabel[1];
  else {
    // bare date pattern with year that's plausibly a birth year (< current year - 18)
    const dateMatches = [
      ...text.matchAll(/\b([0-9]{1,2})[\/\-.]([0-9]{1,2})[\/\-.]([0-9]{2,4})\b/g),
      ...text.matchAll(/\b([0-9]{4})[\/\-.]([0-9]{1,2})[\/\-.]([0-9]{1,2})\b/g)
    ];
    const thisYear = new Date().getFullYear();
    for (const m of dateMatches) {
      let yr = m[3].length === 4 ? parseInt(m[3], 10) : (m[1].length === 4 ? parseInt(m[1], 10) : parseInt(m[3], 10));
      if (yr < 100) yr += yr < 30 ? 2000 : 1900;
      if (yr >= 1900 && yr <= thisYear - 18) {
        out.dob = m[0]; break;
      }
    }
  }

  /* ---- card number ---- */
  // card label first
  const cardLabel = text.match(/(?:card\s*(?:number|#|no)|cc\s*#?|card[:\s]+)\s*([\d\s\-]{12,25})/i);
  if (cardLabel) {
    const d = cardLabel[1].replace(/\D/g, '');
    if (d.length >= 13 && d.length <= 19) out.cardNumber = d;
  }
  if (!out.cardNumber) {
    // any 13–19 digit run, allowing spaces/dashes
    const ccRe = /\b(?:\d[ \-]?){13,19}\b/g;
    const ccMatch = text.match(ccRe);
    if (ccMatch) {
      for (const m of ccMatch) {
        const d = m.replace(/\D/g, '');
        if (d.length >= 13 && d.length <= 19) { out.cardNumber = d; break; }
      }
    }
  }

  /* ---- exp date MM/YY ---- */
  const expLabel = text.match(/(?:exp(?:iration)?\s*(?:date)?|expires?)[:\s]*([01]?\d[\/\-][0-9]{2,4})/i);
  if (expLabel) out.expDate = expLabel[1].replace(/-/g, '/');
  else {
    const expRe = /\b(0[1-9]|1[0-2])\/([0-9]{2}|2[0-9]{3}|3[0-9]{3})\b/;
    const m = text.match(expRe);
    if (m) {
      let yr = m[2];
      if (yr.length === 4) yr = yr.slice(2);
      out.expDate = `${m[1]}/${yr}`;
    }
  }

  /* ---- cvv ---- */
  const cvvLabel = text.match(/(?:cvv|cvc|security\s*code|cv2)[:\s]*([0-9]{3,4})/i);
  if (cvvLabel) out.cvv = cvvLabel[1];

  /* ---- card type ---- */
  if (/master\s*card|mastercard/i.test(text)) out.cardType = 'Master';
  else if (/\bvisa\b/i.test(text)) out.cardType = 'Visa';
  else if (/amex|american\s*express/i.test(text)) out.cardType = 'American express';
  else if (/discover/i.test(text)) out.cardType = 'discover';
  else if (out.cardNumber) {
    const c = out.cardNumber;
    if (/^4/.test(c)) out.cardType = 'Visa';
    else if (/^(5[1-5]|2[2-7])/.test(c)) out.cardType = 'Master';
    else if (/^3[47]/.test(c)) out.cardType = 'American express';
    else if (/^6(?:011|5)/.test(c)) out.cardType = 'discover';
  }

  /* ---- payment method ---- */
  if (/credit\s*card|debit\s*card|\bcard\b/i.test(text) || out.cardNumber)
    out.paymentMethod = 'Bank card';
  else if (/bank\s*account|checking|savings/i.test(text))
    out.paymentMethod = 'Bank account';

  /* ---- billing date ---- */
  const billLabel = text.match(/billing\s*(?:date|day|cycle)?[:\s]*([0-9]{1,2})(?:st|nd|rd|th)?/i);
  if (billLabel && parseInt(billLabel[1],10) >= 1 && parseInt(billLabel[1],10) <= 31) {
    out.billingDate = billLabel[1];
  } else {
    const dayWord = text.match(/\b([0-9]{1,2})(st|nd|rd|th)\b/i);
    if (dayWord) out.billingDate = dayWord[1];
  }

  /* ---- first time ---- */
  const ft = text.match(/first\s*time[^a-z0-9]*(?:getting\s*a\s*device)?[^a-z]*(yes|no|y|n)\b/i);
  if (ft) out.firstTime = /^y/i.test(ft[1]) ? 'Yes' : 'No';

  /* ---- emergency contact name & relation ---- */
  // pattern A: "Lisa Lefebvre - daughter" or "Lisa Lefebvre, daughter"
  const rels = RELATIONSHIPS.join('|');
  const ecPat = new RegExp(`([A-Z][a-zA-Z'’\\-]+(?:[ \\t]+[A-Z][a-zA-Z'’\\-]+)+)\\s*[,\\-:–—]\\s*(${rels})`, 'i');
  let ecMatch = text.match(ecPat);
  // pattern B: "daughter Lisa Lefebvre"
  if (!ecMatch) {
    const relPat = new RegExp(`(${rels})[ \\t]+([A-Z][a-zA-Z'’\\-]+(?:[ \\t]+[A-Z][a-zA-Z'’\\-]+)+)`, 'i');
    const m = text.match(relPat);
    if (m) ecMatch = [m[0], m[2], m[1]];
  }
  // pattern C: explicit label "emergency contact: Lisa Lefebvre - daughter"
  const ecLabel = text.match(/emergency\s*(?:contact)?[:\s\-]*([A-Z][a-zA-Z'’\-\s]+?)(?:\s*[,\-:–—]\s*(\w+))?(?=\n|$|emergency|phone|\d)/i);
  if (!ecMatch && ecLabel) {
    const nameParts = ecLabel[1].trim().split(/\s+/);
    if (nameParts.length >= 2) ecMatch = [ecLabel[0], nameParts.slice(0,2).join(' '), ecLabel[2] || ''];
  }
  if (ecMatch) {
    const parts = ecMatch[1].trim().split(/\s+/);
    out.emergFirst = parts[0];
    out.emergLast = parts.slice(1).join(' ');
    if (ecMatch[2]) out.emergRel = ecMatch[2].toLowerCase();
  }

  /* ---- customer name (first + last) ---- */
  // try labeled — stop at line break, comma, or next field-looking word
  const nameLabel = text.match(/(?:customer\s*name|client\s*name|full\s*name|^\s*name)[:\s]+([A-Z][a-zA-Z'’\-]+(?:[ \t]+[A-Z][a-zA-Z'’\-]+){1,2})(?=\s*(?:\n|,|;|$|\s+(?:date|dob|address|phone|device|emerg|payment|card|exp|cvv|billing|first)))/im);
  if (nameLabel) {
    const parts = nameLabel[1].trim().split(/\s+/);
    out.firstName = parts[0];
    out.lastName = parts.slice(1).join(' ');
  } else {
    // any capitalized 2-word name that ISN'T the emergency contact or a known noise word
    const NOISE = new Set(['Necklace','Smartwatch','Visa','Master','Mastercard','American','Express','Discover','Bank','Credit','Debit','Card','First','Last','Date','Emergency','Phone','Address','Billing','Payment','Exp','CVV','Cvv','City','State','Zip','Yes','No','Customer','Client','Saint','Mount']);
    const nameRe = /\b([A-Z][a-z'’\-]+)[ \t]+([A-Z][a-zA-Z'’\-]+(?:[ \t]+[A-Z][a-zA-Z'’\-]+)?)\b/g;
    let nm;
    while ((nm = nameRe.exec(text)) !== null) {
      const full = `${nm[1]} ${nm[2]}`;
      if (out.emergFirst && nm[1] === out.emergFirst) continue;
      if (STATE_ABBR[full.toLowerCase()]) continue;
      if (RELATIONSHIPS.includes(nm[1].toLowerCase())) continue;
      if (NOISE.has(nm[1])) continue;
      if (NOISE.has(nm[2].split(/\s+/)[0])) continue;
      // skip city/state context — if followed by 2-letter state code or 5-digit zip in next 30 chars
      const trailing = text.slice(nm.index + nm[0].length, nm.index + nm[0].length + 30);
      if (/^\s*,?\s*[A-Z]{2}\b/.test(trailing) || /^\s*,?\s*\d{5}/.test(trailing)) continue;
      out.firstName = nm[1];
      out.lastName = nm[2];
      break;
    }
  }

  /* ---- address / city / state / zip ---- */
  // zip
  const zip = text.match(/\b(\d{5})(-\d{4})?\b/g);
  if (zip) {
    // prefer the one not in a phone or card
    for (const z of zip) {
      // make sure this 5-digit run isn't part of a longer one
      const idx = text.indexOf(z);
      const before = text[idx - 1];
      const after = text[idx + z.length];
      if (before && /\d/.test(before)) continue;
      if (after && /\d/.test(after) && z.length === 5) continue;
      out.zip = z.split('-')[0];
      break;
    }
  }

  // state (full word or abbr) — find one followed by zip if possible
  if (out.zip) {
    const beforeZip = text.slice(0, text.indexOf(out.zip)).slice(-60);
    // 2-letter code
    const abbr = beforeZip.match(/\b([A-Z]{2})\b\s*,?\s*$/);
    if (abbr && STATE_CODES.has(abbr[1])) out.state = abbr[1];
    if (!out.state) {
      for (const [full, ab] of Object.entries(STATE_ABBR)) {
        const re = new RegExp(`\\b${full}\\b`, 'i');
        if (re.test(beforeZip)) { out.state = ab; break; }
      }
    }
    // city = the token before the state, before the comma — must be capitalized words only
    if (out.state) {
      const stateIdx = beforeZip.toLowerCase().lastIndexOf(out.state.toLowerCase());
      const cityChunk = beforeZip.slice(0, stateIdx).trim().replace(/,$/, '').trim();
      // city: last 1-3 capitalized words at end of chunk, separated by spaces only (no street type words)
      const STREET_WORDS = /\b(?:St|Street|Ave|Avenue|Rd|Road|Blvd|Boulevard|Dr|Drive|Ln|Lane|Way|Ct|Court|Pl|Place|Pkwy|Parkway|Ter|Terrace|Cir|Circle|Hwy|Highway|Sq|Square)\.?$/i;
      const STREET_WORD_ANY = /\b(St|Street|Ave|Avenue|Rd|Road|Blvd|Boulevard|Dr|Drive|Ln|Lane|Way|Ct|Court|Pl|Place|Pkwy|Parkway|Ter|Terrace|Cir|Circle|Hwy|Highway|Sq|Square)\.?\b/i;
      const cityMatch = cityChunk.match(/(?:^|[\s,])((?:[A-Z][a-zA-Z\.\-]+(?:\s+[A-Z][a-zA-Z\.\-]+){0,2}))$/);
      if (cityMatch && !STREET_WORDS.test(cityMatch[1])) {
        let words = cityMatch[1].split(/\s+/);
        // if multi-word and contains a street suffix, take only what's after it
        const sufIdx = words.findIndex(w => STREET_WORD_ANY.test(w));
        if (sufIdx >= 0 && sufIdx < words.length - 1) {
          words = words.slice(sufIdx + 1);
        }
        // remove a final word if it's a street-type word
        while (words.length > 1 && STREET_WORDS.test(words[words.length - 1])) words.pop();
        // remove leading words if they look like street suffix (e.g., "St")
        while (words.length > 1 && STREET_WORDS.test(words[0])) words.shift();
        // if the first word is a number or single letter, drop it
        while (words.length > 1 && /^\d|^.$/.test(words[0])) words.shift();
        if (words.length) out.city = words.join(' ');
      }
    }
  } else {
    // fallback: search anywhere
    for (const [full, ab] of Object.entries(STATE_ABBR)) {
      const re = new RegExp(`\\b${full}\\b`, 'i');
      if (re.test(text)) { out.state = ab; break; }
    }
  }

  // street address — look for line starting with a number that looks like a street
  const streetRe = /\b(\d{1,6}\s+[NSEW]?\.?\s*[A-Z][a-zA-Z\.\-'’]+(?:\s+[A-Z][a-zA-Z\.\-'’]+){0,4}\s+(?:St|Street|Ave|Avenue|Rd|Road|Blvd|Boulevard|Dr|Drive|Ln|Lane|Way|Ct|Court|Pl|Place|Pkwy|Parkway|Ter|Terrace|Cir|Circle|Hwy|Highway|Sq|Square)\.?)(?:\s*(?:Apt|Apartment|Suite|Ste|Unit|#)\.?\s*[\w\-]+)?\b/i;
  const street = text.match(streetRe);
  if (street) out.address = street[0].replace(/\s+/g,' ').trim();

  return out;
}

/* ---------------- card brand + Luhn ---------------- */
function detectBrand(num) {
  if (!num) return null;
  const c = num.replace(/\D/g,'');
  if (/^4\d{12}(\d{3}|\d{6})?$/.test(c)) return { name:'Visa', valid:true };
  if (/^(5[1-5]\d{14}|2(2[2-9]\d|2[3-9]\d{2}|[3-6]\d{3}|7[01]\d{2}|720\d)\d{10})$/.test(c)) return { name:'Mastercard', valid:true };
  if (/^3[47]\d{13}$/.test(c)) return { name:'American Express', valid:true };
  if (/^6(?:011|5\d{2}|4[4-9]\d|22(?:1(?:2[6-9]|[3-9]\d)|[2-8]\d{2}|9(?:[01]\d|2[0-5])))\d{10,13}$/.test(c)) return { name:'Discover', valid:true };
  if (/^(?:30[0-5]|3095|36|3[89])\d{12,15}$/.test(c)) return { name:'Diners Club', valid:true };
  if (/^35(?:2[89]|[3-8]\d)\d{12}$/.test(c)) return { name:'JCB', valid:true };
  return { name:'Unknown', valid:false };
}
function luhn(num) {
  if (!num) return false;
  const c = num.replace(/\D/g,'');
  if (c.length < 13 || c.length > 19) return false;
  let sum = 0, alt = false;
  for (let i = c.length - 1; i >= 0; i--) {
    let n = parseInt(c[i], 10);
    if (alt) { n *= 2; if (n > 9) n -= 9; }
    sum += n; alt = !alt;
  }
  return sum % 10 === 0;
}
function validateCard(num) {
  if (!num) return { ok:false, reason:'No card number' };
  const c = num.replace(/\D/g,'');
  const brand = detectBrand(c);
  const luhnOk = luhn(c);
  if (!brand.valid && !luhnOk) return { ok:false, reason:'Unrecognized brand & Luhn fail', brand:'?' };
  if (!luhnOk) return { ok:false, reason:'Fails Luhn checksum', brand: brand.name };
  return { ok:true, reason:`Verified · ${brand.name}`, brand: brand.name };
}
function validateExp(exp) {
  if (!exp) return false;
  const m = exp.match(/^(0?[1-9]|1[0-2])\/(\d{2}|\d{4})$/);
  if (!m) return false;
  let mo = parseInt(m[1],10);
  let yr = parseInt(m[2],10);
  if (yr < 100) yr += 2000;
  const now = new Date();
  const exDate = new Date(yr, mo, 0);
  return exDate >= new Date(now.getFullYear(), now.getMonth(), 1);
}

/* ---------------- DNC check ---------------- */
let DNC_CACHE = null;
let DNC_LOADING = null;
async function loadDNC() {
  if (DNC_CACHE) return DNC_CACHE;
  if (DNC_LOADING) return DNC_LOADING;
  DNC_LOADING = fetch(DNC_SHEET_URL)
    .then(r => {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.text();
    })
    .then(csv => {
      const set = new Set();
      const lines = csv.split(/\r?\n/);
      for (const line of lines) {
        // first column, strip quotes
        const cell = line.split(',')[0].replace(/^"|"$/g,'').trim();
        const d = normalizePhone(cell);
        if (d.length === 10) set.add(d);
      }
      DNC_CACHE = set;
      DNC_LOADING = null;
      return set;
    })
    .catch(err => {
      DNC_LOADING = null;
      throw err;
    });
  return DNC_LOADING;
}

/* ---------------- UI ---------------- */
let CURRENT = {};   // parsed result, with manual edits applied

function render() {
  const parsedEl = $('parsed');
  parsedEl.innerHTML = '';
  for (const [key, label] of FIELDS) {
    const row = document.createElement('div');
    row.className = 'row';
    const v = CURRENT[key] || '';
    let displayVal = v;
    if (key === 'phone' || key === 'emergPhone') {
      displayVal = v ? fmtPhone(v) : '';
    }
    const required = REQUIRED_FIELDS.includes(key);
    row.innerHTML = `
      <div class="label">${label}${required ? '<span style="color:var(--bad)">*</span>' : ''}</div>
      <input class="edit" data-k="${key}" value="${escapeHtml(displayVal)}" placeholder="${required ? '— missing —' : ''}" />
    `;
    parsedEl.appendChild(row);
  }
  // wire edits
  parsedEl.querySelectorAll('input.edit').forEach(inp => {
    inp.addEventListener('input', e => {
      const k = e.target.dataset.k;
      let val = e.target.value;
      if (k === 'phone' || k === 'emergPhone') val = normalizePhone(val);
      CURRENT[k] = val;
      runChecks();
    });
  });
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, m => ({
    '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'
  }[m]));
}

function setCheck(id, state, text, meta) {
  const el = $(id);
  el.className = 'check ' + state;
  el.querySelector('.text').textContent = text;
  const icon = state === 'good' ? '✓' : state === 'bad' ? '✕' : state === 'warn' ? '!' : '·';
  el.querySelector('.icon').textContent = icon;
  const metaEl = $(id + '-meta');
  if (metaEl) metaEl.textContent = meta || '';
}

async function runChecks() {
  // DNC
  const phone = normalizePhone(CURRENT.phone || '');
  let dncOk = false;
  if (!phone) {
    setCheck('chk-dnc', 'idle', 'Phone number required', '');
  } else if (phone.length !== 10) {
    setCheck('chk-dnc', 'bad', 'Phone must be 10 digits', phone.length + ' digits');
  } else {
    setCheck('chk-dnc', 'idle', 'Checking DNC list…', '');
    try {
      const set = await loadDNC();
      if (set.has(phone)) {
        setCheck('chk-dnc', 'bad', 'WARNING — number is listed in DNC', fmtPhone(phone));
      } else {
        setCheck('chk-dnc', 'good', 'Number not in DNC sheet', `${set.size} numbers checked`);
        dncOk = true;
      }
    } catch (err) {
      setCheck('chk-dnc', 'warn', 'Could not load DNC sheet', err.message);
    }
  }

  // CARD
  let cardOk = false;
  if (!CURRENT.cardNumber) {
    setCheck('chk-card', 'idle', 'Card number required', '');
  } else {
    const res = validateCard(CURRENT.cardNumber);
    const expOk = validateExp(CURRENT.expDate);
    if (res.ok && expOk) {
      setCheck('chk-card', 'good', 'Card format verified · ' + res.brand, mask(CURRENT.cardNumber));
      cardOk = true;
    } else if (res.ok && !expOk) {
      setCheck('chk-card', 'bad', 'Card valid but exp date is missing/expired', CURRENT.expDate || '');
    } else {
      setCheck('chk-card', 'bad', 'WARNING — card format is wrong', res.reason);
    }
  }

  // COMPLETE
  const missing = REQUIRED_FIELDS.filter(k => !CURRENT[k] || String(CURRENT[k]).trim() === '');
  let completeOk = false;
  if (missing.length === 0) {
    setCheck('chk-complete', 'good', 'All required fields present', `${REQUIRED_FIELDS.length}/${REQUIRED_FIELDS.length}`);
    completeOk = true;
  } else {
    setCheck('chk-complete', 'warn', `Missing: ${missing.map(k => FIELDS.find(f=>f[0]===k)[1]).join(', ')}`, `${REQUIRED_FIELDS.length - missing.length}/${REQUIRED_FIELDS.length}`);
  }

  // Action bar
  const allGood = dncOk && cardOk && completeOk;
  const cfgReady = (typeof FORM_CONFIG !== 'undefined') && FORM_CONFIG && FORM_CONFIG.entries && Object.keys(FORM_CONFIG.entries).length > 0;
  $('btn-open').disabled = !(allGood && cfgReady);

  const status = $('status-line');
  if (!cfgReady) {
    status.className = 'status';
    status.innerHTML = `<span class="dot"></span>Setup needed — configure form field IDs`;
  } else if (allGood) {
    status.className = 'status ready';
    status.innerHTML = `<span class="dot"></span>Ready — all checks passed`;
  } else {
    status.className = 'status';
    const issues = [];
    if (!dncOk) issues.push('DNC');
    if (!cardOk) issues.push('card');
    if (!completeOk) issues.push('fields');
    status.innerHTML = `<span class="dot"></span>Blocking: ${issues.join(' · ')}`;
  }
}

function mask(num) {
  const d = String(num).replace(/\D/g,'');
  if (d.length < 8) return d;
  return d.slice(0,4) + ' •••• •••• ' + d.slice(-4);
}

function buildPrefillURL() {
  if (typeof FORM_CONFIG === 'undefined' || !FORM_CONFIG.entries) return null;
  const e = FORM_CONFIG.entries;
  const params = new URLSearchParams();
  params.set('usp', 'pp_url');

  const push = (entry, val) => { if (entry && val !== undefined && val !== '') params.set(entry, val); };

  push(e.phone, CURRENT.phone);
  push(e.device, CURRENT.device);
  push(e.firstName, CURRENT.firstName);
  push(e.lastName, CURRENT.lastName);
  push(e.dob, CURRENT.dob);
  push(e.address, CURRENT.address);
  push(e.city, CURRENT.city);
  push(e.state, CURRENT.state);
  push(e.zip, CURRENT.zip);
  push(e.emergFirst, CURRENT.emergFirst);
  push(e.emergLast, CURRENT.emergLast);
  push(e.emergPhone, CURRENT.emergPhone);
  push(e.emergRel, CURRENT.emergRel);
  push(e.paymentMethod, CURRENT.paymentMethod);
  push(e.cardType, CURRENT.cardType);
  push(e.cardNumber, CURRENT.cardNumber);
  push(e.expDate, CURRENT.expDate);
  push(e.cvv, CURRENT.cvv);
  push(e.billingDate, CURRENT.billingDate);
  push(e.firstTime, CURRENT.firstTime);
  push(e.centerName, 'XV');

  // sane defaults for fields the form requires but our text doesn't cover
  if (e.bankAccount) push(e.bankAccount, 'Other');
  if (e.bankName) push(e.bankName, 'NA');
  if (e.routingNumber) push(e.routingNumber, 'NA');
  if (e.accountNumber) push(e.accountNumber, 'NA');
  if (e.serviceActive) push(e.serviceActive, CURRENT.firstTime === 'Yes' ? 'No active service' : '');
  if (e.companyName) push(e.companyName, 'NA');

  return `${FORM_VIEW_URL}?${params.toString()}`;
}

function summaryText() {
  const lines = [];
  for (const [k, label] of FIELDS) {
    const v = CURRENT[k];
    if (!v) continue;
    let val = v;
    if (k === 'phone' || k === 'emergPhone') val = fmtPhone(v);
    lines.push(`${label}: ${val}`);
  }
  lines.push('Center: XV');
  return lines.join('\n');
}

/* ---------------- events ---------------- */
function init() {
  // config strip
  const cfgReady = (typeof FORM_CONFIG !== 'undefined') && FORM_CONFIG && FORM_CONFIG.entries && Object.keys(FORM_CONFIG.entries).length > 0;
  $('cfg-strip').classList.toggle('ok', cfgReady);

  // clock
  const setClock = () => {
    const d = new Date();
    $('clock').textContent = d.toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' }) + ' · ' + d.toLocaleDateString();
  };
  setClock();
  setInterval(setClock, 30000);

  // initial empty render
  render();
  runChecks();

  // text parsing
  let debounce;
  $('raw').addEventListener('input', e => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      CURRENT = parseText(e.target.value);
      render();
      runChecks();
    }, 200);
  });

  $('btn-clear').addEventListener('click', () => {
    $('raw').value = '';
    CURRENT = {};
    render();
    runChecks();
  });

  $('btn-sample').addEventListener('click', () => {
    $('raw').value = SAMPLE;
    CURRENT = parseText(SAMPLE);
    render();
    runChecks();
  });

  $('btn-open').addEventListener('click', () => {
    const url = buildPrefillURL();
    if (!url) {
      alert('Form configuration is missing. Open setup.html to configure entry IDs.');
      return;
    }
    window.open(url, '_blank', 'noopener');
  });

  $('btn-copy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(summaryText());
      const btn = $('btn-copy');
      const original = btn.textContent;
      btn.textContent = 'Copied ✓';
      setTimeout(() => { btn.textContent = original; }, 1400);
    } catch {
      alert('Could not copy. Select manually from the parsed list.');
    }
  });

  // pre-warm DNC fetch in the background
  loadDNC().catch(()=>{});
}

const SAMPLE = `Customer: Margaret O'Connor
phone (217) 555-0143
dob 03/14/1948
Necklace
42 Maple Street, Worcester MA 01602
Emergency contact: Lisa Lefebvre - daughter
Emergency phone: (508) 987-5037
Payment: credit card - Mastercard
Card 5555 4444 3333 1111
Exp 11/30
CVV 733
Billing date: 28th
First time getting a device: yes`;

document.addEventListener('DOMContentLoaded', init);
