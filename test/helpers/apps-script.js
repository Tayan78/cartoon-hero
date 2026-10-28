// Kör apps-script/Code.gs i Node med en låtsad Google Sheet, så att Vercel-koden
// kan testas mot den riktiga Apps Script-koden. store(action, payload) fungerar
// som callAppsScript.
import { readFileSync } from "node:fs";
import vm from "node:vm";

class Range {
  constructor(sh, r, c, nr = 1, nc = 1) {
    Object.assign(this, { sh, r, c, nr, nc });
  }
  getValues() {
    return Array.from({ length: this.nr }, (_, i) => Array.from({ length: this.nc }, (_, j) => this.sh.cell(this.r + i, this.c + j)));
  }
  setValues(v) {
    v.forEach((row, i) => row.forEach((x, j) => this.sh.set(this.r + i, this.c + j, x)));
    return this;
  }
  setValue(x) {
    this.sh.set(this.r, this.c, x);
    return this;
  }
  clearContent() {
    for (let i = 0; i < this.nr; i++) for (let j = 0; j < this.nc; j++) this.sh.set(this.r + i, this.c + j, "");
    return this;
  }
  setFontWeight() {
    return this;
  }
}

class Sheet {
  rows = [];
  cell(r, c) {
    return this.rows[r - 1]?.[c - 1] ?? "";
  }
  set(r, c, x) {
    while (this.rows.length < r) this.rows.push([]);
    this.rows[r - 1][c - 1] = x;
  }
  appendRow(a) {
    this.rows.push([...a]);
  }
  getLastRow() {
    return this.rows.length;
  }
  getLastColumn() {
    return Math.max(0, ...this.rows.map((r) => r.length));
  }
  getRange(r, c, nr, nc) {
    return new Range(this, r, c, nr, nc);
  }
  deleteRows(start, n) {
    this.rows.splice(start - 1, n);
  }
  setFrozenRows() {}
}

export function fakeAppsScript() {
  const sheets = {};
  const props = { SECRET: "s" };
  const triggers = [];
  const ctx = {
    SpreadsheetApp: { getActiveSpreadsheet: () => ({ getSheetByName: (n) => sheets[n] ?? null, insertSheet: (n) => (sheets[n] = new Sheet()) }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => props[k] ?? null, setProperty: (k, v) => (props[k] = v), deleteProperty: (k) => delete props[k] }) },
    ScriptApp: {
      getProjectTriggers: () => [...triggers],
      deleteTrigger: (t) => triggers.splice(triggers.indexOf(t), 1),
      newTrigger: (fn) => {
        const b = { timeBased: () => b, atHour: () => b, everyDays: () => b, everyMinutes: () => b, create: () => triggers.push({ getHandlerFunction: () => fn }) };
        return b;
      },
    },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    ContentService: { createTextOutput: (text) => ({ setMimeType: () => ({ text }) }), MimeType: { JSON: "json" } },
  };
  vm.createContext(ctx);
  vm.runInContext(readFileSync(new URL("../../apps-script/Code.gs", import.meta.url), "utf8"), ctx);
  // Som Vercel: allt går genom doPost med hemligheten. JSON fram och tillbaka (datum blir ISO).
  const store = async (action, payload) => {
    ctx.__e = { postData: { contents: JSON.stringify({ secret: "s", action, ...payload }) } };
    return JSON.parse(vm.runInContext("doPost(__e)", ctx).text);
  };
  const table = (name) => {
    const [head, ...rows] = sheets[name]?.rows ?? [[]];
    return rows.map((r) => Object.fromEntries(head.map((h, i) => [h, Object.prototype.toString.call(r[i]) === "[object Date]" ? r[i].toISOString() : r[i] ?? ""])));
  };
  return { store, sheets, props, triggers, table, run: (code) => vm.runInContext(code, ctx) };
}
