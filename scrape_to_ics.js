import { chromium } from "playwright";
import fs from "fs";
import { DateTime } from "luxon";

// ====== CONFIG STABILE ======
const LOGIN_URL = "https://itsar.registrodiclasse.it/geopcfp2/";
const CAL_URL   = "https://itsar.registrodiclasse.it/geopcfp2/";
const USER_SEL   = 'input[name="username"]';
const PASS_SEL   = 'input[name="password"]';
const SUBMIT_SEL = 'input[type="submit"]';

const MONTHS_AHEAD   = 8; // copriamo abbastanza in avanti
const NEXT_BTN_SEL   = ".fc-next-button, .fc-next, button.next, .paginator-next"; // ✅ quello che ti funzionava
const TODAY_BTN_SEL  = ".fc-today-button";

const EVENT_SELECTORS = [
  ".fc-event",
  ".fc-v-event",
  ".fc-event-main",
  ".fc-timegrid-event",
  ".fc-daygrid-event",
  ".evento"
];

const TZ = "Europe/Rome";
// =============================

// helpers
function cleanText(s){
  return (s||"")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseWhen(s) {
  if (!s) return null;
  // normalizza "YYYY-MM-DD HH:mm" -> "YYYY-MM-DDTHH:mm"
  s = s.replace(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}(:\d{2})?)$/, '$1T$2');

  const hasOffset = /[zZ]|[+-]\d\d:?\d\d$/.test(s);
  if (hasOffset) {
    return DateTime.fromISO(s, { setZone: true }).setZone(TZ);
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const dt = DateTime.fromISO(s, { zone: TZ }).startOf("day");
    dt.isAllDay = true;
    return dt;
  }
  return DateTime.fromISO(s, { zone: TZ });
}

function fmtLocal(dt) {
  const pad = (n)=>String(n).padStart(2,"0");
  return dt.year.toString() + pad(dt.month) + pad(dt.day) +
         "T" + pad(dt.hour) + pad(dt.minute) + pad(dt.second);
}
function icsDateLine(prop, dt) {
  if (dt.isAllDay) return `${prop};VALUE=DATE:${dt.toFormat("yyyyLLdd")}`;
  return `${prop};TZID=${TZ}:${fmtLocal(dt)}`;
}
function esc(s){ return String(s).replace(/\\/g,"\\\\").replace(/;/g,"\\;").replace(/,/g,"\\,").replace(/\r?\n/g,"\\n"); }

const VTIMEZONE = [
"BEGIN:VTIMEZONE",
"TZID:Europe/Rome",
"X-LIC-LOCATION:Europe/Rome",
"BEGIN:DAYLIGHT",
"TZOFFSETFROM:+0100",
"TZOFFSETTO:+0200",
"TZNAME:CEST",
"DTSTART:19700329T020000",
"RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU",
"END:DAYLIGHT",
"BEGIN:STANDARD",
"TZOFFSETFROM:+0200",
"TZOFFSETTO:+0100",
"TZNAME:CET",
"DTSTART:19701025T030000",
"RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU",
"END:STANDARD",
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
    if (!ev || !ev.start) continue;
    const start = ev.start;
    const end   = ev.end || ev.start;
    const title = cleanText(ev.title || "Evento");
    if (!title) continue;

    const uid   = esc(ev.id || (`${start.toISO()}-${title}`));
    const desc  = ev.description ? cleanText(ev.description) : "";
    const loc   = ev.location ? cleanText(ev.location) : "";

    lines.push("BEGIN:VEVENT");
    lines.push(`UID:${uid}`);
    lines.push(`DTSTAMP:${dtstampStr}`);
    lines.push(icsDateLine("DTSTART", start));
    lines.push(icsDateLine("DTEND",   end));
    lines.push(`SUMMARY:${esc(title)}`);
    if (desc) lines.push(`DESCRIPTION:${esc(desc)}`);
    if (loc)  lines.push(`LOCATION:${esc(loc)}`);
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.join("\r\n");
}

// login
async function login(page){
  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(USER_SEL, { timeout: 20000 });
  await page.fill(USER_SEL, process.env.USERNAME);
  await page.fill(PASS_SEL, process.env.PASSWORD);
  await page.click(SUBMIT_SEL);
  await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(()=>{});
  // aspetta che si veda il calendario
  await page.waitForSelector('.fc', { timeout: 25000 }).catch(()=>{});
}

// click sicuro
async function safeClick(page, sel){
  const el = await page.$(sel);
  if (!el) return false;
  await el.click().catch(()=>{});
  await page.waitForLoadState("networkidle", { timeout: 12000 }).catch(()=>{});
  await page.waitForTimeout(400);
  return true;
}

// raccolta DOM corrente
async function grabOnce(page){
  const raw = await page.$$eval(EVENT_SELECTORS.join(","), nodes =>
    nodes.map(el => ({
      title: el.innerText || el.textContent || "",
      start: el.getAttribute("data-start") || el.dataset?.start || "",
      end:   el.getAttribute("data-end")   || el.dataset?.end   || "",
      id:    el.getAttribute("data-id") || "",
      location: el.getAttribute("data-location") || "",
      description: el.getAttribute("data-desc") || ""
    }))
  ).catch(()=>[]);
  return raw;
}

function mapFilter(raw, from, to, seen){
  const out = [];
  for (const e of raw){
    const start = e.start ? parseWhen(e.start) : null;
    const end   = e.end   ? parseWhen(e.end)   : null;
    const title = cleanText(e.title);
    if (!start || !title) continue;
    if (start < from || start > to) continue;
    const key = `${e.id||""}|${start.toISO()}|${title}`;
    if (seen.has(key)) continue; seen.add(key);
    out.push({
      id: e.id || null,
      title,
      start, end,
      description: cleanText(e.description),
      location: cleanText(e.location)
    });
  }
  return out;
}

// main
(async ()=>{
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  await login(page);
  await page.goto(CAL_URL, { waitUntil: "networkidle" });

  const now  = DateTime.now().setZone(TZ);
  const from = now.startOf("day");
  const to   = now.plus({ months: MONTHS_AHEAD }).endOf("day");

  const results = [];
  const seen = new Set();

  // primo grab
  let raw = await grabOnce(page);
  results.push(...mapFilter(raw, from, to, seen));

  // clicca avanti 400 volte
  const CLICKS = 400;
  for (let i = 0; i < CLICKS; i++){
    await safeClick(page, NEXT_BTN_SEL);
    raw = await grabOnce(page);
    const mapped = mapFilter(raw, from, to, seen);
    if (mapped.length) results.push(...mapped);
  }

  // torna a oggi (opzionale)
  await safeClick(page, TODAY_BTN_SEL);

  const ics = buildICS(results);
  fs.writeFileSync("calendar.ics", ics, "utf8");
  console.log(`OK: estratti ${results.length} eventi → calendar.ics`);

  await browser.close();
})();
