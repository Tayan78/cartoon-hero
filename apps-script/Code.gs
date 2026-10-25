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
 * Skriptet skapar själv flikarna "Skanningar", "Lager" och "Annonser" och Drive-mapparna
 * "Loppisskannern/Skanningar" och "Loppisskannern/Annonser".
 *
 * Annonsläget: appen skapar annonsen (addListing), laddar upp upp till 8 bilder en i
 * taget (addListingImage) och lägger den i kön (commitListing).
 * En timer kör processQueue varje minut medan något väntar och anropar Vercel
 * (/api/listing-process) en annons i taget – appen kan vara stängd under tiden.
 * Efter att du klistrat in en ny version: kör funktionen setup en gång från
 * editorn, så att skriptet får lov att dela bilder, starta timern och anropa Vercel.
 */

var SCAN_HEADERS = [
  'Tid', 'Skannings-ID', 'Bild', 'Namn', 'Kategori', 'Märke', 'Modell', 'Artikelnr', 'Ålder', 'Skick',
  'ID-säkerhet', 'Pris lågt', 'Pris median', 'Pris högt', 'Jämförelser', 'Pris-säkerhet', 'Inga Tradera-träffar',
  'Intl median (SEK)', 'Inköpspris', 'Avgift', 'Frakt', 'Netto', 'Köp-poäng', 'Verdict', 'Motivering',
  'Bästa plattform', 'Flaggor', 'Källor', 'Modell (AI)', 'Input-token', 'Output-token', 'Sökningar',
  'Kostnad USD', 'Kostnad SEK', 'Tid (ms)', 'JSON',
  'Lägg ut för', 'Bud ned till', 'Lägst till salu', 'Högst till salu', 'Antal till salu', 'Info',
  'Färg', 'Vinst', 'Multipel', 'Betala max', 'Osäkert pris', 'Småfigur'
];

var INVENTORY_HEADERS = [
  'Sparad', 'Skannings-ID', 'Bild', 'Namn', 'Kategori', 'Märke', 'Modell', 'Skick', 'Inköpspris',
  'Pris median', 'Netto', 'Köp-poäng', 'Bästa plattform', 'Status', 'Artikelnr',
  'Lägg ut för', 'Bud ned till', 'Info',
  'Beslut', 'Färg', 'Vinst', 'Multipel'
];

var LISTING_HEADERS = [
  'Skapad', 'Annons-ID', 'Status', 'Huvudbild', 'Bilder', 'Anteckning', 'Rubrik', 'Beskrivning', 'Pris', 'Kanal',
  'Modellnummer', 'Bekräftat', 'Namn', 'Märke', 'Kategori', 'Prisgrund', 'Kostnad SEK', 'Fel', 'Uppdaterad',
  'I lager', 'Bild-ID', 'Inställningar', 'JSON'
];

var COLORS = { green: 'Grön', yellow: 'Gul', red: 'Röd', none: '–' };

// Köpbeslutet från servern (kolumnen Köp-poäng används inte längre).
function decisionCells(d) {
  d = d || {};
  return [
    COLORS[d.color] || '',
    d.known ? d.profit : '',
    d.known ? Math.floor(d.multiple * 10 + 1e-9) / 10 : '',
    d.pay_max || ''
  ];
}

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
      if (body.action === 'addListing') return reply(addListing(body));
      if (body.action === 'addListingImage') return reply(addListingImage(body));
      if (body.action === 'commitListing') return reply(commitListing(body));
      if (body.action === 'listListings') return reply(listListings());
      if (body.action === 'updateListing') return reply(updateListing(body));
      if (body.action === 'requeueListing') return reply(requeueListing(body));
      if (body.action === 'deleteListing') return reply(deleteListing(body));
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
  var fs = r.for_sale || {};

  var imageUrl = '';
  if (body.image) imageUrl = saveImage(body.image, body.scan_id);

  var sources = (r.sources || []).map(function (s) {
    return s.platform + ' ' + s.price_sek + ' kr' + (s.sold ? '' : ' (ej såld)') + ' – ' + s.url;
  }).join('\n');

  sheet('Skanningar', SCAN_HEADERS).appendRow([
    new Date(), body.scan_id, imageUrl ? '=HYPERLINK("' + imageUrl + '","Bild")' : '',
    item.name, item.category, item.brand, item.model, item.article_number, item.age, item.condition,
    item.confidence_id, p.low, p.median, p.high, p.comparables, p.confidence, p.no_tradera_data ? 'Ja' : '',
    (p.international || {}).median, ec.buy_price, ec.fees, ec.shipping, ec.net_profit, '', r.verdict,
    r.reason, r.best_platform, (r.flags || []).join(' '), sources, body.model, cost.input_tokens,
    cost.output_tokens, cost.web_searches, cost.usd, cost.sek, body.duration_ms, JSON.stringify(r),
    ec.list_price, ec.bid_floor || '', fs.low || '', fs.high || '', fs.count || 0, r.note || ''
  ].concat(decisionCells(r.decision), [
    (r.decision || {}).uncertain ? 'Ja' : '', (r.decision || {}).small ? 'Ja' : ''
  ]));
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
    '', r.best_platform, 'Ny', item.article_number,
    ec.list_price, ec.bid_floor || '', r.note || ''
  ].concat([r.verdict || ''], decisionCells(r.decision).slice(0, 3)));
  return { ok: true };
}

// ---------- Annonsläget ----------

function listingSheet() {
  return sheet('Annonser', LISTING_HEADERS);
}

// Kolumnnummer (1-baserat) per rubrik, så att ordningen kan ändras utan att något går sönder.
function cols(sh) {
  var head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var map = {};
  head.forEach(function (h, i) { map[h] = i + 1; });
  return map;
}

function rowById(sh, id) {
  var last = sh.getLastRow();
  if (last < 2) return 0;
  var ids = sh.getRange(2, cols(sh)['Annons-ID'], last - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) if (String(ids[i][0]) === String(id)) return i + 2;
  return 0;
}

function setCells(sh, row, values) {
  var c = cols(sh);
  values['Uppdaterad'] = new Date();
  Object.keys(values).forEach(function (k) {
    if (c[k]) sh.getRange(row, c[k]).setValue(values[k]);
  });
}

// Publik bildadress (ProLister kräver bilder som går att nå utan inloggning).
function imageUrl(fileId) {
  return 'https://lh3.googleusercontent.com/d/' + fileId;
}

var MAX_LISTING_IMAGES = 8;

function listingFolder(id) {
  var root = getOrCreateFolder(getOrCreateFolder(DriveApp.getRootFolder(), 'Loppisskannern'), 'Annonser');
  return getOrCreateFolder(root, id);
}

// Steg 1: skapar annonsen. Skickas samma annons igen (t.ex. efter ett avbrott)
// börjar uppladdningen om från början.
function addListing(body) {
  if (body.process_url) PropertiesService.getScriptProperties().setProperty('PROCESS_URL', body.process_url);
  var sh = listingSheet();
  var existing = rowById(sh, body.id);
  if (existing) {
    var status = sh.getRange(existing, cols(sh)['Status']).getValue();
    if (status !== 'Laddar upp') return { ok: true, duplicate: true };
    trashImages(sh, existing);
    setCells(sh, existing, { 'Huvudbild': '', 'Bilder': '', 'Bild-ID': '', 'Anteckning': body.note || '' });
    return { ok: true };
  }
  var row = {};
  LISTING_HEADERS.forEach(function (h) { row[h] = ''; });
  row['Skapad'] = new Date();
  row['Annons-ID'] = body.id;
  row['Status'] = 'Laddar upp';
  row['Anteckning'] = body.note || '';
  row['Uppdaterad'] = new Date();
  row['Inställningar'] = JSON.stringify(body.settings || {});
  sh.appendRow(LISTING_HEADERS.map(function (h) { return row[h]; }));
  return { ok: true };
}

// Steg 2: en bild i taget, i ordning (första = huvudbild).
function addListingImage(body) {
  var sh = listingSheet();
  var row = rowById(sh, body.id);
  if (!row) return { ok: false, error: 'Annonsen finns inte' };
  var c = cols(sh);
  var ids = String(sh.getRange(row, c['Bild-ID']).getValue() || '').split(',').filter(String);
  if (ids.length >= MAX_LISTING_IMAGES) return { ok: false, error: 'Max ' + MAX_LISTING_IMAGES + ' bilder' };
  var m = /^data:(image\/[a-z]+);base64,(.+)$/.exec(body.image || '');
  if (!m) return { ok: false, error: 'Ogiltig bild' };
  var file = listingFolder(body.id).createFile(
    Utilities.newBlob(Utilities.base64Decode(m[2]), m[1], body.id + '-' + (ids.length + 1) + '.jpg')
  );
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  ids.push(file.getId());
  var urls = ids.map(imageUrl);
  setCells(sh, row, { 'Huvudbild': '=IMAGE("' + urls[0] + '")', 'Bilder': urls.join(','), 'Bild-ID': ids.join(',') });
  return { ok: true, image_url: urls[urls.length - 1] };
}

// Steg 3: annonsen läggs i kön.
function commitListing(body) {
  var sh = listingSheet();
  var row = rowById(sh, body.id);
  if (!row) return { ok: false, error: 'Annonsen finns inte' };
  if (!sh.getRange(row, cols(sh)['Bild-ID']).getValue()) return { ok: false, error: 'Inga bilder uppladdade' };
  setCells(sh, row, { 'Status': 'Väntar' });
  ensureQueueTrigger();
  return { ok: true };
}

function trashImages(sh, row) {
  var ids = String(sh.getRange(row, cols(sh)['Bild-ID']).getValue() || '').split(',').filter(String);
  ids.forEach(function (id) { try { DriveApp.getFileById(id).setTrashed(true); } catch (e) {} });
}

function listListings() {
  var sh = listingSheet();
  var last = sh.getLastRow();
  if (last < 2) return { ok: true, listings: [] };
  var c = cols(sh);
  var rows = sh.getRange(2, 1, last - 1, sh.getLastColumn()).getValues();
  var get = function (r, h) { return c[h] ? r[c[h] - 1] : ''; };
  var listings = rows.map(function (r) {
    var data = null;
    try { data = JSON.parse(get(r, 'JSON') || 'null'); } catch (e) {}
    return {
      id: String(get(r, 'Annons-ID')),
      created: get(r, 'Skapad'),
      status: get(r, 'Status'),
      note: get(r, 'Anteckning'),
      image_urls: String(get(r, 'Bilder') || '').split(',').filter(String),
      title: get(r, 'Rubrik'),
      description: get(r, 'Beskrivning'),
      price: get(r, 'Pris'),
      channel: get(r, 'Kanal'),
      confirmed: String(get(r, 'Bekräftat') || ''),
      error: get(r, 'Fel'),
      in_inventory: get(r, 'I lager') === 'Ja',
      listing: data
    };
  });
  return { ok: true, listings: listings.reverse().slice(0, 200) };
}

function updateListing(body) {
  var sh = listingSheet();
  var row = rowById(sh, body.id);
  if (!row) return { ok: false, error: 'Annonsen finns inte' };
  var f = body.fields || {};
  var values = {};
  if (f.title !== undefined) values['Rubrik'] = f.title;
  if (f.description !== undefined) values['Beskrivning'] = f.description;
  if (f.price !== undefined) values['Pris'] = f.price;
  if (f.channel !== undefined) values['Kanal'] = f.channel;
  if (f.confirmed !== undefined) values['Bekräftat'] = f.confirmed;
  if (f.status !== undefined) values['Status'] = f.status;
  setCells(sh, row, values);
  if (f.status === 'Godkänd') addListingToInventory(sh, row);
  return { ok: true };
}

// Godkända annonser blir en rad i Lager (en gång per annons).
function addListingToInventory(sh, row) {
  var c = cols(sh);
  var r = sh.getRange(row, 1, 1, sh.getLastColumn()).getValues()[0];
  var get = function (h) { return c[h] ? r[c[h] - 1] : ''; };
  if (get('I lager') === 'Ja') return;
  var data = {};
  try { data = JSON.parse(get('JSON') || '{}'); } catch (e) {}
  var item = data.item || {};
  var url = String(get('Bilder') || '').split(',')[0];
  sheet('Lager', INVENTORY_HEADERS).appendRow([
    new Date(), get('Annons-ID'), url ? '=HYPERLINK("' + url + '","Bild")' : '', get('Rubrik') || item.name, item.category,
    item.brand, item.model, item.condition, '', '', '', '', get('Kanal'), 'Annons godkänd', get('Bekräftat') || get('Modellnummer'),
    get('Pris'), '', get('Anteckning'), '', '', '', ''
  ]);
  setCells(sh, row, { 'I lager': 'Ja' });
}

function requeueListing(body) {
  var sh = listingSheet();
  var row = rowById(sh, body.id);
  if (!row) return { ok: false, error: 'Annonsen finns inte' };
  setCells(sh, row, { 'Status': 'Väntar', 'Bekräftat': body.confirmed || '', 'Fel': '' });
  ensureQueueTrigger();
  return { ok: true };
}

function deleteListing(body) {
  var sh = listingSheet();
  var row = rowById(sh, body.id);
  if (!row) return { ok: true };
  trashImages(sh, row);
  sh.deleteRow(row);
  return { ok: true };
}

// ---------- Kön ----------

function ensureQueueTrigger() {
  var has = ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'processQueue'; });
  if (!has) ScriptApp.newTrigger('processQueue').timeBased().everyMinutes(1).create();
}

function removeQueueTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'processQueue') ScriptApp.deleteTrigger(t);
  });
}

// Körs av timern varje minut medan något väntar. Tar en annons i taget i upp
// till 4 minuter, och stänger av timern när kön är tom.
function processQueue() {
  var props = PropertiesService.getScriptProperties();
  if (Number(props.getProperty('QUEUE_BUSY_UNTIL') || 0) > Date.now()) return;
  var started = Date.now();
  props.setProperty('QUEUE_BUSY_UNTIL', String(started + 6 * 60 * 1000));
  try {
    while (Date.now() - started < 4 * 60 * 1000) {
      var job = claimNext();
      if (!job) { removeQueueTrigger(); break; }
      runJob(job);
    }
  } finally {
    props.deleteProperty('QUEUE_BUSY_UNTIL');
  }
}

// Nästa annons med status Väntar (eller som fastnat i Bearbetas i över 10 minuter).
function claimNext() {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var sh = listingSheet();
    var last = sh.getLastRow();
    if (last < 2) return null;
    var c = cols(sh);
    var rows = sh.getRange(2, 1, last - 1, sh.getLastColumn()).getValues();
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      var status = r[c['Status'] - 1];
      var updated = new Date(r[c['Uppdaterad'] - 1]).getTime() || 0;
      if (status === 'Väntar' || (status === 'Bearbetas' && Date.now() - updated > 10 * 60 * 1000)) {
        setCells(sh, i + 2, { 'Status': 'Bearbetas' });
        var settings = {};
        try { settings = JSON.parse(r[c['Inställningar'] - 1] || '{}'); } catch (e) {}
        return {
          id: String(r[c['Annons-ID'] - 1]),
          note: r[c['Anteckning'] - 1],
          confirmed: String(r[c['Bekräftat'] - 1] || ''),
          fileIds: String(r[c['Bild-ID'] - 1] || '').split(',').filter(String),
          settings: settings
        };
      }
    }
    return null;
  } finally {
    lock.releaseLock();
  }
}

function runJob(job) {
  var props = PropertiesService.getScriptProperties();
  var url = props.getProperty('PROCESS_URL');
  var result;
  try {
    if (!url) throw new Error('PROCESS_URL saknas – skicka en annons från appen först');
    // AI:n får högst 3 bilder (huvudbilden först); alla följer ändå med annonsen.
    var images = job.fileIds.slice(0, 3).map(function (id) {
      return Utilities.base64Encode(DriveApp.getFileById(id).getBlob().getBytes());
    });
    var res = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      headers: { 'x-script-secret': props.getProperty('SECRET') },
      payload: JSON.stringify({ id: job.id, images: images, note: job.note, confirmed: job.confirmed, settings: job.settings }),
      muteHttpExceptions: true
    });
    result = JSON.parse(res.getContentText());
    if (!result.ok) throw new Error(result.error || ('Vercel svarade ' + res.getResponseCode()));
  } catch (err) {
    result = { ok: false, error: String(err.message || err) };
  }

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var sh = listingSheet();
    var row = rowById(sh, job.id);
    if (!row) return; // borttagen under tiden
    if (!result.ok) {
      setCells(sh, row, { 'Status': 'Fel', 'Fel': result.error });
      return;
    }
    var l = result.listing;
    var item = l.item || {};
    setCells(sh, row, {
      'Status': 'Klar',
      'Rubrik': l.title,
      'Beskrivning': l.description,
      'Pris': l.price || '',
      'Kanal': l.channel,
      'Modellnummer': l.article && l.article.number ? l.article.number : '',
      'Namn': item.name,
      'Märke': item.brand,
      'Kategori': item.category,
      'Prisgrund': l.list_basis,
      'Kostnad SEK': (l.cost || {}).sek,
      'Fel': '',
      'JSON': JSON.stringify(l)
    });
  } finally {
    lock.releaseLock();
  }
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
    return sh;
  }
  // Nya kolumner i senare versioner läggs till sist i en befintlig flik.
  var existing = sh.getLastColumn();
  if (existing < headers.length) {
    sh.getRange(1, existing + 1, 1, headers.length - existing)
      .setValues([headers.slice(existing)])
      .setFontWeight('bold');
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
  listingSheet();
  folder();
  // Behörigheter för annonsläget: dela bilder, timer och anrop till Vercel.
  ScriptApp.getProjectTriggers();
  UrlFetchApp.getRequest('https://example.com');
}
