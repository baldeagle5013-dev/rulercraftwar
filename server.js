import express from 'express';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import fetch from 'node-fetch';
import webpush from 'web-push';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app  = express();
const PORT = process.env.PORT || 3000;

// ── Data dir ──────────────────────────────────────────────────────────────────
const DATA_DIR = join(__dirname, 'data');
if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

const PAST_WARS_FILE = join(DATA_DIR, 'past_wars.json');
const SUBS_FILE      = join(DATA_DIR, 'subscriptions.json');
const PAST_WAR_TTL   = 3 * 24 * 60 * 60 * 1000;

function readJSON(p, fb) { try { return JSON.parse(readFileSync(p,'utf8')); } catch { return fb; } }
function writeJSON(p, d) { try { writeFileSync(p, JSON.stringify(d,null,2)); } catch(e) { console.error(e); } }

// ── VAPID ─────────────────────────────────────────────────────────────────────
let vapidKeys;
if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  vapidKeys = { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY };
} else {
  vapidKeys = webpush.generateVAPIDKeys();
  console.warn('[VAPID] Ephemeral keys generated. Set VAPID_PUBLIC_KEY + VAPID_PRIVATE_KEY in env for persistence.');
  console.log('[VAPID] Public:', vapidKeys.publicKey);
  console.log('[VAPID] Private:', vapidKeys.privateKey);
}
webpush.setVapidDetails('mailto:admin@rulercraft.com', vapidKeys.publicKey, vapidKeys.privateKey);

// ── State ─────────────────────────────────────────────────────────────────────
let pastWars      = readJSON(PAST_WARS_FILE, []).filter(w => Date.now() - w.endedAt < PAST_WAR_TTL);
let subscriptions = readJSON(SUBS_FILE, []);
let liveSnapshot  = {};   // id -> war object, currently live
let cachedRaw     = null;
let cacheTs       = 0;
const CACHE_TTL   = 30_000;

writeJSON(PAST_WARS_FILE, pastWars);

// ── Upstream ──────────────────────────────────────────────────────────────────
const UPSTREAM = 'https://rulercraft-proxy.onrender.com/markers';

async function getMarkers(force = false) {
  if (!force && cachedRaw && Date.now() - cacheTs < CACHE_TTL) return cachedRaw;
  const res = await fetch(UPSTREAM, { headers: { 'User-Agent': 'RulerCraftTracker/1.0' }, timeout: 10000 });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  cachedRaw = await res.json();
  cacheTs   = Date.now();
  return cachedRaw;
}

// ── Parse ─────────────────────────────────────────────────────────────────────
function parseDesc(desc = '') {
  const plain = desc
    .replace(/<b[^>]*>(.*?)<\/b>/gi,'$1')
    .replace(/<br\s*\/?>/gi,'\n')
    .replace(/<[^>]+>/g,'')
    .replace(/&#43;/g,'')
    .replace(/&#8722;/g,'-')
    .replace(/&amp;/g,'&')
    .replace(/&#\d+;/g,'');

  const get = k => { const m = plain.match(new RegExp(k+':\\s*([^\\n]+)','i')); return m?m[1].trim():null; };
  const sm  = plain.match(/Siege:\s*(.+?)\s+vs\s+(.+)/i);
  const attacker = sm ? sm[1].trim() : '?';
  const defender = sm ? sm[2].trim() : '?';
  const town     = (get('Town')||'?').replace(/_/g,' ');
  const siegeStatus = get('Siege Status')||'';
  const pr = (get('Siege Progress')||'0/3').match(/(\d+)\s*\/\s*(\d+)/);
  let session = pr ? parseInt(pr[1]) : 0;
  if (/contested/i.test(siegeStatus)) session++;
  const sessionMax = pr ? parseInt(pr[2]) : 3;

  const br = get('Banner Control')||'';
  let bannerCtrl='Contested', bannerCount=0;
  if (/attacker/i.test(br)) { bannerCtrl='Attackers'; const bm=br.match(/\((\d+)\)/); bannerCount=bm?parseInt(bm[1]):0; }
  else if (/defender/i.test(br)) { bannerCtrl='Defenders'; const bm=br.match(/\((\d+)\)/); bannerCount=bm?parseInt(bm[1]):0; }

  const pts = (get('Battle Points')||'0 / 0').match(/([\d,]+)\s*\/\s*([\d,]+)/);
  const atkPts = pts ? parseInt(pts[1].replace(/,/g,'')) : 0;
  const defPts = pts ? parseInt(pts[2].replace(/,/g,'')) : 0;

  return { attacker, defender, town, siegeStatus, session, sessionMax,
    bannerCtrl, bannerCount, atkPts, defPts,
    timeLeft: get('Battle Time Left'), warChest: get('War Chest')||'$0',
    siegeBalance: parseInt(get('Siege Balance')||'0')||0,
    siegeType: get('Type')||'Conquest' };
}

// ── Notifications ─────────────────────────────────────────────────────────────
async function notify(war, event) {
  const dead = [];
  for (const sub of subscriptions) {
    const nations = (sub.watchNations||[]).map(n=>n.toLowerCase());
    if (!nations.length) continue;
    if (!nations.includes(war.attacker.toLowerCase()) && !nations.includes(war.defender.toLowerCase())) continue;
    const payload = JSON.stringify({
      title: `⚔ War ${event} — ${war.town}`,
      body:  `${war.attacker} vs ${war.defender}`,
      url:   '/?war='+war.id
    });
    try { await webpush.sendNotification(sub, payload); }
    catch(e) { if (e.statusCode===410) dead.push(sub.endpoint); }
  }
  if (dead.length) {
    subscriptions = subscriptions.filter(s=>!dead.includes(s.endpoint));
    writeJSON(SUBS_FILE, subscriptions);
  }
}

// ── Poll cycle ────────────────────────────────────────────────────────────────
async function poll() {
  try {
    const json    = await getMarkers(true);
    const markers = json?.sets?.['siegewar.markerset']?.markers || {};
    const freshIds = new Set();

    for (const [id, m] of Object.entries(markers)) {
      if (m.icon !== 'siegewar.battle') continue;
      freshIds.add(id);
      const parsed = parseDesc(m.desc||'');
      const war    = { id, x: m.x, z: m.z, ...parsed };
      if (!liveSnapshot[id]) {
        // New war
        console.log('[NEW WAR]', war.town, war.attacker, 'vs', war.defender);
        await notify(war, 'Started');
      }
      liveSnapshot[id] = war;
    }

    // Ended wars
    for (const [id, prev] of Object.entries(liveSnapshot)) {
      if (!freshIds.has(id)) {
        console.log('[WAR ENDED]', prev.town);
        const winner = prev.atkPts >= prev.defPts ? 'attacker' : 'defender';
        const ended  = { ...prev, isOngoing: false, winner, endedAt: Date.now() };
        if (!pastWars.find(p=>p.id===id)) {
          pastWars.push(ended);
          pastWars = pastWars.filter(w=>Date.now()-w.endedAt<PAST_WAR_TTL);
          writeJSON(PAST_WARS_FILE, pastWars);
        }
        await notify({ ...prev, id }, 'Ended');
        delete liveSnapshot[id];
      }
    }
  } catch(e) {
    console.error('[poll]', e.message);
  }
}

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json({ limit: '1mb' }));
app.use(express.static(join(__dirname, 'public')));

// ── API ───────────────────────────────────────────────────────────────────────
app.get('/api/markers',      async (req, res) => { try { res.json(await getMarkers(req.query.force==='1')); } catch(e){ res.status(502).json({error:e.message}); } });
app.get('/api/vapid-key',    (req, res) => res.json({ publicKey: vapidKeys.publicKey }));
app.get('/api/past-wars',    (req, res) => res.json(pastWars.filter(w=>Date.now()-w.endedAt<PAST_WAR_TTL)));
app.get('/api/subscriptions',(req, res) => res.json(subscriptions.map(s=>({endpoint:s.endpoint,watchNations:s.watchNations,createdAt:s.createdAt}))));

app.post('/api/subscribe', (req, res) => {
  const { subscription, watchNations } = req.body;
  if (!subscription?.endpoint) return res.status(400).json({error:'Missing endpoint'});
  const idx = subscriptions.findIndex(s=>s.endpoint===subscription.endpoint);
  const entry = { ...subscription, watchNations: watchNations||[], createdAt: Date.now() };
  if (idx>=0) subscriptions[idx]=entry; else subscriptions.push(entry);
  writeJSON(SUBS_FILE, subscriptions);
  res.json({ok:true});
});

app.post('/api/unsubscribe', (req, res) => {
  subscriptions = subscriptions.filter(s=>s.endpoint!==req.body.endpoint);
  writeJSON(SUBS_FILE, subscriptions);
  res.json({ok:true});
});

app.post('/api/test-notify', async (req, res) => {
  const { endpoint, title, body } = req.body;
  const sub = subscriptions.find(s=>s.endpoint===endpoint);
  if (!sub) return res.status(404).json({error:'Sub not found'});
  try {
    await webpush.sendNotification(sub, JSON.stringify({ title: title||'Test', body: body||'Test notification', url:'/' }));
    res.json({ok:true});
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.post('/api/past-wars', (req, res) => {
  const w = req.body;
  if (!w?.id) return res.status(400).json({error:'Missing id'});
  if (!pastWars.find(p=>p.id===w.id)) { pastWars.push(w); pastWars=pastWars.filter(x=>Date.now()-x.endedAt<PAST_WAR_TTL); writeJSON(PAST_WARS_FILE,pastWars); }
  res.json({ok:true});
});

app.delete('/api/past-wars/:id', (req, res) => { pastWars=pastWars.filter(w=>w.id!==req.params.id); writeJSON(PAST_WARS_FILE,pastWars); res.json({ok:true}); });
app.delete('/api/past-wars',     (req, res) => { pastWars=[]; writeJSON(PAST_WARS_FILE,pastWars); res.json({ok:true}); });

// ── Boot ──────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('RulerCraft War Tracker on port', PORT);
  poll();
  setInterval(poll, 60_000);
  scheduleHourly();
});

function scheduleHourly() {
  const now = new Date();
  const msToHour = (60-now.getMinutes())*60_000 - now.getSeconds()*1000 - now.getMilliseconds();
  const pre = msToHour - 5_000;
  if (pre > 0) setTimeout(()=>{ poll(); setTimeout(()=>{ poll(); scheduleHourly(); }, 5_000); }, pre);
  else if (msToHour>0) setTimeout(()=>{ poll(); scheduleHourly(); }, msToHour);
  else setTimeout(scheduleHourly, 1000);
}
