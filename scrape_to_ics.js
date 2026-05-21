import { chromium } from "playwright";
import fs from "fs";
import { DateTime } from "luxon";

// CONFIGURAZIONE URL
const LOGIN_URL  = "https://itsar.registrodiclasse.it/geopcfp2/";
const CAL_URL    = "https://itsar.registrodiclasse.it/geopcfp2/";
const USER_SEL   = 'input[name="username"]';
const PASS_SEL   = 'input[name="password"]';
const SUBMIT_SEL = 'input[type="submit"]';

const TZ = "Europe/Rome";
const MONTHS_AHEAD = 8;

const NEXT_BTN_SEL  = ".fc-next-button, .fc-next, button.next, .paginator-next";
const TODAY_BTN_SEL = ".fc-today-button";

const EVENT_SELECTORS = [
  ".fc-timegrid-event", 
  ".fc-daygrid-event",  
  ".fc-event", ".fc-v-event", ".fc-event-main", ".evento"
];

// esclusione keyword per provare a bypassare la creazione di eventi vuoti
const EXCLUDE_KEYWORDS = [
  "vacanz", "festivit", "sospensione", "chiusur", "ponte", "pasqua", "natale", 
  "capodanno", "epifania", "ognissanti", "immacolata", "liberazione", "repubblica", 
  "patrono", "santo patrono",
  "annullat", "cancellat", "sospes", "rinviat", "rimandat", "saltata", "non si terrà",
  "assemblea", "collegio", "consiglio", "scrutini", "elezioni", "open day", 
  "orientamento", "formazione docenti",
  "- []", "- [ ]", "[]", "[ ]", "da definire", "da assegnare", "tbd", "n.d.", "nd", 
  "nessuno", "vuoto", "nessuna lezione", "lezione vuota", "non assegnato",
  "---", "..."
];

function cleanText(s){
  return (s||"").replace(/<br\s*\/?>/gi," ")
                 .replace(/&nbsp;/gi," ")
                 .replace(/[\u200B-\u200D\uFEFF]/g, "") 
                 .replace(/\s+/g," ")
                 .trim();
}

function isValidEvent(title) {
  if (!title || title.length < 2) return false;
  const t = title.toLowerCase();
  if (EXCLUDE_KEYWORDS.some(kw => t.includes(kw))) return false;
  return true;
}

function parseWhen(s){
  if (!s) return null;
  s = s.replace(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}(?::\d{2})?)$/,'$1T$2');
  const hasOffset = /[zZ]|[+-]\d\d:?\d\d$/.test(s);
  if (hasOffset) return DateTime.fromISO(s,{ setZone:true }).setZone(TZ);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) { 
    const d = DateTime.fromISO(s,{zone:TZ}).startOf("day"); 
    d.isAllDay = true; 
    return d; 
  }
  return DateTime.fromISO(s,{ zone:TZ });
}

function fmtLocal(dt){ 
  const p = n => String(n).padStart(2,"0"); 
  return dt.year+p(dt.month)+p(dt.day)+"T"+p(dt.hour)+p(dt.minute)+p(dt.second); 
}

function icsDateLine(prop, dt){ 
  return dt.isAllDay ? `${prop};VALUE=DATE:${dt.toFormat("yyyyLLdd")}` : `${prop};TZID=${TZ}:${fmtLocal(dt)}`; 
}

function esc(s){ 
  return String(s).replace(/\\/g,"\\\\").replace(/;/g,"\\;").replace(/,/g,"\\,").replace(/\r?\n/g,"\\n"); 
}

const VTIMEZONE = [
  "BEGIN:VTIMEZONE","TZID:Europe/Rome","X-LIC-LOCATION:Europe/Rome",
  "BEGIN:DAYLIGHT","TZOFFSETFROM:+0100","TZOFFSETTO:+0200","TZNAME:CEST",
  "DTSTART:19700329T020000","RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU","END:DAYLIGHT",
  "BEGIN:STANDARD","TZOFFSETFROM:+0200","TZOFFSETTO:+0100","TZNAME:CET",
  "DTSTART:19701025T030000","RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU","END:STANDARD",
  "END:VTIMEZONE"
].join("\r\n");

function buildICS(events){
  const lines = [
    "BEGIN:VCALENDAR",
    "PRODID:-//Work Calendar Bridge//playwright+luxon//IT",
    "VERSION:2.0",
    "CALSCALE:GREGORIAN",
    `X-WR-TIMEZONE:${TZ}`,
    VTIMEZONE
  ];
  const dtstampStr = DateTime.now().setZone(TZ).toUTC().toFormat("yyyyLLdd'T'HHmmss'Z'");
  
  for (const ev of events){
    if (!ev?.start) continue;
    const title = cleanText(ev.title || "Evento"); 
    if (!title) continue;
    
    const uid = esc(ev.id || (`${ev.start.toISO()}-${title}`));
    lines.push("BEGIN:VEVENT");
    lines.push(`UID:${uid}`);
    lines.push(`DTSTAMP:${dtstampStr}`);
    lines.push(icsDateLine("DTSTART", ev.start));
    lines.push(icsDateLine("DTEND", ev.end || ev.start));
    lines.push(`SUMMARY:${esc(title)}`);
    if (ev.location)    lines.push(`LOCATION:${esc(cleanText(ev.location))}`);
    if (ev.description) lines.push(`DESCRIPTION:${esc(cleanText(ev.description))}`);
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.join("\r\n");
}

async function login(page){
  await page.goto(LOGIN_URL,{ waitUntil:"domcontentloaded" });
  await page.waitForSelector(USER_SEL,{ timeout:20000 });
  await page.fill(USER_SEL, process.env.USERNAME);
  await page.fill(PASS_SEL, process.env.PASSWORD);
  await page.click(SUBMIT_SEL);
  await page.waitForLoadState("networkidle",{ timeout:30000 }).catch(()=>{});
}

async function safeClick(page, sel){
  const el = await page.$(sel);
  if (!el) return false;
  await el.click().catch(()=>{});
  await page.waitForLoadState("networkidle",{ timeout:12000 }).catch(()=>{});
  await page.waitForTimeout(400);
  return true;
}

function extractRangeFromURL(u){
  try{
    const url = new URL(u);
    const start = url.searchParams.get("start") || url.searchParams.get("from");
    const end   = url.searchParams.get("end")   || url.searchParams.get("to");
    return { url, start, end };
  }catch{ return null; }
}

async function collectViaXHR(page, fromDT, toDT){
  const results = []; const seen = new Set(); const endpoints = new Set();
  const MATCH = /events|calendar|getEvents|agenda|lesson|schedule|orario|fullcalendar|fc/i;

  function push(it){
    const title = cleanText(it.title ?? it.name ?? "");
    const start = it.start ? parseWhen(it.start) : null;
    const end   = it.end   ? parseWhen(it.end)   : null;
    
    if (!start || !isValidEvent(title)) return;
    if (start < fromDT || start > toDT) return;
    
    const key = `${it.id ?? ""}|${start.toISO()}|${title}`;
    if (seen.has(key)) return; seen.add(key);
    
    results.push({ id: it.id ?? null, title, start, end, location: it.location ?? "", description: it.description ?? "" });
  }

  page.on("response", async (r) => {
    try{
      const url = r.url();
      if (!MATCH.test(url) || !r.ok()) return;
      const ct = r.headers()["content-type"] || "";
      if (!/json|text/.test(ct)) return;

      const info = extractRangeFromURL(url);
      if (info && (info.start || info.end)) {
        info.url.searchParams.delete("start"); info.url.searchParams.delete("from");
        info.url.searchParams.delete("end");   info.url.searchParams.delete("to");
        endpoints.add(info.url.toString());
      }

      const j = await r.json().catch(()=>null);
      if (!j) return;
      const arr = Array.isArray(j?.events) ? j.events : Array.isArray(j) ? j : [];
      for (const it of arr) push(it);
    }catch{}
  });

  await page.goto(CAL_URL, { waitUntil:"networkidle" });
  await page.waitForSelector('.fc, .calendar, [data-calendar]', { timeout: 20000 }).catch(()=>{});
  await safeClick(page, NEXT_BTN_SEL); 
  await safeClick(page, TODAY_BTN_SEL);
  await page.waitForTimeout(1000);

  for (const base of endpoints){
    let cursor = fromDT.startOf("month");
    while (cursor <= toDT){
      const monthEnd = cursor.plus({ months:1 }).minus({ days:1 });
      const u = new URL(base);
      const start = cursor.toISODate(), end = monthEnd.toISODate();
      u.searchParams.set("start", start); u.searchParams.set("end", end);
      u.searchParams.set("from", start);  u.searchParams.set("to", end);
      try{
        const resp = await page.request.get(u.toString());
        if (resp.ok()){
          const j = await resp.json().catch(()=>null);
          const arr = Array.isArray(j?.events) ? j.events : Array.isArray(j) ? j : [];
          for (const it of arr) push(it);
        }
      }catch{}
      cursor = cursor.plus({ months:1 });
    }
  }
  return results;
}

async function grabDOM(page){
  const sels = EVENT_SELECTORS.join(",");
  return await page.$$eval(sels, nodes => nodes.map(el => {
    const title = (el.innerText || el.textContent || "").trim();
    const ds    = el.getAttribute("data-start") || el.dataset?.start || "";
    const de    = el.getAttribute("data-end")   || el.dataset?.end   || "";
    const aria  = el.getAttribute("aria-label") || "";
    const dayEl = el.closest("[data-date]") || el.parentElement?.closest?.("[data-date]");
    const day   = dayEl?.getAttribute?.("data-date") || "";

    return {
      title, dataStart: ds, dataEnd: de, aria, day,
      id: el.getAttribute("data-id") || "",
      location: el.getAttribute("data-location") || "",
      description: el.getAttribute("data-desc") || ""
    };
  })).catch(()=>[]);
}

function parseDomEvent(e){
  let start = e.dataStart ? parseWhen(e.dataStart) : null;
  let end   = e.dataEnd   ? parseWhen(e.dataEnd)   : null;

  if (!start && e.aria) {
    const m = e.aria.match(/(\d{1,2}:\d{2}).{0,5}(\d{1,2}:\d{2})/);
    if (m && e.day){
      const [_, s1, s2] = m;
      start = parseWhen(`${e.day} ${s1}`);
      end   = parseWhen(`${e.day} ${s2}`);
    }
  }
  if (!start && e.day){
    start = parseWhen(e.day);
  }
  return { start, end };
}

function mapFilterDom(raw, from, to, seen){
  const out = [];
  for (const e of raw){
    const { start, end } = parseDomEvent(e);
    const title = cleanText(e.title);
    
    if (!start || !isValidEvent(title)) continue;
    if (start < from || start > to) continue;
    
    const key = `${e.id||""}|${start.toISO()}|${title}`;
    if (seen.has(key)) continue; seen.add(key);
    
    out.push({
      id: e.id || null,
      title,
      start, end,
      location: cleanText(e.location),
      description: cleanText(e.description)
    });
  }
  return out;
}

async function collectViaDOMWithClicks(page, from, to, clicks=400){
  const results = []; const seen = new Set();

  async function grabAndPush(){
    const raw = await grabDOM(page);
    const mapped = mapFilterDom(raw, from, to, seen);
    if (mapped.length) results.push(...mapped);
    return mapped.length;
  }

  await grabAndPush();
  for (let i=0; i<clicks; i++){
    await safeClick(page, NEXT_BTN_SEL);
    await grabAndPush();
  }
  await safeClick(page, TODAY_BTN_SEL);
  return results;
}

// main
(async ()=>{
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();

    await login(page);

    const now = DateTime.now().setZone(TZ);
    const from = now.startOf("day");
    const to   = now.plus({ months: MONTHS_AHEAD }).endOf("day");

    let events = await collectViaXHR(page, from, to);

    // Fallback sul DOM solo se strettamente necessario
    if (events.length < 5) {
      await page.goto(CAL_URL, { waitUntil:"networkidle" });
      await page.waitForSelector('.fc, .calendar, [data-date]', { timeout: 20000 }).catch(()=>{});
      const domEv = await collectViaDOMWithClicks(page, from, to, 400);
      
      const seen = new Set(); const merged = [];
      for (const ev of [...events, ...domEv]) {
        const key = `${ev.title}|${ev.start?.toISO()}|${ev.end?.toISO()||""}`;
        if (!seen.has(key)) { seen.add(key); merged.push(ev); }
      }
      events = merged;
    }

    const ics = buildICS(events);
    fs.writeFileSync("calendar.ics", ics, "utf8");
    
    // Log essenziale per il sistema di orchestrazione
    console.log(`[SUCCESS] Extracted ${events.length} events.`);

  } catch (err) {
    console.error(`[ERROR] Script failed: ${err.message}`);
    process.exit(1);
  } finally {
    if (browser) await browser.close();
  }
})();
