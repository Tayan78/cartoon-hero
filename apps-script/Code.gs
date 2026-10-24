/**
 * Loppisskannern – lagring i Google Drive och Google Sheets.
 *
 * Installation (se README):
 *  1. Skapa ett nytt Google Sheet, t.ex. "Loppisskannern".
 *  2. Tillägg → Apps Script. Klistra in den här filen som Code.gs.
 *  3. Projektinställningar → Skriptegenskaper: lägg till SECRET = samma värde som APPS_SCRIPT_SECRET i Vercel.
 *  4. Driftsätt → Ny driftsättning → Webbapp. Kör som: Jag. Åtkomst: Alla.
 *     Kopiera URL:en (slutar på /exec) till APPS_SCRIPT_URL i Vercel.
 *
 * Skriptet skapar själv flikarna "Skanningar" och "Lager" och Drive-mappen "Loppisskannern/Skanningar".
 */

var SCAN_HEADERS = [
  'Tid', 'Skannings-ID', 'Bild', 'Namn', 'Kategori', 'Märke', 'Modell', 'Artikelnr', 'Ålder', 'Skick',
  'ID-säkerhet', 'Pris lågt', 'Pris median', 'Pris högt', 'Jämförelser', 'Pris-säkerhet', 'Inga Tradera-träffar',
  'Intl median (SEK)', 'Inköpspris', 'Avgift', 'Frakt', 'Netto', 'Köp-poäng', 'Verdict', 'Motivering',
  'Bästa plattform', 'Flaggor', 'Källor', 'Modell (AI)', 'Input-token', 'Output-token', 'Sökningar',
  'Kostnad USD', 'Kostnad SEK', 'Tid (ms)', 'JSON'
];

var INVENTORY_HEADERS = [
  'Sparad', 'Skannings-ID', 'Bild', 'Namn', 'Kategori', 'Märke', 'Modell', 'Skick', 'Inköpspris',
  'Pris median', 'Netto', 'Köp-poäng', 'Bästa plattform', 'Status'
];

function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);
    var secret = PropertiesService.getScriptProperties().getProperty('SECRET');
    if (!secret || body.secret !== secret) return reply({ ok: false, error: 'Fel hemlighet' });

    var lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      if (body.action === 'logScan') return reply(logScan(body));
      if (body.action === 'saveInventory') return reply(saveInventory(body));
      return reply({ ok: false, error: 'Okänd action' });
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    return reply({ ok: false, error: String(err) });
  }
}

function logScan(body) {
  var r = body.result || {};
  var item = r.item || {};
  var p = r.price_sek || {};
  var ec = r.economics || {};
  var cost = body.cost || {};

  var imageUrl = '';
  if (body.image) imageUrl = saveImage(body.image, body.scan_id);

  var sources = (r.sources || []).map(function (s) {
    return s.platform + ' ' + s.price_sek + ' kr' + (s.sold ? '' : ' (ej såld)') + ' – ' + s.url;
  }).join('\n');

  sheet('Skanningar', SCAN_HEADERS).appendRow([
    new Date(), body.scan_id, imageUrl ? '=HYPERLINK("' + imageUrl + '","Bild")' : '',
    item.name, item.category, item.brand, item.model, item.article_number, item.age, item.condition,
    item.confidence_id, p.low, p.median, p.high, p.comparables, p.confidence, p.no_tradera_data ? 'Ja' : '',
    (p.international || {}).median, ec.buy_price, ec.fees, ec.shipping, ec.net_profit, r.buy_score, r.verdict,
    r.reason, r.best_platform, (r.flags || []).join(' '), sources, body.model, cost.input_tokens,
    cost.output_tokens, cost.web_searches, cost.usd, cost.sek, body.duration_ms, JSON.stringify(r)
  ]);
  return { ok: true, image_url: imageUrl };
}

function saveInventory(body) {
  var r = body.result || {};
  var item = r.item || {};
  var ec = r.economics || {};
  var url = body.image_url || '';
  sheet('Lager', INVENTORY_HEADERS).appendRow([
    new Date(), body.scan_id, url ? '=HYPERLINK("' + url + '","Bild")' : '', item.name, item.category,
    item.brand, item.model, item.condition, ec.buy_price, (r.price_sek || {}).median, ec.net_profit,
    r.buy_score, r.best_platform, 'Ny'
  ]);
  return { ok: true };
}

function saveImage(dataUrl, scanId) {
  var m = /^data:(image\/[a-z]+);base64,(.+)$/.exec(dataUrl);
  if (!m) return '';
  var ext = m[1] === 'image/png' ? 'png' : 'jpg';
  var blob = Utilities.newBlob(Utilities.base64Decode(m[2]), m[1], scanId + '.' + ext);
  return folder().createFile(blob).getUrl();
}

function folder() {
  var root = getOrCreateFolder(DriveApp.getRootFolder(), 'Loppisskannern');
  return getOrCreateFolder(root, 'Skanningar');
}

function getOrCreateFolder(parent, name) {
  var it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}

function sheet(name, headers) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.appendRow(headers);
    sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, headers.length).setFontWeight('bold');
  }
  return sh;
}

function reply(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/** Kör en gång från editorn för att godkänna behörigheter och skapa flikar/mapp. */
function setup() {
  sheet('Skanningar', SCAN_HEADERS);
  sheet('Lager', INVENTORY_HEADERS);
  folder();
}
