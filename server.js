import express from 'express';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import fetch from 'node-fetch';
import webpush from 'web-push';
import crypto from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const app  = express();
const PORT = process.env.PORT || 3000;
console.log('[boot] __dirname:', __dirname, '| public:', existsSync(join(__dirname,'public')));

const DATA_DIR = join(__dirname, 'data');
if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

const FILES = {
  past:      join(DATA_DIR,'past_wars.json'),
  subs:      join(DATA_DIR,'subscriptions.json'),
  ratings:   join(DATA_DIR,'ratings.json'),
  alliances: join(DATA_DIR,'alliances.json'),
  users:     join(DATA_DIR,'users.json'),
  events:    join(DATA_DIR,'war_events.json'),
};
const PAST_WAR_TTL = 3*24*60*60*1000;

const rj = (p,fb) => { try{return JSON.parse(readFileSync(p,'utf8'));}catch{return fb;} };
const wj = (p,d)  => { try{writeFileSync(p,JSON.stringify(d,null,2));}catch(e){console.error(e.message);} };

// State
let pastWars   = rj(FILES.past,[]).filter(w=>Date.now()-w.endedAt<PAST_WAR_TTL);
let subs       = rj(FILES.subs,[]);
let ratings    = rj(FILES.ratings,{players:{},nations:{}});
let alliances  = rj(FILES.alliances,{groups:[]});
let users      = rj(FILES.users,{});
let warEvents  = rj(FILES.events,{});
let liveSnap   = {};
let cachedRaw  = null, cacheTs = 0;
const UPSTREAM = 'https://rulercraft-proxy.onrender.com/markers';

// VAPID
let vapidKeys;
if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  vapidKeys={publicKey:process.env.VAPID_PUBLIC_KEY,privateKey:process.env.VAPID_PRIVATE_KEY};
} else {
  vapidKeys=webpush.generateVAPIDKeys();
  console.log('[VAPID] Public:',vapidKeys.publicKey);
  console.log('[VAPID] Private:',vapidKeys.privateKey);
}
webpush.setVapidDetails('mailto:admin@rulercraft.com',vapidKeys.publicKey,vapidKeys.privateKey);

// ── Fetch upstream ─────────────────────────────────────────────────────────────
async function getMarkers(force=false){
  if(!force&&cachedRaw&&Date.now()-cacheTs<30000) return cachedRaw;
  const r=await fetch(UPSTREAM,{headers:{'User-Agent':'RulerCraftTracker/1.0'}});
  if(!r.ok) throw new Error('HTTP '+r.status);
  cachedRaw=await r.json(); cacheTs=Date.now(); return cachedRaw;
}

// ── Parse siege desc ───────────────────────────────────────────────────────────
function parseDesc(desc=''){
  const plain=desc.replace(/<b[^>]*>(.*?)<\/b>/gi,'$1').replace(/<br\s*\/?>/gi,'\n')
    .replace(/<[^>]+>/g,'').replace(/&#43;/g,'').replace(/&#8722;/g,'-')
    .replace(/&amp;/g,'&').replace(/&#\d+;/g,'');
  const get=k=>{const m=plain.match(new RegExp(k+':\\s*([^\\n]+)','i'));return m?m[1].trim():null;};
  const sm=plain.match(/Siege:\s*(.+?)\s+vs\s+(.+)/i);
  const attacker=sm?sm[1].trim():'?', defender=sm?sm[2].trim():'?';
  const town=(get('Town')||'?').split(/\s/)[0].replace(/_/g,' ');
  const siegeStatus=get('Siege Status')||'';
  const pr=(get('Siege Progress')||'0/3').match(/(\d+)\s*\/\s*(\d+)/);
  let session=pr?parseInt(pr[1]):0; const sessMax=pr?parseInt(pr[2]):3;
  if(/contested/i.test(siegeStatus)) session++;
  const br=get('Banner Control')||'';
  let bannerCtrl='Contested',bannerCount=0;
  if(/attacker/i.test(br)){bannerCtrl='Attackers';const bm=br.match(/\((\d+)\)/);bannerCount=bm?parseInt(bm[1]):0;}
  else if(/defender/i.test(br)){bannerCtrl='Defenders';const bm=br.match(/\((\d+)\)/);bannerCount=bm?parseInt(bm[1]):0;}
  const pts=(get('Battle Points')||'0 / 0').match(/([\d,]+)\s*\/\s*([\d,]+)/);
  const atkPts=pts?parseInt(pts[1].replace(/,/g,'')):0, defPts=pts?parseInt(pts[2].replace(/,/g,'')):0;
  const siegeBalance=parseInt(get('Siege Balance')||'0')||0;
  return {attacker,defender,town,siegeStatus,siegeType:get('Type')||'Conquest',
    session,sessMax,bannerCtrl,bannerCount,atkPts,defPts,siegeBalance,timeLeft:get('Battle Time Left')};
}

// ── Nation/alliance helpers ────────────────────────────────────────────────────
function getAllianceGroup(nation){
  if(!nation) return [nation];
  for(const g of alliances.groups||[]) if(g.nations.includes(nation)) return g.nations;
  return [nation];
}

async function getNationForPlayer(name){
  try{
    const json=await getMarkers();
    const markers=json?.sets?.['towny.markerset']?.markers||{};
    for(const m of Object.values(markers)){
      if(!m.desc||!m.desc.includes(name)) continue;
      const wm=[...m.desc.matchAll(/fandom\.com\/wiki\/([^"\/]+)"/g)];
      if(wm.length>=2) return decodeURIComponent(wm[1][1]).replace(/_/g,' ');
    }
  }catch(e){}
  return null;
}

// ── Rating engine (exact prototype formula) ────────────────────────────────────
function clamp(v,lo,hi){return Math.max(lo,Math.min(hi,v));}

function computeRatings(siegeId){
  const ev=warEvents[siegeId];
  if(!ev||!ev.endedAt) return;
  const atks=[],defs=[];
  for(const [name,info] of Object.entries(ev.attendees||{})){
    const r={name,nation:info.nation||'',kills:info.kills||0,deaths:info.deaths||0,assists:0,
              rating:ratings.players[name]?.rating||1000};
    if(info.side==='attacker') atks.push(r);
    else if(info.side==='defender') defs.push(r);
  }
  if(!atks.length||!defs.length) return;
  const winner=ev.winner||(ev.atkFinalPts>=ev.defFinalPts?'attacker':'defender');
  const all=[...atks,...defs], nA=atks.length, nB=defs.length;

  function zStats(vals){
    const n=vals.length, mean=vals.reduce((a,b)=>a+b,0)/n;
    const std=Math.sqrt(vals.reduce((s,v)=>s+(v-mean)**2,0)/n);
    return v=>(v-mean)/Math.max(std,0.5);
  }
  const kZ=zStats(all.map(p=>p.kills)), dZ=zStats(all.map(p=>p.deaths)), aZ=zStats(all.map(p=>p.assists));
  const K_IND=26, K_TEAM=9, K_NAT=30;
  const totA=atks.reduce((s,p)=>s+p.rating,0), totB=defs.reduce((s,p)=>s+p.rating,0);

  function handicap(myN,oppN,myT,oppT){
    const s=oppN/myN, pw=oppT/Math.max(myT,1);
    return Math.pow(Math.max(Math.sqrt(s*pw),1.0),0.65);
  }

  const results=all.map(p=>{
    const isAtk=atks.includes(p);
    const prev=ratings.players[p.name]?.battles||0, prov=prev<5, pm=prov?3:1;
    const KI=K_IND*pm, KT=K_TEAM*pm;
    const zk=kZ(p.kills),zd=dZ(p.deaths),za=aZ(p.assists);
    const perf=1.2*zk-0.8*zd+0.35*za, scaled=Math.tanh(perf/1.5)*2.5;
    const indiv=KI*scaled;
    const myT=isAtk?totA:totB, oppT=isAtk?totB:totA;
    const myN=isAtk?nA:nB, oppN=isAtk?nB:nA;
    const expW=1/(1+Math.pow(10,(oppT/Math.max(oppN,1)-myT/Math.max(myN,1))/400));
    const act=(isAtk?winner==='attacker':winner==='defender')?1:0;
    const rawT=KT*(act-expW);
    const teamD=myN<=oppN?rawT*handicap(myN,oppN,myT,oppT):rawT/handicap(oppN,myN,oppT,myT);
    const delta=Math.round(0.85*indiv+0.15*teamD);
    return {...p,delta,newR:Math.max(100,p.rating+delta),scaled,won:act===1};
  });

  // Commit players
  for(const r of results){
    if(!ratings.players[r.name]) ratings.players[r.name]={rating:1000,battles:0,wins:0,kills:0,deaths:0,nation:r.nation,warHistory:[]};
    const rec=ratings.players[r.name];
    const old=rec.rating; rec.rating=r.newR; rec.battles++; if(r.won) rec.wins++;
    rec.kills+=r.kills; rec.deaths+=r.deaths; rec.nation=r.nation;
    rec.warHistory=rec.warHistory||[];
    rec.warHistory.push({siegeId,town:ev.town,delta:r.delta,oldRating:old,newRating:r.newR,kills:r.kills,deaths:r.deaths,won:r.won,ts:Date.now()});
    if(rec.warHistory.length>50) rec.warHistory=rec.warHistory.slice(-50);
  }

  // Nations
  function rStr(pList){if(!pList.length) return 1000; const avg=pList.reduce((s,p)=>s+p.rating,0)/pList.length; return Math.round(avg*Math.pow(pList.length/5,0.4));}
  function getNFR(n,members){const rs=rStr(members);const nd=ratings.nations[n];if(!nd) return rs;const cw=clamp(0.5+0.15*(nd.wars/15),0.5,0.65);return Math.round(cw*nd.combatRating+(1-cw)*rs);}
  const aNs=[...new Set(atks.map(p=>p.nation).filter(Boolean))];
  const dNs=[...new Set(defs.map(p=>p.nation).filter(Boolean))];
  const crA=aNs.map(n=>getNFR(n,atks.filter(p=>p.nation===n))).reduce((a,b)=>a+b,0)/Math.max(aNs.length,1);
  const crB=dNs.map(n=>getNFR(n,defs.filter(p=>p.nation===n))).reduce((a,b)=>a+b,0)/Math.max(dNs.length,1);
  function coalElo(my,opp,act){return K_NAT*(act-1/(1+Math.pow(10,(opp-my)/400)));}
  const eA=coalElo(crA,crB,winner==='attacker'?1:0), eB=coalElo(crB,crA,winner==='defender'?1:0);

  function updNation(n,members,baseElo,numN,won){
    const combatD=Math.round(baseElo*(1/Math.max(numN,1))*numN);
    if(!ratings.nations[n]) ratings.nations[n]={combatRating:rStr(members),wars:0,wins:0};
    const rec=ratings.nations[n];
    rec.combatRating=Math.max(100,rec.combatRating+combatD); rec.wars++; if(won) rec.wins++;
  }
  for(const n of aNs) updNation(n,results.filter(r=>atks.some(a=>a.name===r.name)),eA,aNs.length,winner==='attacker');
  for(const n of dNs) updNation(n,results.filter(r=>defs.some(d=>d.name===r.name)),eB,dNs.length,winner==='defender');

  wj(FILES.ratings,ratings);
  console.log('[ratings] Computed for',siegeId,'players:',results.length);
}

// ── Poll ───────────────────────────────────────────────────────────────────────
async function poll(){
  try{
    const json=await getMarkers(true);
    const markers=json?.sets?.['siegewar.markerset']?.markers||{};
    const fresh=new Set();
    for(const [id,m] of Object.entries(markers)){
      if(!m.desc||!m.desc.includes('Siege:')) continue;
      fresh.add(id);
      const p=parseDesc(m.desc);
      liveSnap[id]={id,x:m.x,z:m.z,...p};
      if(!warEvents[id]){
        warEvents[id]={town:p.town,attendees:{},kills:[],startedAt:Date.now(),
          attackerNation:p.attacker,defenderNation:p.defender};
        wj(FILES.events,warEvents);
      }
    }
    for(const [id,prev] of Object.entries(liveSnap)){
      if(!fresh.has(id)){
        const sb=prev.siegeBalance||0;
        const atkF=(prev.atkPts||0)+Math.max(0,sb), defF=(prev.defPts||0)+Math.max(0,-sb);
        const winner=atkF>=defF?'attacker':'defender';
        if(warEvents[id]){
          Object.assign(warEvents[id],{endedAt:Date.now(),winner,atkFinalPts:atkF,defFinalPts:defF});
          wj(FILES.events,warEvents);
          computeRatings(id);
        }
        if(!pastWars.find(p=>p.id===id)){
          pastWars.push({...prev,isOngoing:false,winner,endedAt:Date.now()});
          pastWars=pastWars.filter(w=>Date.now()-w.endedAt<PAST_WAR_TTL);
          wj(FILES.past,pastWars);
        }
        delete liveSnap[id];
      }
    }
  }catch(e){console.error('[poll]',e.message);}
}

// ── Auth ───────────────────────────────────────────────────────────────────────
function requireToken(req,res,next){
  const tok=req.headers['x-session-token']||req.body?.token;
  if(!tok) return res.status(401).json({error:'No token'});
  const u=Object.entries(users).find(([,v])=>v.token===tok&&v.token);
  if(!u) return res.status(401).json({error:'Invalid token'});
  req.authedUser=u[0]; next();
}
function requireZwaqs(req,res,next){
  requireToken(req,res,()=>{
    if(req.authedUser!=='Zwaqs') return res.status(403).json({error:'Forbidden'});
    next();
  });
}

// ── Middleware ─────────────────────────────────────────────────────────────────
app.use(express.json({limit:'2mb'}));
app.use(express.static(join(__dirname,'public')));

// ── Routes ─────────────────────────────────────────────────────────────────────

// Markers
app.get('/api/markers', async(req,res)=>{try{res.json(await getMarkers(req.query.force==='1'));}catch(e){res.status(502).json({error:e.message});}});

// Login flow
app.post('/api/login-request',(req,res)=>{
  const code=String(Math.floor(10000+Math.random()*90000));
  const expiresAt=Date.now()+65000, sessionId=crypto.randomUUID();
  if(!users.__pending__) users.__pending__={loginCodes:[]};
  users.__pending__.loginCodes=(users.__pending__.loginCodes||[]).filter(c=>c.expiresAt>Date.now());
  users.__pending__.loginCodes.push({code,expiresAt,sessionId});
  wj(FILES.users,users);
  res.json({code,expiresAt,sessionId});
});

app.post('/api/login-verify',(req,res)=>{
  const{username,code}=req.body;
  if(!username||!code) return res.status(400).json({error:'Missing fields'});
  const pending=(users.__pending__?.loginCodes||[]);
  const idx=pending.findIndex(c=>c.code===code&&c.expiresAt>Date.now());
  if(idx<0) return res.status(401).json({error:'Invalid or expired code'});
  const{sessionId}=pending[idx]; pending.splice(idx,1);
  if(!users[username]) users[username]={loginCodes:[]};
  const token=crypto.randomBytes(32).toString('hex');
  users[username].token=token; users[username].sessionId=sessionId;
  wj(FILES.users,users);
  res.json({ok:true,token,username});
});

app.post('/api/login-poll',(req,res)=>{
  const{sessionId}=req.body;
  if(!sessionId) return res.status(400).json({error:'Missing sessionId'});
  const u=Object.entries(users).find(([n,v])=>v.sessionId===sessionId&&n!=='__pending__');
  if(!u) return res.json({ready:false});
  res.json({ready:true,username:u[0],token:u[1].token});
});

app.get('/api/me',requireToken,(req,res)=>res.json({username:req.authedUser}));

// Past wars
app.get('/api/past-wars',(req,res)=>res.json(pastWars.filter(w=>Date.now()-w.endedAt<PAST_WAR_TTL)));
app.post('/api/past-wars',(req,res)=>{
  const w=req.body; if(!w?.id) return res.status(400).json({error:'Missing id'});
  if(!pastWars.find(p=>p.id===w.id)){pastWars.push(w);pastWars=pastWars.filter(x=>Date.now()-x.endedAt<PAST_WAR_TTL);wj(FILES.past,pastWars);}
  res.json({ok:true});
});
app.delete('/api/past-wars/:id',(req,res)=>{pastWars=pastWars.filter(w=>w.id!==req.params.id);wj(FILES.past,pastWars);res.json({ok:true});});
app.delete('/api/past-wars',(req,res)=>{pastWars=[];wj(FILES.past,pastWars);res.json({ok:true});});

// War attendance (from mod)
app.post('/api/war-attendance', async(req,res)=>{
  const{siegeId,town,players,bannerX,bannerY,bannerZ}=req.body;
  if(!siegeId||!players) return res.status(400).json({error:'Missing fields'});
  if(!warEvents[siegeId]){
    warEvents[siegeId]={town:town||'Unknown',attendees:{},kills:[],startedAt:Date.now()};
    try{
      const j=await getMarkers();
      const ms=Object.values(j?.sets?.['siegewar.markerset']?.markers||{});
      const m=ms.find(m=>m.desc&&m.desc.includes('Siege:'));
      if(m){const p=parseDesc(m.desc);warEvents[siegeId].attackerNation=p.attacker;warEvents[siegeId].defenderNation=p.defender;}
    }catch(e){}
  }
  const ev=warEvents[siegeId];
  for(const name of players){
    if(!ev.attendees[name]){
      const nation=await getNationForPlayer(name).catch(()=>null)||'';
      const side=getAllianceGroup(ev.attackerNation||'').includes(nation)?'attacker':getAllianceGroup(ev.defenderNation||'').includes(nation)?'defender':'unknown';
      ev.attendees[name]={nation,side,kills:0,deaths:0,firstSeenAt:Date.now()};
    }
    ev.attendees[name].lastSeenAt=Date.now();
  }
  wj(FILES.events,warEvents);
  res.json({ok:true,attendees:Object.keys(ev.attendees).length});
});

// War kill (from mod)
app.post('/api/war-kill',(req,res)=>{
  const{siegeId,victim,killer,side,battlePointsDelta,timestamp}=req.body;
  if(!siegeId) return res.json({ok:true});
  const ev=warEvents[siegeId]; if(!ev) return res.json({ok:true});
  const ts=timestamp||Date.now();
  const dup=(ev.kills||[]).find(k=>k.victim===victim&&k.killer===killer&&Math.abs(k.timestamp-ts)<10000);
  if(dup) return res.json({ok:true,duplicate:true});
  ev.kills=ev.kills||[];
  ev.kills.push({victim,killer,side,battlePointsDelta,timestamp:ts});
  if(ev.attendees[victim]) ev.attendees[victim].deaths=(ev.attendees[victim].deaths||0)+1;
  if(ev.attendees[killer]) ev.attendees[killer].kills=(ev.attendees[killer].kills||0)+1;
  wj(FILES.events,warEvents);
  res.json({ok:true});
});

// Team lookup (mod asks for side assignments)
app.post('/api/war-team-lookup', async(req,res)=>{
  const{players,siegeId}=req.body;
  if(!players) return res.status(400).json({error:'Missing players'});
  const ev=warEvents[siegeId]||{};
  const teams={},nations={};
  for(const name of players){
    const att=ev.attendees?.[name];
    if(att){teams[name]=att.side;nations[name]=att.nation;}
    else{
      const nation=await getNationForPlayer(name).catch(()=>null)||'';
      nations[name]=nation;
      teams[name]=getAllianceGroup(ev.attackerNation||'').includes(nation)?'attacker':getAllianceGroup(ev.defenderNation||'').includes(nation)?'defender':'unknown';
    }
  }
  res.json({teams,nations});
});

// Ratings
app.get('/api/ratings',(req,res)=>res.json(ratings));
app.get('/api/ratings/war/:id',(req,res)=>{
  const ev=warEvents[req.params.id]; if(!ev) return res.status(404).json({error:'Not found'});
  // Return per-war deltas only
  const deltas={};
  for(const[name,rec] of Object.entries(ratings.players)){
    const wh=(rec.warHistory||[]).find(w=>w.siegeId===req.params.id);
    if(wh) deltas[name]={...wh,nation:rec.nation};
  }
  res.json({siegeId:req.params.id,town:ev.town,playerDeltas:deltas});
});

// Alliances (Zwaqs only for write)
app.get('/api/alliances',(req,res)=>res.json(alliances));
app.post('/api/alliances',requireZwaqs,(req,res)=>{alliances=req.body;wj(FILES.alliances,alliances);res.json({ok:true});});

// VAPID / Push
app.get('/api/vapid-key',(req,res)=>res.json({publicKey:vapidKeys.publicKey}));
app.post('/api/subscribe',(req,res)=>{
  const{subscription,watchNations}=req.body;
  if(!subscription?.endpoint) return res.status(400).json({error:'Missing endpoint'});
  const idx=subs.findIndex(s=>s.endpoint===subscription.endpoint);
  const entry={...subscription,watchNations:watchNations||[],createdAt:Date.now()};
  if(idx>=0) subs[idx]=entry; else subs.push(entry);
  wj(FILES.subs,subs); res.json({ok:true});
});
app.post('/api/unsubscribe',(req,res)=>{subs=subs.filter(s=>s.endpoint!==req.body.endpoint);wj(FILES.subs,subs);res.json({ok:true});});

// Catch-all
app.get('*',(req,res)=>res.sendFile(join(__dirname,'public','index.html')));

// Boot
app.listen(PORT,'0.0.0.0',()=>{
  console.log('[boot] Listening on port',PORT);
  poll(); setInterval(poll,60000); scheduleHourly();
});
function scheduleHourly(){
  const now=new Date();
  const ms=(60-now.getMinutes())*60000-now.getSeconds()*1000-now.getMilliseconds();
  const pre=ms-5000;
  if(pre>0) setTimeout(()=>{poll();setTimeout(()=>{poll();scheduleHourly();},5000);},pre);
  else if(ms>0) setTimeout(()=>{poll();scheduleHourly();},ms);
  else setTimeout(scheduleHourly,1000);
}
