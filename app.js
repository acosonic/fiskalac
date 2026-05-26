'use strict';
/* fiskalac — generator izjave za fiskalni račun za gorivo (client-side) */

// ── konstante ────────────────────────────────────────────────────────────────
const MESECI = ['', 'јануар','фебруар','март','април','мај','јун',
                'јул','август','септембар','октобар','новембар','децембар'];

const $ = (s) => document.querySelector(s);
const state = { srcCanvas:null, cleanCanvas:null, bi:'', source:'', pdfBlob:null, pdfName:'', email:null };

// ── профил у localStorage ────────────────────────────────────────────────────
// Ништа није хардкодовано — име, фирму/послодавца, место и мејл уноси корисник,
// и памти се на овом уређају.
const cfg = (k) => (localStorage.getItem('fisk_' + k) || '').trim();
const PROFILE_KEYS = ['ime', 'firma', 'grad', 'email'];

function loadProfile() {
  for (const k of PROFILE_KEYS) $('#' + k).value = cfg(k);
  const sig = localStorage.getItem('fisk_potpis');
  if (sig) {
    $('#sigPreview').src = sig;
    $('#sigPreview').classList.remove('hidden');
    $('#sigClear').classList.remove('hidden');
    $('#sigStatus').textContent = 'сачуван потпис ✓ (кликни да промениш)';
  }
}
function saveProfile() {
  for (const k of PROFILE_KEYS) localStorage.setItem('fisk_' + k, $('#' + k).value.trim());
}

// connected-components: nađi sve tamne mrlje (za izdvajanje potpisa od šuma/senki)
function inkComponents(f, W, H, thr) {
  const seen = new Uint8Array(W * H), stack = new Int32Array(W * H), comps = [];
  for (let s = 0; s < W * H; s++) {
    if (seen[s] || f[s] >= thr) continue;
    let sp = 0; stack[sp++] = s; seen[s] = 1;
    let area = 0, x0 = W, y0 = H, x1 = 0, y1 = 0;
    while (sp > 0) {
      const p = stack[--sp], px = p % W, py = (p - px) / W;
      area++;
      if (px < x0) x0 = px; if (px > x1) x1 = px;
      if (py < y0) y0 = py; if (py > y1) y1 = py;
      const L = px > 0, R = px < W - 1, U = py > 0, D = py < H - 1;
      const t = (q) => { if (!seen[q] && f[q] < thr) { seen[q] = 1; stack[sp++] = q; } };
      if (L) t(p-1); if (R) t(p+1); if (U) t(p-W); if (D) t(p+W);
      if (L&&U) t(p-W-1); if (R&&U) t(p-W+1); if (L&&D) t(p+W-1); if (R&&D) t(p+W+1);
    }
    comps.push({ area, x0, y0, x1, y1 });
  }
  return comps;
}

// potpis sa фотографије (мастило на папиру) → исечен потпис на провидној позадини.
// flatten уклања сенке/неравномерно светло, connected-components издваја потпис
// од ситних мрља/тачкица, па мастило → тамно непрозирно, папир → провидно.
async function processSignature(file) {
  // createImageBitmap ispravno primenjuje EXIF rotaciju (Safari iOS 15.4+),
  // što fixes sliku potpisanu na iPhoneu koja bi inače bila sideways.
  const src = (typeof createImageBitmap !== 'undefined')
    ? await createImageBitmap(file)
    : await fileToImage(file);
  const { f, W, H } = flattenGray(src, 2400);
  if (src.close) src.close();

  const comps = inkComponents(f, W, H, 115);
  let bb;
  if (!comps.length) {
    bb = { x0: 0, y0: 0, x1: W - 1, y1: H - 1 };
  } else {
    comps.sort((a, b) => b.area - a.area);
    bb = { x0: comps[0].x0, y0: comps[0].y0, x1: comps[0].x1, y1: comps[0].y1 };
    // спој оближње компоненте (тачке, одвојени потези потписа); даљи шум остаје напољу
    const acx = (bb.x0 + bb.x1) / 2, acy = (bb.y0 + bb.y1) / 2;
    const reach = Math.max(bb.x1 - bb.x0, bb.y1 - bb.y0) * 1.25;
    for (let i = 1; i < comps.length; i++) {
      const c = comps[i];
      if (c.area < 10) continue;
      const ccx = (c.x0 + c.x1) / 2, ccy = (c.y0 + c.y1) / 2;
      if (Math.hypot(ccx - acx, ccy - acy) < reach) {
        bb.x0 = Math.min(bb.x0, c.x0); bb.y0 = Math.min(bb.y0, c.y0);
        bb.x1 = Math.max(bb.x1, c.x1); bb.y1 = Math.max(bb.y1, c.y1);
      }
    }
  }
  const pad = Math.round(Math.max(bb.x1 - bb.x0, bb.y1 - bb.y0) * 0.07);
  const x0 = Math.max(0, bb.x0 - pad), y0 = Math.max(0, bb.y0 - pad);
  const x1 = Math.min(W - 1, bb.x1 + pad), y1 = Math.min(H - 1, bb.y1 + pad);
  const cw = x1 - x0 + 1, ch = y1 - y0 + 1;

  const out = new ImageData(cw, ch);
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
    const lum = f[(y + y0) * W + (x + x0)];
    const a = lum >= 170 ? 0 : lum <= 95 ? 255 : Math.round((170 - lum) / 75 * 255);
    const o = (y * cw + x) * 4;
    out.data[o] = 28; out.data[o+1] = 28; out.data[o+2] = 42; out.data[o+3] = a;
  }
  const c = document.createElement('canvas');
  c.width = cw; c.height = ch;
  c.getContext('2d').putImageData(out, 0, 0);
  return c.toDataURL('image/png');
}

// ── učitavanje slike ─────────────────────────────────────────────────────────
function fileToImage(file) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = rej;
    img.src = URL.createObjectURL(file);
  });
}
async function fileToCanvas(file) {
  const img = await fileToImage(file);
  const c = document.createElement('canvas');
  c.width = img.width; c.height = img.height;
  c.getContext('2d').drawImage(img, 0, 0);
  return c;
}

// ── pomoćne za obradu slike ──────────────────────────────────────────────────
function blurCanvas(src, radius) {
  const c = document.createElement('canvas');
  c.width = src.width; c.height = src.height;
  const ctx = c.getContext('2d');
  ctx.filter = `blur(${radius}px)`;
  ctx.drawImage(src, 0, 0);
  ctx.filter = 'none';
  return c;
}
function floatToCanvas(f, W, H) {
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const id = new ImageData(W, H);
  for (let p = 0; p < W*H; p++) {
    const v = f[p] < 0 ? 0 : f[p] > 255 ? 255 : f[p];
    id.data[p*4] = id.data[p*4+1] = id.data[p*4+2] = v; id.data[p*4+3] = 255;
  }
  c.getContext('2d').putImageData(id, 0, 0);
  return c;
}
function canvasToGray(c) {
  const W = c.width, H = c.height;
  const d = c.getContext('2d').getImageData(0, 0, W, H).data;
  const g = new Float32Array(W*H);
  for (let i = 0, p = 0; p < W*H; i += 4, p++)
    g[p] = 0.299*d[i] + 0.587*d[i+1] + 0.114*d[i+2];
  return g;
}
// kontrastno razvlačenje sa odsecanjem repova histograma (kao IM -normalize) —
// puko min-max ostavlja QR module sive zbog jednog piksela šuma
function normalize(f) {
  const hist = new Uint32Array(256);
  for (let i = 0; i < f.length; i++) {
    let v = f[i] | 0; if (v < 0) v = 0; else if (v > 255) v = 255;
    hist[v]++;
  }
  const clip = f.length * 0.006;
  let lo = 0, hi = 255, acc = 0;
  for (acc = 0; lo < 255; lo++) { acc += hist[lo]; if (acc > clip) break; }
  for (acc = 0; hi > 0; hi--) { acc += hist[hi]; if (acc > clip) break; }
  const r = (hi - lo) || 1;
  for (let i = 0; i < f.length; i++) {
    const v = (f[i] - lo) / r * 255;
    f[i] = v < 0 ? 0 : v > 255 ? 255 : v;
  }
}

// grayscale -> flatten pozadine (deljenje zamućenom kopijom) -> normalize
// vraća {f: Float32 0..255, W, H}
function flattenGray(src, maxDim) {
  const scale = Math.min(1, maxDim / Math.max(src.width, src.height));
  const W = Math.round(src.width*scale), H = Math.round(src.height*scale);
  const work = document.createElement('canvas'); work.width = W; work.height = H;
  work.getContext('2d').drawImage(src, 0, 0, W, H);
  const g  = canvasToGray(work);
  const bg = canvasToGray(blurCanvas(floatToCanvas(g, W, H), Math.max(2, Math.round(Math.max(W,H)*0.025))));
  const f  = new Float32Array(W*H);
  for (let p = 0; p < W*H; p++) f[p] = bg[p] > 1 ? Math.min(255, g[p]/bg[p]*255) : 255;
  normalize(f);
  return { f, W, H };
}

// čišćenje računa za PDF: flatten -> adaptivni prag -> auto-crop -> beli okvir
function cleanReceipt(src) {
  const { f, W, H } = flattenGray(src, 1700);
  const lm = canvasToGray(blurCanvas(floatToCanvas(f, W, H), Math.max(3, Math.round(Math.max(W,H)*0.045))));
  const off = 11;
  const out = new ImageData(W, H);
  for (let p = 0; p < W*H; p++) {
    const v = f[p] < lm[p] - off ? 0 : 255;
    out.data[p*4] = out.data[p*4+1] = out.data[p*4+2] = v; out.data[p*4+3] = 255;
  }
  const bw = document.createElement('canvas'); bw.width = W; bw.height = H;
  bw.getContext('2d').putImageData(out, 0, 0);
  return addBorder(autoCrop(bw), Math.round(Math.max(W, H) * 0.025));
}

// jednostavan auto-crop na okvir sadržaja (projekcija gustine crnih piksela)
function autoCrop(bw) {
  const W = bw.width, H = bw.height;
  const d = bw.getContext('2d').getImageData(0, 0, W, H).data;
  const rd = new Int32Array(H), cd = new Int32Array(W);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++)
      if (d[(y*W+x)*4] < 128) { rd[y]++; cd[x]++; }
  const rTh = W*0.015, cTh = H*0.015;
  let y0 = 0, y1 = H-1, x0 = 0, x1 = W-1;
  while (y0 < H  && rd[y0] < rTh) y0++;
  while (y1 > y0 && rd[y1] < rTh) y1--;
  while (x0 < W  && cd[x0] < cTh) x0++;
  while (x1 > x0 && cd[x1] < cTh) x1--;
  const cw = x1-x0+1, ch = y1-y0+1;
  if (cw < W*0.15 || ch < H*0.15 || cw*ch > W*H*0.985) return bw;   // sumnjivo -> bez sečenja
  const pad = Math.round(Math.max(W,H)*0.012);
  x0 = Math.max(0, x0-pad); y0 = Math.max(0, y0-pad);
  x1 = Math.min(W-1, x1+pad); y1 = Math.min(H-1, y1+pad);
  const c = document.createElement('canvas'); c.width = x1-x0+1; c.height = y1-y0+1;
  c.getContext('2d').drawImage(bw, x0, y0, c.width, c.height, 0, 0, c.width, c.height);
  return c;
}
function addBorder(c, b) {
  const r = document.createElement('canvas');
  r.width = c.width + 2*b; r.height = c.height + 2*b;
  const ctx = r.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, r.width, r.height);
  ctx.drawImage(c, b, b);
  return r;
}

// ── QR ───────────────────────────────────────────────────────────────────────
// dekodiraj QR sa slike — zbar (WASM port, robustan kao native zbar).
// zbar je osetljiv na veličinu QR modula posle smanjivanja, pa probamo
// više razmera — za telefonske slike bar jedna uvek pogodi.
async function decodeReceiptQR(src) {
  const maxd = Math.max(src.width, src.height);
  for (const md of [1600, 1200, 2000, 1000, 1400, 1800, 1100]) {
    const s = Math.min(1, md / maxd);
    const c = document.createElement('canvas');
    c.width = Math.round(src.width * s);
    c.height = Math.round(src.height * s);
    const ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, 0, 0, c.width, c.height);
    try {
      const id = ctx.getImageData(0, 0, c.width, c.height);
      const syms = await zbarWasm.scanImageData(id);
      if (syms.length) return syms[0].decode();
    } catch (e) { /* preskoči ovu razmeru */ }
  }
  return null;
}
// БИ = u32 LE na offsetu 17 binarnog 'vl' zapisa (verzija 3)
function biFromVl(vl) {
  try {
    let b = vl.replace(/-/g, '+').replace(/_/g, '/');
    while (b.length % 4) b += '=';
    const bin = atob(b);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    if (bytes.length > 21 && bytes[0] === 3)
      return String(new DataView(bytes.buffer).getUint32(17, true));
  } catch (e) {}
  return '';
}
// ── datum ────────────────────────────────────────────────────────────────────
function todayISO() {                            // -> "2026-05-14" (lokalni datum)
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function inputToParts(v) {                        // "2026-05-14" -> {ddmmyyyy, mm, yyyy}
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v || '');
  if (!m) return null;
  return { ddmmyyyy: `${m[3]}.${m[2]}.${m[1]}`, mm: +m[2], yyyy: m[1] };
}

// ── KORAK 1 -> 2: obrada ─────────────────────────────────────────────────────
async function onProcess() {
  const file = $('#racunCamera').files[0] || $('#racunFile').files[0];
  if (!file) { alert('Изаберите или сликајте рачун.'); return; }
  if (!$('#ime').value.trim())   { alert('Унесите име и презиме.'); return; }
  if (!$('#firma').value.trim()) { alert('Унесите фирму / послодавца.'); return; }
  if (!$('#grad').value.trim())  { alert('Унесите место (град).'); return; }
  saveProfile();
  try {
    busy('Учитавам слику…');
    state.srcCanvas = await fileToCanvas(file);

    busy('Чистим слику рачуна…');
    await tick();
    state.cleanCanvas = cleanReceipt(state.srcCanvas);

    busy('Читам QR код…');
    await tick();
    const qrText = await decodeReceiptQR(state.srcCanvas);

    let bi = '';
    if (qrText && qrText.includes('vl=')) {
      try {
        const vl = new URL(qrText).searchParams.get('vl') || '';
        if (vl) bi = biFromVl(vl);
      } catch (e) {}
    }
    state.bi = bi;
    state.source = bi ? 'qr' : 'man';
    fillStep2();
    showStep(2);
  } catch (e) {
    console.error(e);
    alert('Грешка при обради слике: ' + e.message);
  } finally {
    busyOff();
  }
}

function fillStep2() {
  $('#s2ime').value   = $('#ime').value.trim();
  $('#s2bi').value    = state.bi;
  $('#s2datum').value = todayISO();          // подразумевано данашњи датум — корисник мења ако треба
  syncMonth();

  const badge = $('#s2src');
  if (state.source === 'qr') { badge.textContent = 'из QR кода ✓'; badge.className = 'srcbadge src-qr'; }
  else { badge.textContent = 'ручни унос'; badge.className = 'srcbadge src-man'; }
  $('#s2note').classList.toggle('hidden', state.source === 'qr');

  $('#s2preview').src = state.cleanCanvas.toDataURL('image/png');
}
function syncMonth() {
  const p = inputToParts($('#s2datum').value);
  const sel = $('#s2mesec');
  sel.innerHTML = '';
  for (let i = 1; i <= 12; i++) {
    const o = document.createElement('option');
    o.value = i; o.textContent = MESECI[i];
    if (p && p.mm === i) o.selected = true;
    sel.appendChild(o);
  }
}

// ── KORAK 2 -> 3: PDF ────────────────────────────────────────────────────────
function drawJustified(ctx, text, x, y, maxW, lineH) {
  const words = text.split(/\s+/).filter(Boolean);
  const space = ctx.measureText(' ').width;
  let line = [];
  const flush = (last) => {
    if (!line.length) return;
    const wordW = line.reduce((s,w)=>s+ctx.measureText(w).width, 0);
    let gap = space;
    if (!last && line.length > 1) gap = (maxW - wordW) / (line.length - 1);
    let cx = x;
    for (const w of line) { ctx.fillText(w, cx, y); cx += ctx.measureText(w).width + gap; }
    y += lineH; line = [];
  };
  for (const w of words) {
    const test = line.concat(w);
    const tw = test.reduce((s,ww)=>s+ctx.measureText(ww).width, 0) + space*(test.length-1);
    if (tw > maxW && line.length) { flush(false); line = [w]; }
    else line.push(w);
  }
  flush(true);
  return y;
}

async function buildIzjavaCanvas(o) {
  const W = 1654, H = 2339;                       // A4 @ ~200 dpi
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#000';
  const M = 165, CW = W - 2*M;
  const FONT = '"DejaVu Sans","Liberation Sans","Segoe UI",sans-serif';

  // naslov
  ctx.textAlign = 'center';
  ctx.font = `bold 60px ${FONT}`;
  ctx.fillText('И З Ј А В А', W/2, 255);

  // telo
  ctx.textAlign = 'left';
  ctx.font = `33px ${FONT}`;
  const body =
    `Ја ${o.ime} запослен/а у ${o.firma}, изјављујем да се ` +
    `фискални рачун за купљено гориво број ${o.bi} од ${o.datum} године односи на ` +
    `гориво које сам купио/ла на име трошкова сопственог превоза за долазак и одлазак ` +
    `са рада током месеца ${o.mesec} - ${o.godina} године.`;
  let y = drawJustified(ctx, body, M, 410, CW, 53);

  // potpis blok
  const sigY = y + 80;
  ctx.font = `28px ${FONT}`;
  ctx.textAlign = 'left';
  ctx.fillText(`У ${o.grad}, ${o.danas} године`, M, sigY + 165);

  const rw = 470, rx = W - M - rw;
  ctx.textAlign = 'center';
  ctx.fillText('Запослени/а', rx + rw/2, sigY);
  if (o.potpis && o.potpis.width > 0 && o.potpis.height > 0) {
    let ph = 145, pw = o.potpis.width * (ph / o.potpis.height);
    if (pw > rw - 60) { pw = rw - 60; ph = o.potpis.height * (pw / o.potpis.width); }
    ctx.drawImage(o.potpis, rx + rw/2 - pw/2, sigY + 22, pw, ph);
  }
  ctx.strokeStyle = '#000'; ctx.lineWidth = 1.6;
  ctx.beginPath(); ctx.moveTo(rx + 25, sigY + 185); ctx.lineTo(rx + rw - 25, sigY + 185); ctx.stroke();

  // račun
  let ry = sigY + 270;
  ctx.fillStyle = '#555'; ctx.font = `24px ${FONT}`; ctx.textAlign = 'center';
  ctx.fillText('Прилог: фискални рачун', W/2, ry);
  ctx.fillStyle = '#000';
  ry += 28;
  const availW = 980, availH = H - M - ry;
  const r = o.receipt;
  const sc = Math.min(availW / r.width, availH / r.height);
  const dw = r.width*sc, dh = r.height*sc;
  ctx.drawImage(r, W/2 - dw/2, ry, dw, dh);
  return c;
}

async function onGenerate() {
  const ime = $('#s2ime').value.trim();
  const bi  = $('#s2bi').value.trim();
  const dp  = inputToParts($('#s2datum').value);
  if (!ime) { alert('Унесите име и презиме.'); return; }
  if (!bi)  { alert('Унесите број рачуна (БИ).'); return; }
  if (!dp)  { alert('Изаберите датум рачуна.'); return; }
  const mesecIdx = +$('#s2mesec').value;

  try {
    busy('Правим PDF…');
    await tick();
    let potpis = null;
    const sig = localStorage.getItem('fisk_potpis');
    if (sig) {
      potpis = await new Promise(res => {
        const img = new Image();
        img.onload = () => res(img.width > 0 && img.height > 0 ? img : null);
        img.onerror = () => res(null);
        img.src = sig;
      });
    }

    const danas = new Date();
    const dd = String(danas.getDate()).padStart(2,'0');
    const mm = String(danas.getMonth()+1).padStart(2,'0');
    const canvas = await buildIzjavaCanvas({
      ime, firma: cfg('firma'), grad: cfg('grad'),
      bi, datum: dp.ddmmyyyy,
      mesec: MESECI[mesecIdx], godina: dp.yyyy,
      danas: `${dd}/${mm}/${danas.getFullYear()}`,
      receipt: state.cleanCanvas, potpis,
    });

    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
    pdf.addImage(canvas.toDataURL('image/jpeg', 0.95), 'JPEG', 0, 0, 210, 297);
    state.pdfBlob = pdf.output('blob');
    state.pdfName = `izjava_${bi}_${dp.yyyy}-${String(dp.mm).padStart(2,'0')}-${$('#s2datum').value.slice(8)}.pdf`;

    // korak 3
    $('#s3preview').src = canvas.toDataURL('image/jpeg', 0.9);
    state.email = {
      subject: `Изјава — фискални рачун за гориво бр. ${bi} (${dp.ddmmyyyy})`,
      body:
        `Поштовани,\n\n` +
        `У прилогу достављам изјаву са фискалним рачуном за гориво број ${bi} ` +
        `од ${dp.ddmmyyyy}. године.\n\n` +
        `(Прилог: преузети PDF — ${state.pdfName})\n\n` +
        `Срдачан поздрав,\n${ime}`,
    };
    $('#s3to').textContent = cfg('email') ? 'Прималац: ' + cfg('email') : '';
    showStep(3);
  } catch (e) {
    console.error(e);
    alert('Грешка при прављењу PDF-а: ' + e.message);
  } finally {
    busyOff();
  }
}

function downloadPdf() {
  const url = URL.createObjectURL(state.pdfBlob);
  const a = document.createElement('a');
  a.href = url; a.download = state.pdfName;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  $('#s3sent').classList.remove('hidden');
}
// Подели — Web Share API: на Android-у отвара нативни „Подели" мени и
// качи PDF као прави прилог (Gmail, Viber…). Тражи secure context (HTTPS).
// Fallback (десктоп / без подршке): преузми PDF + отвори mailto нацрт.
async function shareOrMail() {
  const file = new File([state.pdfBlob], state.pdfName, { type: 'application/pdf' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({
        files: [file],
        title: state.email.subject,
        text:  state.email.body,
      });
      $('#s3sent').classList.remove('hidden');
      return;
    } catch (e) {
      if (e && e.name === 'AbortError') return;   // корисник одустао
      // било која друга грешка → падни на fallback
    }
  }
  // fallback: преузми PDF, па отвори mailto нацрт
  downloadPdf();
  setTimeout(() => {
    window.location.href =
      `mailto:${cfg('email')}?subject=${encodeURIComponent(state.email.subject)}` +
      `&body=${encodeURIComponent(state.email.body)}`;
  }, 700);
}

// ── navigacija / UI ──────────────────────────────────────────────────────────
function showStep(n) {
  for (let i = 1; i <= 3; i++) {
    $('#step' + i).classList.toggle('hidden', i !== n);
    const tab = $('#tab' + i);
    tab.classList.toggle('active', i === n);
    tab.classList.toggle('done', i < n);
  }
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
function busy(msg) { $('#busyMsg').textContent = msg; $('#busy').classList.remove('hidden'); }
function busyOff() { $('#busy').classList.add('hidden'); }
const tick = () => new Promise(r => setTimeout(r, 30));   // pusti UI da se osveži

// ── init ─────────────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  loadProfile();

  for (const k of PROFILE_KEYS) $('#' + k).addEventListener('blur', saveProfile);

  function onReceiptPicked(e) {
    const f = e.target.files[0];
    if (!f) return;
    // ако корисник изабере преко једног инпута, очисти други (да onProcess узме исправно)
    const other = e.target.id === 'racunCamera' ? $('#racunFile') : $('#racunCamera');
    other.value = '';
    const box = $('#fileBox');
    box.classList.add('has');
    $('#fileLabel').textContent = f.name;
    $('#fileSub').textContent = 'кликни да промениш';
  }
  $('#racunCamera').addEventListener('change', onReceiptPicked);
  $('#racunFile').addEventListener('change', onReceiptPicked);

  async function handleSignature(e) {
    const f = e.target.files[0];
    e.target.value = '';                    // да исти фајл може поново да се изабере
    if (!f) return;
    try {
      const dataUrl = await processSignature(f);
      localStorage.setItem('fisk_potpis', dataUrl);
      $('#sigPreview').src = dataUrl;
      $('#sigPreview').classList.remove('hidden');
      $('#sigClear').classList.remove('hidden');
      $('#sigStatus').textContent = 'потпис сачуван ✓';
    } catch (err) { alert('Не могу да учитам потпис: ' + err.message); }
  }
  $('#sigCamera').addEventListener('change', handleSignature);   // 📷 камера
  $('#sigFile').addEventListener('change', handleSignature);     // 📁 из галерије
  $('#sigClear').addEventListener('click', () => {
    localStorage.removeItem('fisk_potpis');
    $('#sigPreview').src = '';
    $('#sigPreview').classList.add('hidden');
    $('#sigClear').classList.add('hidden');
    $('#sigStatus').textContent = 'потпис се памти на овом уређају';
  });

  $('#btnProcess').addEventListener('click', onProcess);
  $('#btnBack2').addEventListener('click', () => showStep(1));
  $('#btnGenerate').addEventListener('click', onGenerate);
  $('#btnBack3').addEventListener('click', () => showStep(2));
  $('#s2datum').addEventListener('change', syncMonth);
  $('#btnDownload').addEventListener('click', downloadPdf);
  $('#btnShare').addEventListener('click', shareOrMail);
  $('#btnNew').addEventListener('click', () => location.reload());

  // ── PWA: дугме за инсталацију (увек видљиво, осим ако је већ инсталирано) ──
  let deferredPrompt = null;
  const installBtn = $('#installBtn');
  const isStandalone = () =>
    window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  if (isStandalone()) installBtn.classList.add('hidden');
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();          // задржи догађај да га искористимо на клик
    deferredPrompt = e;
  });
  installBtn.addEventListener('click', async () => {
    if (isStandalone()) { alert('Апликација је већ инсталирана.'); return; }
    if (deferredPrompt) {
      deferredPrompt.prompt();
      try { await deferredPrompt.userChoice; } catch (e) {}
      deferredPrompt = null;
      return;
    }
    // прегледач још није понудио инсталацију (или iOS Safari) — ручно упутство
    const isIos = /iPad|iPhone|iPod/.test(navigator.userAgent);
    alert(isIos
      ? 'iPhone/iPad (Safari): тапни „Подели" (□↑) → „Add to Home Screen" → „Add".'
      : 'Android (Chrome): мени (⋮) → „Add to Home screen" / „Install app".\n'
      + 'Ако опција не постоји, сачекај пар секунди — прегледач понуди инсталацију сам.');
  });
  window.addEventListener('appinstalled', () => installBtn.classList.add('hidden'));
});

// ── PWA: service worker ──
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('service-worker.js', { updateViaCache: 'none' })
      .catch(() => { /* best-effort */ });
  });
}
