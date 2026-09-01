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

const MEDGUARD_FORM_VIEW_URL =
  'https://docs.google.com/forms/d/e/1FAIpQLSdnt_QZBKi2IFHB9rw2cNtFaC6CUyTxwT53YKRMCaI4xhQvXg/viewform';

const MEDGUARD_DEFAULTS = {
  dealerId: 'Bell Marketing 1',
  transferDID: '8559993187'
};

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
  ['bankName',        'Bank name'],
  ['accountNumber',   'Account number'],
  ['routingNumber',   'Routing number'],
  ['billingDate',     'Billing date'],
  ['firstTime',       'First-time device'],
  ['sameDayCharge',   'Same-day charge (Medguard)'],
];

const BASE_REQUIRED_FIELDS = [
  'phone','device','firstName','lastName','dob','address','city','state','zip',
  'paymentMethod','billingDate','firstTime'
];

function requiredFieldsFor(data = CURRENT) {
  const required = [...BASE_REQUIRED_FIELDS];
  if (data.paymentMethod === 'Bank account') {
    required.push('bankName','accountNumber','routingNumber');
  } else {
    required.push('cardNumber','expDate','cvv');
  }
  return required;
}


function parseBankDetails(text, lines, out) {
  const account = text.match(/(?:\bacc(?:ount)?[ \t]*(?:no|number|#)?|\baccount[ \t]*(?:no|number|#))[ \t]*[:\-]?[ \t]*([0-9][0-9 \t-]{3,24})/i);
  if (account) {
    const d = account[1].replace(/\D/g, '');
    if (d.length >= 4 && d.length <= 20) out.accountNumber = d;
  }

  const routing = text.match(/(?:routing[ \t]*(?:no|number|#)?)[ \t]*[:\-]?[ \t]*(\d{9})\b/i);
  if (routing) out.routingNumber = routing[1];

  const bank = text.match(/(?:bank[ \t]*name|name[ \t]*of[ \t]*(?:the[ \t]*)?bank)[ \t]*[:\-]?[ \t]*([^\r\n]+)/i);
  if (bank) {
    const v = bank[1].replace(/^[-–—:\s]+|[-–—:\s]+$/g, '').trim();
    if (v && !/^(?:n\/?a|none|bank)$/i.test(v)) out.bankName = v;
  }
}

function parseText(raw) {
  const out = {};
  if (!raw) return out;
  const text = raw.replace(/\u00A0/g, ' ').replace(/[→➝➔►]/g, '-');
  const lower = text.toLowerCase();
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);

  // ---------- phase 1: collect all phones across the whole text ----------
  const allPhones = [];
  const phoneRe = /(\+?1[\s\-.()]*)?\(?(\d{3})\)?[\s\-.]?(\d{3})[\s\-.]?(\d{4})/g;
  let pm;
  while ((pm = phoneRe.exec(text)) !== null) {
    const num = pm[2] + pm[3] + pm[4];
    const before = text[pm.index - 1];
    const after = text[pm.index + pm[0].length];
    // skip if part of longer digit run (card etc.)
    if (before && /\d/.test(before)) continue;
    if (after && /\d/.test(after)) continue;
    // skip toll-free / known service lines
    if (/^(800|888|877|866|855|844|833|822)/.test(num)) continue;
    allPhones.push({ value: num, index: pm.index, raw: pm[0] });
  }

  // ---------- phase 2: bank details (labeled account / routing / bank name) ----------
  parseBankDetails(text, lines, out);

  // ---------- phase 3: card number (anywhere, 13–19 digits) ----------
  const cardLabel = text.match(/(?:card[ \t]*(?:number|num|#|no)|cc[ \t]*#?)[ \t]*:?[ \t]*([\d \t\-]{12,25})/i);
  if (cardLabel) {
    const d = cardLabel[1].replace(/\D/g, '');
    if (d.length >= 13 && d.length <= 19) out.cardNumber = d;
  }
  if (!out.cardNumber && !out.accountNumber && !out.routingNumber) {
    // any 13–19 contiguous digits (with optional spaces/dashes between groups)
    const ccRe = /\b(?:\d[ \-]?){13,19}\b/g;
    const ccMatch = text.match(ccRe);
    if (ccMatch) {
      for (const m of ccMatch) {
        const d = m.replace(/\D/g, '');
        if (d.length >= 13 && d.length <= 19) { out.cardNumber = d; break; }
      }
    }
    if (!out.cardNumber) {
      // also catch a bare 16-digit run on its own line
      for (const ln of lines) {
        const d = ln.replace(/[\s\-]/g, '');
        if (/^\d{13,19}$/.test(d)) { out.cardNumber = d; break; }
      }
    }
  }

  // ---------- phase 4: device ----------
  if (/necklace/i.test(text)) out.device = 'Necklace $39.95';
  else if (/smart\s*watch|smartwatch|watch/i.test(text)) out.device = 'Smartwatch $44.95';

  // ---------- phase 4: card type ----------
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

  // ---------- phase 6: payment method ----------
  // The team template may contain both Card and Bank section headings.
  // Prefer the section that actually contains payment details.
  const hasBankDetails = Boolean(out.accountNumber || out.routingNumber || out.bankName);
  const hasCardDetails = Boolean(out.cardNumber);
  if (hasBankDetails && !hasCardDetails) {
    out.paymentMethod = 'Bank account';
  } else if (hasCardDetails) {
    out.paymentMethod = 'Bank card';
  } else if (/payment\s*method\s*:\s*(?:bank|ach|eft)|\bchecking\b|\bsavings\b/i.test(text)) {
    out.paymentMethod = 'Bank account';
  } else if (/payment\s*method\s*:\s*(?:card|credit|debit)|\bvisa\b|\bmastercard?\b|\bamex\b|\bdiscover\b/i.test(text)) {
    out.paymentMethod = 'Bank card';
  }

  // ---------- phase 7: first time getting a device ----------
  // explicit yes/no
  const ftExplicit = text.match(/first\s*time[^a-z0-9]*(?:getting\s*a\s*device)?[^a-z]*(yes|no|y|n)\b/i);
  if (ftExplicit) {
    out.firstTime = /^y/i.test(ftExplicit[1]) ? 'Yes' : 'No';
  } else {
    // "1st", "1 st", "first" with optional separator → first-time YES
    // "2nd", "2 nd", "second", "3rd", etc. → NO
    const cardContext = /(?:credit|debit|card|time|device)/i;
    let firstFound = false, laterFound = false;
    // Build a normalized version where "1 st", "2 nd", etc., are joined: "1st", "2nd"
    const normalized = text.replace(/\b([1-9])\s+(st|nd|rd|th)\b/gi, '$1$2');
    // Look for any "1st" / "first" within ~25 chars of a credit/debit/card/time/device word
    const winRe = /\b(1st|first|2nd|3rd|second|third|[4-9]th)\b[^a-z]{0,25}(credit|debit|card|time|device)/i;
    const reverseRe = /\b(credit|debit|card|time|device)\b[^a-z]{0,25}\b(1st|first|2nd|3rd|second|third|[4-9]th)\b/i;
    const m1 = normalized.match(winRe);
    const m2 = normalized.match(reverseRe);
    const match = m1 || m2;
    if (match) {
      const ord = (m1 ? match[1] : match[2]).toLowerCase();
      if (/^(1st|first)$/.test(ord)) firstFound = true;
      else laterFound = true;
    }
    if (firstFound) out.firstTime = 'Yes';
    else if (laterFound) out.firstTime = 'No';
    else if (/has\s+(both|already|other|previous)|already\s+(has|owns|got)/i.test(text)) out.firstTime = 'No';
  }

  // ---------- phase 8: zip → state → city → street address ----------
  parseAddress(text, lines, out);

  // ---------- phase 9: dates (DOB / exp date) ----------
  parseDates(text, lines, out);

  // ---------- phase 10: cvv (after we know exp date) ----------
  parseCVV(text, lines, out);

  // ---------- phase 11: billing date ----------
  parseBilling(text, lines, out);

  const sameDay = text.match(/same[ \t-]*day[ \t]*charge[ \t]*:[ \t]*(yes|no|y|n)\b/i);
  if (sameDay) out.sameDayCharge = /^y/i.test(sameDay[1]) ? 'Yes' : 'No';

  // ---------- phase 12: emergency contact (name + phone + relation) ----------
  parseEmergencyContact(text, lines, allPhones, out);

  // ---------- phase 13: main phone (first remaining) ----------
  for (const ph of allPhones) {
    if (ph.value === out.emergPhone) continue;
    if (!out.phone) { out.phone = ph.value; break; }
  }
  if (!out.phone && allPhones.length > 0 && !out.emergPhone) {
    out.phone = allPhones[0].value;
  }

  // ---------- phase 14: customer name ----------
  parseCustomerName(text, lines, out);

  return out;
}

/* ============== sub-parsers ============== */

function parseAddress(text, lines, out) {
  // zip first
  const zip5 = [];
  const zipRe = /\b(\d{5})(-\d{4})?\b/g;
  let zm;
  while ((zm = zipRe.exec(text)) !== null) {
    const idx = zm.index;
    const before = text[idx - 1];
    const after = text[idx + zm[1].length];
    if (before && /\d/.test(before)) continue;
    if (after && /\d/.test(after) && !zm[2]) continue;
    zip5.push({ value: zm[1], index: idx, full: zm[0] });
  }

  // prefer a zip that is preceded by a state abbreviation or name within 40 chars
  let chosenZip = null;
  for (const z of zip5) {
    const ctx = text.slice(Math.max(0, z.index - 40), z.index);
    const hasState = /\b([A-Z]{2})\b\s*,?\s*$/.test(ctx) ||
                     Object.keys(STATE_ABBR).some(s => new RegExp(`\\b${s}\\b\\s*,?\\s*$`, 'i').test(ctx));
    if (hasState) { chosenZip = z; break; }
  }
  if (!chosenZip && zip5.length) chosenZip = zip5[0];
  if (chosenZip) out.zip = chosenZip.value;

  // state
  if (chosenZip) {
    const beforeZip = text.slice(Math.max(0, chosenZip.index - 80), chosenZip.index);
    const abbr = beforeZip.match(/\b([A-Z]{2})\b\s*,?\s*$/);
    if (abbr && STATE_CODES.has(abbr[1])) out.state = abbr[1];
    if (!out.state) {
      for (const [full, ab] of Object.entries(STATE_ABBR)) {
        const re = new RegExp(`\\b${full}\\b\\s*,?\\s*$`, 'i');
        if (re.test(beforeZip)) { out.state = ab; break; }
      }
    }
    // city
    if (out.state) {
      const stateRe = new RegExp(`\\b${out.state}\\b\\s*,?\\s*$`, 'i');
      const m = beforeZip.match(stateRe);
      const stateLocalIdx = m ? beforeZip.lastIndexOf(m[0]) : beforeZip.toLowerCase().lastIndexOf(out.state.toLowerCase());
      const chunk = beforeZip.slice(0, stateLocalIdx).replace(/,\s*$/, '').trim();
      // city = trailing 1-3 capitalized words, NOT containing street suffix
      const STREET_WORDS = /\b(St|Street|Ave|Avenue|Rd|Road|Blvd|Boulevard|Dr|Drive|Ln|Lane|Way|Ct|Court|Pl|Place|Pkwy|Parkway|Ter|Terrace|Cir|Circle|Hwy|Highway|Sq|Square|Trl|Trail|Apt|Suite|Ste|Unit)\.?\b/i;
      // split chunk into tokens; walk backwards; collect city tokens until we hit a street word, comma, or number
      const tokens = chunk.split(/\s+/);
      const cityTokens = [];
      for (let i = tokens.length - 1; i >= 0; i--) {
        const t = tokens[i].replace(/[,;]+$/, '');
        if (!t) break;
        if (/^\d/.test(t)) break;
        if (STREET_WORDS.test(t)) break;
        if (/^[a-z]/.test(t) && cityTokens.length > 0) break; // lowercase break
        cityTokens.unshift(t);
        if (cityTokens.length >= 3) break;
      }
      if (cityTokens.length) {
        // strip any trailing comma
        out.city = cityTokens.join(' ').replace(/[,;]+$/, '');
      }
    }
  }
  // fallback state search anywhere
  if (!out.state) {
    for (const [full, ab] of Object.entries(STATE_ABBR)) {
      const re = new RegExp(`\\b${full}\\b`, 'i');
      if (re.test(text)) { out.state = ab; break; }
    }
  }

  // street address: line with a number followed by street-suffix word
  const streetRe = /\b(\d{1,6}\s+(?:[NSEW]\.?\s+)?[A-Za-z][a-zA-Z\.\-'’]*(?:\s+[A-Za-z][a-zA-Z\.\-'’]*){0,5}\s+(?:St|Street|Ave|Avenue|Rd|Road|Blvd|Boulevard|Dr|Drive|Ln|Lane|Way|Ct|Court|Pl|Place|Pkwy|Parkway|Ter|Terrace|Cir|Circle|Hwy|Highway|Sq|Square|Trl|Trail))\.?(?:\s*(?:Apt|Apartment|Suite|Ste|Unit|#)\.?\s*[\w\-]+)?\b/i;
  const street = text.match(streetRe);
  if (street) out.address = street[0].replace(/\s+/g,' ').trim();

  // alt: an address line is the one that ends with the chosen zip
  if (!out.address && chosenZip) {
    for (const ln of lines) {
      if (ln.includes(chosenZip.value)) {
        // strip city, state, zip — take everything before the first comma OR before a 2-letter state code
        let addr = ln.replace(/\s*,?\s*[A-Z]{2}\s+\d{5}(-\d{4})?\s*$/i, '');
        addr = addr.replace(/\s*,\s*[A-Za-z][a-zA-Z\.\-\s]+$/, ''); // strip city after comma
        addr = addr.trim();
        if (/^\d/.test(addr) && addr.length > 5) {
          out.address = addr;
          break;
        }
      }
    }
  }
}

function parseDates(text, lines, out) {
  const thisYear = new Date().getFullYear();
  // gather all date candidates with position and "shape"
  const dates = [];
  // ISO: YYYY-MM-DD
  for (const m of text.matchAll(/\b(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})\b/g)) {
    const yr = parseInt(m[1], 10);
    dates.push({ raw: m[0], year: yr, idx: m.index, kind: 'full' });
  }
  // MM/DD/YYYY or M/D/YY etc.
  for (const m of text.matchAll(/\b(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})\b/g)) {
    let yr = parseInt(m[3], 10);
    if (yr < 100) yr += yr < 30 ? 2000 : 1900;
    dates.push({ raw: m[0], year: yr, idx: m.index, kind: 'full' });
  }
  // Spaces: "1 26 1965" or "10 12 1947"
  for (const m of text.matchAll(/\b(\d{1,2})\s+(\d{1,2})\s+(\d{4})\b/g)) {
    const yr = parseInt(m[3], 10);
    dates.push({ raw: m[0], year: yr, idx: m.index, kind: 'full-spaces' });
  }
  // MM/YY exp candidates (no day) — separate list
  const expDates = [];
  for (const m of text.matchAll(/(?:^|[^\d\/])(0?[1-9]|1[0-2])\s*[\/\-]\s*(\d{2}|\d{4})(?!\d|[\/\-]\d)/g)) {
    let yr = parseInt(m[2], 10);
    if (m[2].length === 2) yr += yr < 50 ? 2000 : 1900;
    const mo = m[1].padStart(2, '0');
    const yrStr = m[2].length === 4 ? m[2].slice(2) : m[2].padStart(2, '0');
    // adjust idx so it points at the start of the date (not the lookbehind char)
    const realIdx = m.index + m[0].indexOf(m[1]);
    expDates.push({ raw: `${mo}/${yrStr}`, year: yr, month: parseInt(m[1],10), idx: realIdx, length: m[0].length - (m[0].indexOf(m[1])) });
  }

  // DOB: a "full" date with year between 1900 and (current - 18)
  // Prefer one labeled with dob/born/birth, else the first one that fits
  const dobLabelRe = /(?:dob|date\s*of\s*birth|birth\s*date|born)[^a-z0-9\/.-]*([0-9]{1,2}[\/\-.\s][0-9]{1,2}[\/\-.\s][0-9]{2,4}|[0-9]{4}[\/\-.][0-9]{1,2}[\/\-.][0-9]{1,2})/i;
  const dobLabel = text.match(dobLabelRe);
  if (dobLabel) {
    out.dob = dobLabel[1].replace(/\s+/g, '/');
  } else {
    for (const d of dates) {
      if (d.year >= 1900 && d.year <= thisYear - 18) {
        out.dob = d.raw.replace(/\s+/g, '/'); break;
      }
    }
  }

  // Exp: a MM/YY date with year >= current year OR in future
  const expLabel = text.match(/(?:exp(?:iration)?\s*(?:date)?|expires?)[:\s]*([01]?\d\s*[\/\-]\s*[0-9]{2,4})/i);
  if (expLabel) {
    out.expDate = expLabel[1].replace(/\s+/g,'').replace(/-/g, '/');
    // normalize year length
    const m = out.expDate.match(/^(\d{1,2})\/(\d{2,4})$/);
    if (m) {
      const mo = m[1].padStart(2, '0');
      let yr = m[2];
      if (yr.length === 4) yr = yr.slice(2);
      out.expDate = `${mo}/${yr}`;
    }
  } else {
    // find an MM/YY that is in the future (and isn't the same as DOB)
    const future = expDates.filter(e => {
      // must be in future
      const exMo = new Date(e.year, e.month, 0);
      const now = new Date();
      if (exMo < new Date(now.getFullYear(), now.getMonth(), 1)) return false;
      // must not overlap DOB
      if (out.dob && text.slice(e.idx, e.idx + e.raw.length) === text.slice(text.indexOf(out.dob), text.indexOf(out.dob)+out.dob.length)) return false;
      return true;
    });
    if (future.length) out.expDate = future[0].raw;
    else {
      // even if not future, accept any 2-digit-year MM/YY that wasn't part of a full DOB date
      for (const e of expDates) {
        // ensure this isn't a substring of a longer date
        const ctx = text.slice(Math.max(0, e.idx - 1), e.idx + e.raw.length + 4);
        if (/\d[\/\-]\d/.test(ctx.slice(0, 2))) continue;
        // skip if its position overlaps a known DOB
        if (out.dob) {
          const dobIdx = text.indexOf(out.dob);
          if (dobIdx >= 0 && e.idx >= dobIdx && e.idx < dobIdx + out.dob.length) continue;
        }
        out.expDate = e.raw;
        break;
      }
    }
  }
}

function parseCVV(text, lines, out) {
  // labeled cvv
  const cvvLabel = text.match(/(?:cvv|cvc|security\s*code|cv2)[:\s]*([0-9]{3,4})/i);
  if (cvvLabel) { out.cvv = cvvLabel[1]; return; }
  // line-based heuristic: a line with exp + a 3/4-digit standalone number
  // e.g. "12/26 429" → exp 12/26, cvv 429
  // or "7/26 517" → exp 07/26, cvv 517
  for (const ln of lines) {
    const m = ln.match(/^\s*([01]?\d\s*[\/\-]\s*\d{2,4})\s+(\d{3,4})\s*$/);
    if (m) {
      out.cvv = m[2];
      // also lock in exp date if not already set or set inconsistently
      const exp = m[1].replace(/\s+/g, '').replace(/-/g, '/');
      const norm = exp.match(/^(\d{1,2})\/(\d{2,4})$/);
      if (norm) {
        let mo = norm[1].padStart(2, '0');
        let yr = norm[2];
        if (yr.length === 4) yr = yr.slice(2);
        out.expDate = `${mo}/${yr}`;
      }
      return;
    }
  }
  // bare line with just 3-4 digits, immediately after an exp-looking line
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*[01]?\d\s*[\/\-]\s*\d{2,4}\s*$/.test(lines[i])) {
      if (i + 1 < lines.length && /^\s*\d{3,4}\s*$/.test(lines[i+1])) {
        out.cvv = lines[i+1].trim();
        return;
      }
      // same line: "12/26 429"
      const sameMatch = lines[i].match(/^\s*[01]?\d\s*[\/\-]\s*\d{2,4}\s+(\d{3,4})\s*$/);
      if (sameMatch) { out.cvv = sameMatch[1]; return; }
    }
  }
}

function parseBilling(text, lines, out) {
  // most explicit: "billing date: 28"
  const billLabel = text.match(/billing\s*(?:date|day|cycle)[:\s]*([0-9]{1,2})(?:st|nd|rd|th)?\b/i);
  if (billLabel) {
    const d = parseInt(billLabel[1], 10);
    if (d >= 1 && d <= 31) { out.billingDate = String(d); return; }
  }
  // "billing 15" or "bill 15"
  const billLoose = text.match(/\bbilling?\s+([0-9]{1,2})(?:st|nd|rd|th)?\b/i);
  if (billLoose) {
    const d = parseInt(billLoose[1], 10);
    if (d >= 1 && d <= 31) { out.billingDate = String(d); return; }
  }
  // "billed on the 28th" or "28th of the month"
  const ordinal = text.match(/\b([0-9]{1,2})(st|nd|rd|th)\b(?!\s*(?:credit|debit|card|time))/i);
  if (ordinal) {
    const d = parseInt(ordinal[1], 10);
    if (d >= 1 && d <= 31) { out.billingDate = String(d); return; }
  }
}

function parseEmergencyContact(text, lines, allPhones, out) {
  const rels = RELATIONSHIPS.join('|');
  const relRe = new RegExp(`\\b(${rels})\\b`, 'i');


  // Team template: "Emergency contact: Name relationship" + separate phone line.
  const labeledContact = text.match(/(?:^|\n)[ \t]*(?:\d+[.)-]?[ \t]*)?emergency[ \t]*contact(?![ \t]*phone)[ \t]*:[ \t]*([^\r\n]+)/im);
  const labeledPhone = text.match(/(?:^|\n)[ \t]*(?:\d+[.)-]?[ \t]*)?emergency[ \t]*contact[ \t]*phone[ \t]*:[ \t]*\(?([0-9]{3})\)?[ \t.\-]*([0-9]{3})[ \t.\-]*([0-9]{4})/im);
  if (labeledPhone) out.emergPhone = labeledPhone[1] + labeledPhone[2] + labeledPhone[3];
  if (labeledContact) {
    let contact = labeledContact[1].trim();
    const rm = contact.match(relRe);
    if (rm) {
      out.emergRel = rm[1].toLowerCase();
      contact = contact.replace(rm[0], ' ');
    }
    const nameTokens = contact.replace(/[-→:,;()]+/g, ' ').trim().split(/\s+/)
      .filter(w => /^[A-Za-z][a-zA-Z'’\-.]*$/.test(w));
    if (nameTokens.length) out.emergFirst = capitalize(nameTokens[0]);
    if (nameTokens.length >= 2) out.emergLast = nameTokens.slice(1, 3).map(capitalize).join(' ');
    if (out.emergFirst || out.emergPhone) return;
  }

  // pass 1: lines that contain a relationship word
  for (const ln of lines) {
    const lnLow = ln.toLowerCase();
    const relMatch = lnLow.match(new RegExp(`\\b(${rels})\\b`));
    if (!relMatch) continue;
    // extract relation
    const relation = relMatch[1];
    // strip the relation from the line to find name and phone
    let rest = ln.replace(new RegExp(`\\b${relation}\\b`, 'i'), '');
    // find phone in this line
    const phoneMatch = rest.match(/\(?(\d{3})\)?[\s\-.]?(\d{3})[\s\-.]?(\d{4})/);
    let emergPhone = null;
    if (phoneMatch) {
      emergPhone = phoneMatch[1] + phoneMatch[2] + phoneMatch[3];
      rest = rest.replace(phoneMatch[0], '');
    }
    // strip separators
    rest = rest.replace(/[-→:,;()\d]+/g, ' ').trim();
    // remaining words = name
    const nameTokens = rest.split(/\s+/).filter(w => /^[A-Za-z][a-zA-Z'’\-\.]*$/.test(w));
    if (nameTokens.length >= 2) {
      out.emergFirst = capitalize(nameTokens[0]);
      out.emergLast = nameTokens.slice(1, 3).map(capitalize).join(' ');
      out.emergRel = relation.toLowerCase();
      if (emergPhone) out.emergPhone = emergPhone;
      return;
    } else if (nameTokens.length === 1) {
      out.emergFirst = capitalize(nameTokens[0]);
      out.emergRel = relation.toLowerCase();
      if (emergPhone) out.emergPhone = emergPhone;
      return;
    } else if (emergPhone) {
      out.emergRel = relation.toLowerCase();
      out.emergPhone = emergPhone;
      return;
    }
  }

  // pass 2: labeled "emergency contact:" line
  const emergLabel = text.match(/emergency\s*(?:contact)?[^:\n]*:?\s*([^\n]+)/i);
  if (emergLabel) {
    const ln = emergLabel[1];
    const phoneMatch = ln.match(/\(?(\d{3})\)?[\s\-.]?(\d{3})[\s\-.]?(\d{4})/);
    if (phoneMatch) out.emergPhone = phoneMatch[1] + phoneMatch[2] + phoneMatch[3];
    const nameTokens = ln.replace(/[\d\-:→(),;]+/g,' ').split(/\s+/).filter(w => /^[A-Za-z][a-zA-Z'’\-\.]*$/.test(w) && w.length > 1);
    if (nameTokens.length >= 2) {
      out.emergFirst = capitalize(nameTokens[0]);
      out.emergLast = nameTokens.slice(1,3).map(capitalize).join(' ');
    }
  }
}

function parseCustomerName(text, lines, out) {
  // try labeled customer/client/full name first
  const nameLabel = text.match(/(?:customer\s*name|client\s*name|full\s*name|^\s*name)[:\s]+([A-Za-z][a-zA-Z'’\-]+(?:[ \t]+[A-Za-z][a-zA-Z'’\-]+){1,2})/im);
  if (nameLabel) {
    const parts = nameLabel[1].trim().split(/\s+/);
    out.firstName = capitalize(parts[0]);
    out.lastName = parts.slice(1).map(capitalize).join(' ');
    return;
  }

  // build "skip" zones: lines that are addresses or known fields
  const NOISE_WORDS = new Set([
    'NECKLACE','SMARTWATCH','VISA','MASTER','MASTERCARD','AMERICAN','EXPRESS','DISCOVER',
    'BANK','CREDIT','DEBIT','CARD','FIRST','LAST','DATE','EMERGENCY','PHONE','ADDRESS',
    'BILLING','PAYMENT','EXP','CVV','CITY','STATE','ZIP','YES','NO','CUSTOMER','CLIENT',
    'NA','NONE','HAS','BOTH','ALREADY','CELLPHONE','LANDLINE','MOBILE','CELL','HOME',
    'WORK','BUSINESS','OFFICE','MEDICAL','GUARDIAN','LIFE','PROTECT','ALERT','SERVICE',
    'COMPANY','UNKNOWN','OTHER','SAME','APPROVED','DECLINED','SAINT','MOUNT','SMART',
    'WATCH','DEVICE','CALL','MONITORING','TEXT','EMAIL','TYPE'
  ]);

  const RELATIONSHIPS_UP = new Set(RELATIONSHIPS.map(r => r.toUpperCase()));

  function isLikelyName(token) {
    const upper = token.toUpperCase();
    if (NOISE_WORDS.has(upper)) return false;
    if (RELATIONSHIPS_UP.has(upper)) return false;
    if (STATE_ABBR[token.toLowerCase()]) return false;
    if (STATE_CODES.has(upper)) return false;
    // must be alphabetic, length 2-30
    if (!/^[A-Za-z][a-zA-Z'’\-\.]{1,29}$/.test(token)) return false;
    return true;
  }

  // build set of phones / cards / dates to avoid lines containing them
  const dirtyLineFlags = lines.map(ln => {
    const lnUp = ln.toUpperCase();
    // address?
    if (/\b\d{1,6}\b/.test(ln) && /\b(ST|STREET|AVE|AVENUE|RD|ROAD|BLVD|DR|DRIVE|LN|LANE|WAY|CT|COURT|PL|PLACE|PKWY|TER|CIR|HWY|SQ|TRL)\b/i.test(ln)) return 'address';
    // zip line?
    if (/\b\d{5}(-\d{4})?\b/.test(ln) && /\b[A-Z]{2}\b/.test(lnUp)) return 'address';
    // phone-only?
    if (/^\(?\d{3}\)?[\s\-.]?\d{3}[\s\-.]?\d{4}/.test(ln.trim())) return 'phone';
    // any line with the emerg phone or main phone
    if (out.phone && ln.includes(out.phone.slice(0,3))) return 'phone';
    // line containing card number
    if (out.cardNumber && ln.replace(/\D/g,'').includes(out.cardNumber)) return 'card';
    // pure date / exp
    if (/^\s*\d{1,4}[\/\-\s]\d{1,2}[\/\-\s]\d{1,4}\s*$/.test(ln)) return 'date';
    if (/^\s*\d{1,2}[\/\-]\d{2,4}\s+\d{3,4}\s*$/.test(ln)) return 'exp-cvv';
    if (/^\s*\d{1,2}[\/\-]\d{2,4}\s*$/.test(ln)) return 'exp';
    if (/^\s*\d{3,4}\s*$/.test(ln)) return 'cvv';
    // relationship line (emergency contact)
    if (new RegExp(`\\b(${RELATIONSHIPS.join('|')})\\b`, 'i').test(ln)) return 'emerg';
    // device line
    if (/^(necklace|smart\s*watch|smartwatch)/i.test(ln.trim())) return 'device';
    // payment / card type line
    if (/^(visa|mastercard|master\s*card|amex|american\s*express|discover|debit|credit|bank)/i.test(ln.trim())) return 'payment';
    // billing date line
    if (/^billing/i.test(ln.trim())) return 'billing';
    // dob-only label
    if (/^(dob|date\s*of\s*birth|born)/i.test(ln.trim())) return 'dob-label';
    // first-time label
    if (/first\s*time/i.test(ln) || /1st\s+(credit|debit)/i.test(ln) || /2nd\s+(credit|debit)/i.test(ln) || /has\s+(both|already)/i.test(ln)) return 'firsttime';
    return null;
  });

  // walk lines, find a "clean" line of 2-3 alphabetic tokens
  for (let i = 0; i < lines.length; i++) {
    if (dirtyLineFlags[i]) continue;
    const ln = lines[i].trim();
    // strip a leading "name:" or similar
    const stripped = ln.replace(/^(?:customer\s*(?:name)?|client|name|full\s*name)[:\s\-]*/i, '');
    const tokens = stripped.split(/[\s]+/).filter(t => t.length > 0);
    // must be 2-3 alphabetic name tokens
    if (tokens.length < 2 || tokens.length > 4) continue;
    if (!tokens.every(isLikelyName)) continue;
    // exclude lines that look like an emergency line (already filtered) — extra safety
    out.firstName = capitalize(tokens[0]);
    out.lastName = tokens.slice(1).map(capitalize).join(' ');
    return;
  }

  // fallback: try to find a name at the start of a phone-flagged line
  // (e.g. "Margaret O'Connor 217-555-0143 born 3/14/1948")
  for (let i = 0; i < lines.length; i++) {
    if (dirtyLineFlags[i] !== 'phone') continue;
    const ln = lines[i].trim();
    // grab tokens before the first phone number
    const phoneMatch = ln.match(/\(?\d{3}\)?[\s\-.]?\d{3}[\s\-.]?\d{4}/);
    if (!phoneMatch) continue;
    const beforePhone = ln.slice(0, phoneMatch.index).trim();
    const tokens = beforePhone.split(/[\s]+/).filter(t => t.length > 0);
    if (tokens.length >= 2 && tokens.length <= 3 && tokens.every(isLikelyName)) {
      out.firstName = capitalize(tokens[0]);
      out.lastName = tokens.slice(1).map(capitalize).join(' ');
      return;
    }
  }
}

function capitalize(s) {
  if (!s) return s;
  // handle O'Connor, D'Angelo, McDonald, MacArthur
  return s.toLowerCase().replace(/(^|['’\-\s])([a-z])/g, (_, sep, c) => sep + c.toUpperCase())
    .replace(/^(Mc)([a-z])/, (_, mc, c) => mc + c.toUpperCase());
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
    const required = requiredFieldsFor(CURRENT).includes(key);
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

  // PAYMENT
  let paymentOk = false;
  if (CURRENT.paymentMethod === 'Bank account') {
    const account = String(CURRENT.accountNumber || '').replace(/\D/g,'');
    const routing = String(CURRENT.routingNumber || '').replace(/\D/g,'');
    const bankName = String(CURRENT.bankName || '').trim();
    if (!account || !routing || !bankName) {
      setCheck('chk-card', 'idle', 'Bank details required', 'Bank name · account · routing');
    } else if (account.length < 4) {
      setCheck('chk-card', 'bad', 'Bank account number looks too short', account.length + ' digits');
    } else if (routing.length !== 9) {
      setCheck('chk-card', 'bad', 'Routing number must be 9 digits', routing.length + ' digits');
    } else {
      setCheck('chk-card', 'good', 'Bank details ready', `${bankName} · routing ••••${routing.slice(-4)}`);
      paymentOk = true;
    }
  } else if (!CURRENT.cardNumber) {
    setCheck('chk-card', 'idle', 'Card number required', '');
  } else {
    const res = validateCard(CURRENT.cardNumber);
    const expOk = validateExp(CURRENT.expDate);
    if (res.ok && expOk) {
      setCheck('chk-card', 'good', 'Card format verified · ' + res.brand, mask(CURRENT.cardNumber));
      paymentOk = true;
    } else if (res.ok && !expOk) {
      setCheck('chk-card', 'bad', 'Card valid but exp date is missing/expired', CURRENT.expDate || '');
    } else {
      setCheck('chk-card', 'bad', 'WARNING — card format is wrong', res.reason);
    }
  }

  // COMPLETE
  const requiredFields = requiredFieldsFor(CURRENT);
  const missing = requiredFields.filter(k => !CURRENT[k] || String(CURRENT[k]).trim() === '');
  let completeOk = false;
  if (missing.length === 0) {
    setCheck('chk-complete', 'good', 'All required fields present', `${requiredFields.length}/${requiredFields.length}`);
    completeOk = true;
  } else {
    setCheck('chk-complete', 'warn', `Missing: ${missing.map(k => FIELDS.find(f=>f[0]===k)?.[1] || k).join(', ')}`, `${requiredFields.length - missing.length}/${requiredFields.length}`);
  }

  // Action bar
  const allGood = dncOk && paymentOk && completeOk;
  const cfgReady = (typeof FORM_CONFIG !== 'undefined') && FORM_CONFIG && FORM_CONFIG.entries && Object.keys(FORM_CONFIG.entries).length > 0;
  const medguardReady = (typeof MEDGUARD_CONFIG !== 'undefined') && MEDGUARD_CONFIG && MEDGUARD_CONFIG.entries && Object.keys(MEDGUARD_CONFIG.entries).length > 0;
  $('btn-open-ahmed').disabled = !(allGood && cfgReady);
  $('btn-open-medguard').disabled = !(allGood && medguardReady);

  const status = $('status-line');
  if (!cfgReady) {
    status.className = 'status';
    status.innerHTML = `<span class="dot"></span>Setup needed — Ahmed form field IDs`;
  } else if (allGood) {
    status.className = 'status ready';
    status.innerHTML = `<span class="dot"></span>${medguardReady ? 'Ready — choose destination form' : 'Ready — Ahmed form available · Medguard setup needed'}`;
  } else {
    status.className = 'status';
    const issues = [];
    if (!dncOk) issues.push('DNC');
    if (!paymentOk) issues.push('payment');
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
  push(e.billingDate, CURRENT.billingDate);
  push(e.firstTime, CURRENT.firstTime);
  push(e.centerName, 'XV');

  if (CURRENT.paymentMethod === 'Bank account') {
    push(e.bankAccount, 'Other');
    push(e.bankName, CURRENT.bankName);
    push(e.routingNumber, CURRENT.routingNumber);
    push(e.accountNumber, CURRENT.accountNumber);
  } else {
    push(e.cardType, CURRENT.cardType);
    push(e.cardNumber, CURRENT.cardNumber);
    push(e.expDate, CURRENT.expDate);
    push(e.cvv, CURRENT.cvv);
    // Keep required bank-related fields harmlessly populated on the legacy form when needed.
    if (e.bankAccount) push(e.bankAccount, 'Other');
    if (e.bankName) push(e.bankName, 'NA');
    if (e.routingNumber) push(e.routingNumber, 'NA');
    if (e.accountNumber) push(e.accountNumber, 'NA');
  }

  if (e.serviceActive) push(e.serviceActive, CURRENT.firstTime === 'Yes' ? 'No active service' : '');
  if (e.companyName) push(e.companyName, 'NA');

  return `${FORM_VIEW_URL}?${params.toString()}`;
}

function medguardDeviceData(device) {
  const d = String(device || '').toLowerCase();
  if (d.includes('necklace')) return { device: 'Smart-Go', price: '$39.95' };
  if (d.includes('watch')) return { device: 'Watch - CWL', price: '$44.95' };
  return { device: device || '', price: '' };
}

function buildMedguardURL() {
  if (typeof MEDGUARD_CONFIG === 'undefined' || !MEDGUARD_CONFIG.entries) return null;
  const e = MEDGUARD_CONFIG.entries;
  if (!Object.keys(e).length) return null;
  const params = new URLSearchParams();
  params.set('usp', 'pp_url');
  const push = (entry, val) => { if (entry && val !== undefined && val !== '') params.set(entry, val); };
  const dev = medguardDeviceData(CURRENT.device);

  push(e.dealerId, MEDGUARD_DEFAULTS.dealerId);
  push(e.transferDID, MEDGUARD_DEFAULTS.transferDID);
  push(e.firstName, CURRENT.firstName);
  push(e.lastName, CURRENT.lastName);
  push(e.phone, CURRENT.phone);
  push(e.dob, CURRENT.dob);
  push(e.address, CURRENT.address);
  push(e.city, CURRENT.city);
  push(e.state, CURRENT.state);
  push(e.zip, CURRENT.zip);
  push(e.device, dev.device);
  push(e.devicePrice, dev.price);
  push(e.billingDate, CURRENT.billingDate);
  push(e.emergRel, CURRENT.emergRel);
  push(e.emergName, [CURRENT.emergFirst, CURRENT.emergLast].filter(Boolean).join(' '));
  push(e.emergPhone, CURRENT.emergPhone);

  if (CURRENT.paymentMethod === 'Bank account') {
    push(e.paymentType, 'ACH/EFT');
    push(e.bankName, CURRENT.bankName);
    push(e.accountNumber, CURRENT.accountNumber);
    push(e.routingNumber, CURRENT.routingNumber);
  } else {
    push(e.paymentType, 'CCD');
    push(e.cardNumber, CURRENT.cardNumber);
    push(e.cvv, CURRENT.cvv);
    push(e.expDate, CURRENT.expDate);
  }

  push(e.sameDayCharge, CURRENT.sameDayCharge);
  // The public form currently has no visible Transfer DID question. If the setup
  // mapping exposes one, it is filled above. Otherwise preserve the DID in notes.
  if (!e.transferDID && e.additionalNotes) {
    push(e.additionalNotes, `Transfer DID: ${MEDGUARD_DEFAULTS.transferDID}`);
  }

  return `${MEDGUARD_FORM_VIEW_URL}?${params.toString()}`;
}

function summaryText() {
  const lines = [];
  for (const [k, label] of FIELDS) {
    const v = CURRENT[k];
    if (!v) continue;
    let val = v;
    if (k === 'phone' || k === 'emergPhone') val = fmtPhone(v);
    if (k === 'cardNumber') val = mask(v);
    if (k === 'accountNumber') val = '••••' + String(v).replace(/\D/g,'').slice(-4);
    if (k === 'routingNumber') val = '••••' + String(v).replace(/\D/g,'').slice(-4);
    if (k === 'cvv') val = '•••';
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
  const medguardReady = (typeof MEDGUARD_CONFIG !== 'undefined') && MEDGUARD_CONFIG && MEDGUARD_CONFIG.entries && Object.keys(MEDGUARD_CONFIG.entries).length > 0;
  $('mg-cfg-strip').classList.toggle('ok', medguardReady);

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

  $('btn-open-ahmed').addEventListener('click', () => {
    const url = buildPrefillURL();
    if (!url) {
      alert('Ahmed Osama form configuration is missing. Open setup.html to configure entry IDs.');
      return;
    }
    window.open(url, '_blank', 'noopener');
  });

  $('btn-open-medguard').addEventListener('click', () => {
    const url = buildMedguardURL();
    if (!url) {
      alert('Osama Medguard configuration is missing. Open setup.html, extract the Medguard form IDs, then paste the generated MEDGUARD_CONFIG into config.js.');
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
