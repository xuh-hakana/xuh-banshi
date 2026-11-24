import * as D from './data.js';
import * as A from './art.js';

const canvas = document.getElementById('game');
const c = canvas.getContext('2d');
c.imageSmoothingEnabled = false;
const W = 480, H = 270, T = 16;
const MW = 100, MH = 70;
const SAVE_KEY = 'fishy-farm-save-v1';

let state = null, running = false, last = 0, tick = 0;
const keys = new Set();
const particles = [], floats = [];
let fishUI = null, modalName = null;
let sfxOn = true, audioCtx = null;
const camera = { x: 0, y: 0 };

const $ = s => document.querySelector(s);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const rnd = (a, b) => a + Math.random() * (b - a);
const kk = (x, y) => x + ',' + y;
const seasonNow = () => D.SEASONS[state.time.season].name;

// ---------------------------------------------------------------- 音效
function sfx(type) {
  if (!sfxOn) return;
  try {
    audioCtx ||= new (window.AudioContext || window.webkitAudioContext)();
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    const map = { dig:[150,90,.09,'square'], water:[420,620,.12,'sine'], chop:[110,70,.12,'square'],
      coin:[880,1320,.16,'triangle'], catch:[520,980,.25,'triangle'], eat:[300,420,.12,'sine'],
      level:[660,1320,.35,'sine'], bad:[180,110,.18,'sawtooth'], step:[90,80,.04,'sine'] };
    const [f0, f1, dur, wave] = map[type] || map.dig;
    o.type = wave; o.frequency.setValueAtTime(f0, audioCtx.currentTime);
    o.frequency.exponentialRampToValueAtTime(Math.max(30, f1), audioCtx.currentTime + dur);
    g.gain.setValueAtTime(.045, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(.0001, audioCtx.currentTime + dur);
    o.connect(g); g.connect(audioCtx.destination); o.start(); o.stop(audioCtx.currentTime + dur);
  } catch (_) { /* 浏览器禁用音频时静默 */ }
}

// ---------------------------------------------------------------- 世界
const HOUSE = { x:11, y:24, w:5, h:4, door:[13,28] };
const SHOP  = { x:58, y:22, w:5, h:4, door:[60,26] };
const SPECIALS = {
  '13,28': 'sleep', '17,27': 'shipping', '60,26': 'shop', '62,27': 'shop',
  '53,30': 'quests', '44,8': 'mine', '45,8': 'mine'
};
const PONDS = [];
for (let x = 32; x <= 36; x++) for (let y = 38; y <= 42; y++) PONDS.push(kk(x, y));
const pondSet = new Set(PONDS);

function waterTile(x, y) {
  return (x >= 85 && y >= 34) || (x >= 86 && y >= 24 && y < 34) || pondSet.has(kk(x, y));
}
function isFarm(x, y) { return x >= 6 && x < 41 && y >= 22 && y < 49; }
function isForest(x, y) { return y < 20 && x > 2 && x < 48; }
function isBeach(x, y) { return x >= 78 && y >= 30; }
function isTown(x, y) { return x >= 49 && x < 78 && y >= 20 && y < 42; }
function regionName(x, y) {
  if (state.scene === 'mine') return '矿井 ' + state.mine.level + ' 层';
  if (isFarm(x, y)) return '农场';
  if (isForest(x, y)) return '森林';
  if (isBeach(x, y)) return '海滩';
  if (isTown(x, y)) return '小镇';
  return '荒野';
}
function pondNear(x, y) {
  return [[1,0],[-1,0],[0,1],[0,-1]].some(([dx,dy]) => pondSet.has(kk(x+dx, y+dy)));
}
function groundVariant(x, y) {
  if (waterTile(x, y)) return 'water';
  if (isFarm(x, y) && pondNear(x, y)) return 'sand';
  if (isBeach(x, y)) return 'sand';
  if (isFarm(x, y) && y === 30 && x >= 40) return 'path';
  if (isFarm(x, y) && x === 41) return 'path';
  if (isTown(x, y) && (y === 29 || y === 30 || (x >= 52 && x <= 64 && y === 28))) return 'path';
  if (isFarm(x, y) && x >= 11 && x <= 16 && y >= 24 && y <= 29) return 'path';
  if (x === 44 && y >= 9 && y <= 20) return 'path';
  if (isTown(x, y) && x >= 58 && x <= 63 && y >= 22 && y <= 27) return 'floor';
  return 'grass';
}
function inRect(x, y, r) { return x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h; }

const features = new Map();
function buildFeatures() {
  features.clear();
  for (let x = 1; x < MW - 1; x++) for (let y = 1; y < MH - 1; y++) {
    if (waterTile(x, y)) continue;
    if (inRect(x, y, HOUSE) || inRect(x, y, SHOP)) continue;
    const g = groundVariant(x, y);
    if (g === 'path' || g === 'floor') continue;
    if (state.removed.has(kk(x, y))) continue;
    if (isForest(x, y) && A.hash(x, y, 21) > .87) features.set(kk(x, y), 'tree');
    else if (isFarm(x, y) && ((x < 12 && y < 26) || (x > 37 && y > 44)) && A.hash(x, y, 23) > .55) features.set(kk(x, y), 'tree');
    else if ((isForest(x, y) || isFarm(x, y)) && A.hash(x, y, 24) > .955) features.set(kk(x, y), 'rock');
    else if (isBeach(x, y) && A.hash(x, y, 25) > .975) features.set(kk(x, y), 'rock');
  }
}

function solidTile(x, y) {
  if (x < 0 || y < 0 || x >= MW || y >= MH) return true;
  if (waterTile(x, y)) return true;
  if (inRect(x, y, HOUSE) || inRect(x, y, SHOP)) return true;
  // 农场栅栏；上方与右侧留门（矿井场景不适用）
  if (state.scene !== 'mine') {
    if (x === 41 && y >= 22 && y <= 48 && !(y >= 29 && y <= 31)) return true;
    if (y === 22 && x >= 6 && x <= 41 && !(x >= 20 && x <= 21)) return true;
    if (x === 6 && y >= 22 && y <= 48) return true;
    if (y === 48 && x >= 6 && x <= 41) return true;
  }
  if (state.scene === 'mine') {
    if (x < 1 || y < 1 || x >= 29 || y >= 19) return true;
    return state.mine.rocks.some(r => r.x === x && r.y === y);
  }
  return features.has(kk(x, y));
}
function blocked(px, py) {
  const pts = [[px - 5, py - 1], [px + 4, py - 1], [px - 5, py - 8], [px + 4, py - 8]];
  return pts.some(([x, y]) => solidTile(Math.floor(x / T), Math.floor(y / T)));
}

// ---------------------------------------------------------------- 新游戏 / 存档
function freshState() {
  const toolbar = ['hoe','can','axe','pick','scythe','rod','parsnip_seed','rice',null,null,null,null];
  return {
    v: 1, scene: 'farm', player: { x:13*16+8, y:30*16+12, dir:'down', frame:0, anim:0, energy:100 },
    time: { min:360, day:1, season:0, weather:'晴' },
    gold: 1500, can: 20, inv: { parsnip_seed:15, rice:3 }, toolbar, sel: 6,
    tiles: {}, machines: [], shipping: [], removed: [], forage: [],
    skills: { farming:{xp:0,lv:1}, fishing:{xp:0,lv:1}, mining:{xp:0,lv:1}, foraging:{xp:0,lv:1} },
    stats: { earned:0, shipCrops:0, fish:0, stone:0, forage:0, days:0 },
    quests: D.QUESTS.map(q => ({ ...q, progress:0, done:false, claimed:false })),
    upgrades: {}, mine: { level:1, rocks:[], ladder:null },
    totalEnergy:100
  };
}
function save() {
  if (!state) return;
  try {
    const plain = { ...state, removed: Array.from(state.removed || []) };
    localStorage.setItem(SAVE_KEY, JSON.stringify(plain));
  } catch (_) {}
}
function loadSave() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    if (!s || s.v !== 1) return null;
    s.removed = Array.isArray(s.removed) ? s.removed : [];
    return s;
  } catch (_) { return null; }
}
function haveSave() { return !!loadSave(); }

function startGame(loaded) {
  state = loaded || freshState();
  if (loaded) { state.removed = new Set(state.removed || []); }
  else { state.removed = new Set(); }
  buildFeatures();
  if (loaded && state.scene === 'mine') genMine(state.mine.level);
  if (!state.forage || !state.forage.length) rollForage();
  state.time.weather = state.time.weather || '晴';
  running = true;
  $('#title').classList.add('hidden');
  renderToolbar(); updateHUD(); refreshToolbar();
  toast(loaded ? '欢迎回来，鱼片。本鲸继续种地！' : '本鲸的农场开张啦！先种下防风草吧～', 'good');
  last = performance.now(); requestAnimationFrame(loop);
}

// ---------------------------------------------------------------- 每日
function rollForage() {
  state.forage = [];
  const pool = [];
  for (let x = 4; x < 48; x++) for (let y = 2; y < 19; y++) {
    if (features.has(kk(x, y)) || waterTile(x, y)) continue;
    if (A.hash(x, y, state.time.day * 7 + state.time.season * 31) > .975) pool.push([x, y]);
  }
  for (let x = 78; x < 99; x++) for (let y = 31; y < 59; y++) {
    if (waterTile(x, y)) continue;
    if (A.hash(x, y, state.time.day * 13 + 5) > .985) pool.push([x, y]);
  }
  const avail = D.FORAGE.filter(f => f.seasons.includes(state.time.season));
  for (const [x, y] of pool.slice(0, 14)) {
    const f = avail[Math.floor(A.hash(x, y, state.time.day) * avail.length)];
    state.forage.push({ x, y, id:f.id });
  }
}
function advanceDay() {
  const s = state;
  const oldSeason = s.time.season;
  s.time.day++; s.stats.days++;
  if (s.time.day > 28) { s.time.day = 1; s.time.season = (s.time.season + 1) % 4; }
  s.time.min = 360;
  s.time.weather = Math.random() < .27 ? '雨' : '晴';
  s.can = 20;
  const raining = s.time.weather === '雨';

  // 作物生长
  let dead = 0, grown = 0;
  for (const key in s.tiles) {
    const t = s.tiles[key];
    if (t.crop && !t.crop.dead) {
      const def = D.CROPS[t.crop.id];
      if (!def.seasons.includes(s.time.season)) { t.crop.dead = true; dead++; continue; }
      if (t.watered || raining) {
        t.crop.growth++;
        if (t.crop.growth >= def.days) { t.crop.stage = 4; grown++; }
        else t.crop.stage = clamp(1 + Math.floor(t.crop.growth / def.days * 3), 1, 3);
      }
      if (t.watered) t.crop.perfect = (t.crop.perfect || 0) + 1;
      t.watered = false;
    }
  }
  // 洒水器
  for (const m of s.machines) {
    if (m.type !== 'sprinkler') continue;
    for (const [dx, dy] of [[0,0],[1,0],[-1,0],[0,1],[0,-1]]) {
      const t = s.tiles[kk(m.x + dx, m.y + dy)];
      if (t?.tilled) t.watered = true;
    }
  }
  // 机器产出
  for (const m of s.machines) {
    if (!m.item || m.type === 'sprinkler') continue;
    m.days = (m.days || 0) + 1;
    if (m.days >= 1) {
      let out = null;
      if (m.type === 'jamjar' && D.CROPS[m.item]) out = 'jelly';
      if (m.type === 'smoker' && D.FISH.find(f => f.id === m.item)) out = 'smokedfish';
      if (out) addItem(out, 1);
      m.item = null; m.days = 0;
    }
  }
  // 出货结算
  let income = 0;
  for (const [id, qty] of Object.entries(s.shipping)) {
    income += Math.round(sellPrice(id) * qty);
    if (D.CROPS[id]) progress('shipCrops', qty);
  }
  s.shipping = {};
  if (income) { s.gold += income; s.stats.earned += income; progress('earned', income); sfx('coin'); floatText(s.player.x, s.player.y - 24, '+' + income + 'g', '#ffd76a'); }
  // 季节变化：树木重新长、旧树桩消失
  if (oldSeason !== s.time.season) {
    s.removed = new Set(); buildFeatures();
    for (const key in s.tiles) { if (s.tiles[key].crop?.dead) delete s.tiles[key]; }
    toast('季节变成了' + seasonNow() + '，枯死的作物已被清理。', 'good');
  }
  rollForage();
  s.player.x = 13*16+8; s.player.y = 30*16+12; s.scene = 'farm';
  if (s.totalEnergy < 100) s.totalEnergy = Math.min(200, s.totalEnergy + 2);
  s.player.energy = s.totalEnergy;
  sfx('level');
  save(); updateHUD(); renderToolbar();
  toast('第 ' + s.time.day + ' 天 · ' + s.time.weather + (dead ? ' · ' + dead + ' 株作物枯死' : grown ? ' · ' + grown + ' 株成熟' : ''), 'good');
}

// ---------------------------------------------------------------- 物品 / 数值
function count(id) { return D.TOOLS[id] ? 999 : (state.inv[id] || 0); }
function addItem(id, n = 1) {
  state.inv[id] = (state.inv[id] || 0) + n;
  if (!state.toolbar.includes(id)) {
    const i = state.toolbar.indexOf(null);
    if (i >= 0) state.toolbar[i] = id;
  }
  refreshToolbar();
}
function removeItem(id, n = 1) {
  if (D.TOOLS[id]) return true;
  if ((state.inv[id] || 0) < n) return false;
  state.inv[id] -= n; if (!state.inv[id]) delete state.inv[id];
  refreshToolbar(); return true;
}
function sellPrice(id) {
  const base = D.itemSell(id);
  let bonus = 1;
  if (D.CROPS[id]) bonus += (state.skills.farming.lv - 1) * .02;
  if (D.FISH.find(f => f.id === id)) bonus += (state.skills.fishing.lv - 1) * .02;
  if (D.FORAGE.find(f => f.id === id)) bonus += (state.skills.foraging.lv - 1) * .02;
  if (D.ORES.find(o => o.id === id)) bonus += (state.skills.mining.lv - 1) * .02;
  return Math.max(1, Math.round(base * bonus));
}
function xp(skill, amount) {
  const s = state.skills[skill]; s.xp += amount;
  while (s.xp >= D.XP_NEEDED(s.lv)) {
    s.xp -= D.XP_NEEDED(s.lv); s.lv++;
    state.totalEnergy += 8; state.player.energy = state.totalEnergy;
    sfx('level'); toast(D.SKILLS[skill].name + '升到 ' + s.lv + ' 级！最大体力 +8', 'good');
    floatText(state.player.x, state.player.y - 28, 'LEVEL UP!', '#ffe58a');
  }
}
function progress(track, n) {
  for (const q of state.quests) {
    if (q.track !== track || q.claimed) continue;
    q.progress = Math.min(q.goal, (q.progress || 0) + n);
    if (q.progress >= q.goal && !q.done) {
      q.done = true; toast('任务完成：' + q.name + '！去告示板领取奖励', 'good'); sfx('level');
    }
  }
}
function energyCost(base) {
  const up = state.upgrades[state.toolbar[state.sel]] || 0;
  return Math.max(1, Math.round(base - up * 1.2));
}
function spend(n) {
  if (state.player.energy < n) { toast('本鲸没力气了……吃点白饭吧！', 'bad'); sfx('bad'); return false; }
  state.player.energy -= n; return true;
}
function toast(text, cls = '') {
  const el = document.createElement('div'); el.className = 'toast ' + cls; el.textContent = text;
  $('#toasts').appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .35s'; setTimeout(() => el.remove(), 360); }, 2600);
}
function floatText(x, y, text, color) { floats.push({ x, y, text, color, life: 1.4 }); }
function burst(x, y, color, n = 8) {
  for (let i = 0; i < n; i++) particles.push({ x, y, vx:rnd(-45,45), vy:rnd(-70,-10), life:rnd(.4,.9), color, size:Math.random()<.5?1:2 });
}

// ---------------------------------------------------------------- 输入与交互
const DIRS = { down:[0,1], up:[0,-1], left:[-1,0], right:[1,0] };
function targetTile() {
  const p = state.player, d = DIRS[p.dir];
  return { x:Math.floor((p.x + d[0]*12)/T), y:Math.floor((p.y - 8 + d[1]*13)/T) };
}
function nearSpecial() { const t = targetTile(); return SPECIALS[kk(t.x, t.y)]; }
function hintText() {
  if (state.scene === 'mine') return '空格 敲矿石 · 走到楼梯向下 · 回到入口梯子可返回';
  const sp = nearSpecial();
  if (sp) return ({ sleep:'空格 睡觉（结束今天）', shipping:'空格 打开出货箱', shop:'空格 进入皮埃尔杂货店', quests:'空格 查看委托告示板', mine:'空格 进入矿井' })[sp];
  const t = targetTile(), key = kk(t.x, t.y), td = state.tiles[key];
  const id = state.toolbar[state.sel];
  if (td?.crop && td.crop.stage >= 4 && !td.crop.dead) return '空格 收获 ' + D.itemName(td.crop.id) + (td.crop.id === 'potato' ? '（可能多收）' : '');
  if (features.has(key)) return '空格 ' + (features.get(key) === 'tree' ? '砍树（斧头）' : '敲石头（镐子）');
  if (state.forage.some(f => f.x === t.x && f.y === t.y)) return '空格 采集野生物';
  if (state.machines.some(m => m.x === t.x && m.y === t.y)) return '空格 操作机器';
  if (waterTile(t.x, t.y) && id === 'rod') return '空格 开始钓鱼';
  if (waterTile(t.x, t.y) && id === 'can') return '空格 装满洒水壶';
  if (td?.tilled && id === 'can' && !td.watered) return '空格 浇水';
  if (td?.tilled && !td.crop && D.SEED_PRICES[id] !== undefined) return '空格 种下' + D.itemName(id);
  if (!td && isFarm(t.x, t.y) && id === 'hoe') return '空格 翻地';
  if (id && !D.TOOLS[id] && !D.SEED_PRICES[id]) return '空格 使用/装备 ' + D.itemName(id);
  return '';
}

function doAction() {
  if (modalName) return;
  const p = state.player, t = targetTile(), key = kk(t.x, t.y), id = state.toolbar[state.sel];
  if (state.scene === 'mine') return mineAction(t);
  const sp = nearSpecial();
  if (sp === 'sleep') return confirmSleep();
  if (sp === 'shipping') return openShipping();
  if (sp === 'shop') return openShop();
  if (sp === 'quests') return openQuests();
  if (sp === 'mine') { state.scene = 'mine'; genMine(1); toast('矿井 ' + state.mine.level + ' 层：找到楼梯继续往下。'); sfx('dig'); save(); return; }

  // 机器
  const mi = state.machines.findIndex(m => m.x === t.x && m.y === t.y);
  if (mi >= 0) {
    const m = state.machines[mi];
    if (m.type !== 'sprinkler' && m.item) {
      const out = m.type === 'jamjar' ? 'jelly' : 'smokedfish';
      addItem(out, 1); m.item = null; m.days = 0; toast('取出 ' + D.itemName(out)); sfx('coin'); save(); return;
    }
    if (m.type !== 'sprinkler' && !m.item) {
      if (m.type === 'jamjar' && D.CROPS[id] && removeItem(id, 1)) { m.item = id; m.days = 0; toast('放入 ' + D.itemName(id) + '，明早变果酱'); sfx('dig'); save(); return; }
      if (m.type === 'smoker' && D.FISH.find(f => f.id === id) && removeItem(id, 1)) { m.item = id; m.days = 0; toast('放入 ' + D.itemName(id) + '，明早变熏鱼'); sfx('dig'); save(); return; }
    }
    toast('这台机器现在没有可操作的东西。'); return;
  }
  // 采集
  const fi = state.forage.findIndex(f => f.x === t.x && f.y === t.y);
  if (fi >= 0) {
    const f = state.forage[fi]; addItem(f.id, 1); state.forage.splice(fi, 1);
    xp('foraging', 8); progress('forage', 1); sfx('catch'); burst(p.x, p.y - 12, D.itemColor(f.id), 6);
    floatText(p.x, p.y - 22, '+' + D.itemName(f.id), '#bfe8a6'); save(); return;
  }
  // 作物收获
  const td = state.tiles[key];
  if (td?.crop && td.crop.stage >= 4 && !td.crop.dead && id !== 'pick' && id !== 'axe') {
    const def = D.CROPS[td.crop.id];
    let n = 1 + (def.chance && Math.random() < def.chance ? 1 : 0) + (def.multi ? def.multi - 1 : 0);
    if (def.shape === 'root' && state.skills.farming.lv >= 5 && Math.random() < .1) n++;
    const q = Math.min(3, 1 + (td.crop.perfect >= def.days ? 1 : 0) + Math.floor((state.skills.farming.lv - 1) / 6));
    for (let i = 0; i < n; i++) addItemWithQuality(td.crop.id, q);
    xp('farming', 12 + def.days);
    sfx('catch'); burst(p.x, p.y - 10, def.color, 10);
    floatText(p.x, p.y - 24, '+' + n + ' ' + def.name, '#ffe58a');
    if (def.regrow) { td.crop.stage = 3; td.crop.growth = def.days - def.regrow; td.crop.perfect = 0; }
    else delete td.crop;
    save(); return;
  }
  // 工具 / 物品
  if (!id) { toast('先选一个工具（按数字键）'); return; }
  if (D.TOOLS[id]) {
    if (id === 'hoe') {
      if (!isFarm(t.x, t.y) || features.has(key) || waterTile(t.x, t.y)) { toast('只能在农场的空草地上翻地'); return; }
      if (!spend(energyCost(4))) return;
      state.tiles[key] = { tilled:true, watered:false };
      sfx('dig'); burst(p.x, p.y - 12, '#8a5d3c', 6); save(); return;
    }
    if (id === 'can') {
      if (state.can <= 0) {
        if (waterTile(t.x, t.y)) { state.can = 20; sfx('water'); toast('洒水壶装满了！'); updateHUD(); save(); }
        else toast('没水了，去水边按空格装水');
        return;
      }
      if (td?.tilled && !td.watered) {
        if (!spend(energyCost(3))) return;
        td.watered = true; state.can--; sfx('water'); burst(p.x, p.y - 12, '#8fd8f0', 7); save(); return;
      }
      if (!td && isFarm(t.x, t.y) && !features.has(key)) {
        if (!spend(energyCost(3))) return;
        state.tiles[key] = { tilled:true, watered:true }; state.can--; sfx('water'); save(); return;
      }
      toast('这里不需要浇水'); return;
    }
    if (id === 'axe') {
      if (features.get(key) !== 'tree') { toast('这里没有可以砍的树'); return; }
      if (!spend(energyCost(6))) return;
      features.delete(key); state.removed.push(key); addItem('wood', 5 + (Math.random() < .4 ? 2 : 0));
      if (Math.random() < .5) addItem('fiber', 2);
      xp('foraging', 6); sfx('chop'); burst(p.x, p.y - 12, '#a8794d', 12); save(); return;
    }
    if (id === 'pick') {
      if (features.get(key) === 'rock') {
        if (!spend(energyCost(6))) return;
        features.delete(key); state.removed.push(key); addItem('stone', 3);
        if (Math.random() < .35) addItem('copper', 1);
        xp('mining', 8); progress('stone', 3); sfx('chop'); burst(p.x, p.y - 12, '#9a9b91', 10); save(); return;
      }
      if (state.machines.some(m => m.x === t.x && m.y === t.y)) { toast('机器要用「操作」，别敲坏啦'); return; }
      toast('这里没有可以敲的石头'); return;
    }
    if (id === 'scythe') {
      if (td?.crop) {
        if (!spend(energyCost(2))) return;
        delete td.crop; addItem('fiber', 1); sfx('chop'); toast('清掉了作物'); save(); return;
      }
      if (!features.has(key) && (isFarm(t.x, t.y) || isForest(t.x, t.y))) {
        if (!spend(energyCost(2))) return;
        addItem('fiber', 1); sfx('chop'); burst(p.x, p.y - 12, '#a6b16a', 5); save(); return;
      }
      toast('这里没有可以割的东西'); return;
    }
    if (id === 'rod') {
      if (!waterTile(t.x, t.y)) {
        // 允许面朝水边一格
        const dx = DIRS[p.dir][0], dy = DIRS[p.dir][1];
        if (!waterTile(t.x + dx, t.y + dy)) { toast('要站在水边才能钓鱼哦'); return; }
      }
      if (!spend(energyCost(5))) return;
      openFishing(); return;
    }
  }
  // 种子
  if (D.SEED_PRICES[id] !== undefined) {
    const cropId = Object.keys(D.CROPS).find(k => D.CROPS[k].seed === id);
    const def = D.CROPS[cropId];
    if (!def.seasons.includes(state.time.season)) { toast(def.name + '不是' + seasonNow() + '天的作物'); return; }
    if (!td?.tilled || td.crop) { toast('要先翻好地，并且地里没有作物'); return; }
    if (!removeItem(id, 1)) { toast('种子不够了'); return; }
    td.crop = { id:cropId, growth:0, stage:0, perfect:0, dead:false };
    sfx('dig'); save(); return;
  }
  // 食物
  const item = D.SIMPLE_ITEMS[id];
  if (item?.kind === 'food') {
    if (!removeItem(id, 1)) { toast('没有' + item.name + '了'); return; }
    state.player.energy = Math.min(state.totalEnergy, state.player.energy + (item.energy || 20));
    sfx('eat'); floatText(p.x, p.y - 24, '+' + (item.energy || 20) + '⚡', '#9ce8a0'); updateHUD(); save(); return;
  }
  // 机器放置
  if (item?.kind === 'machine') {
    if (!isFarm(t.x, t.y) || features.has(key) || state.machines.some(m => m.x === t.x && m.y === t.y)) { toast('要放在农场的空地上'); return; }
    if (!removeItem(id, 1)) return;
    state.machines.push({ x:t.x, y:t.y, type:id, item:null, days:0 });
    sfx('dig'); toast('放好了' + item.name); save(); return;
  }
  toast('这个东西现在用不上');
}
function addItemWithQuality(id, q) {
  addItem(id, 1);
  // 星露谷品质差：银/金品质直接结算差价，避免产生无法计价的怪物品
  if (q > 1) {
    const bonus = Math.round(D.itemSell(id) * (q - 1) * .25);
    if (bonus) { state.gold += bonus; state.stats.earned += bonus; progress('earned', bonus); }
  }
}

// ---------------------------------------------------------------- 矿井
function genMine(level) {
  const rocks = [];
  for (let x = 2; x < 28; x++) for (let y = 2; y < 18; y++) {
    if ((x < 5 && y < 5)) continue;
    if (A.hash(x, y, level * 17) > .78) {
      const r = A.hash(x, y, level * 31);
      let ore = null;
      if (r > .94) ore = 'gem'; else if (r > .86) ore = 'gold';
      else if (r > .72) ore = 'iron'; else if (r > .5) ore = 'copper';
      else if (r > .25) ore = 'coal';
      rocks.push({ x, y, hp: ore === 'gem' || ore === 'gold' ? 3 : 2, ore });
    }
  }
  let lx, ly;
  do { lx = 3 + Math.floor(Math.random() * 24); ly = 3 + Math.floor(Math.random() * 13); }
  while (rocks.some(r => r.x === lx && r.y === ly) || (lx < 5 && ly < 5));
  state.mine = { level, rocks, ladder:[lx,ly] };
  state.player.x = 3*16+8; state.player.y = 3*16+14; state.player.dir = 'down';
}
function mineAction(t) {
  const m = state.mine;
  if (t.x === 3 && t.y === 3 && m.level === 1) {
    state.scene = 'farm'; state.player.x = 44*16+8; state.player.y = 10*16+12;
    toast('回到地面了'); save(); return;
  }
  if (m.ladder && t.x === m.ladder[0] && t.y === m.ladder[1]) {
    genMine(m.level + 1); sfx('level'); toast('下到矿井 ' + state.mine.level + ' 层！'); save(); return;
  }
  const rock = m.rocks.find(r => r.x === t.x && r.y === t.y);
  if (!rock) { toast('这里没有矿石，找找楼梯（金色梯子）'); return; }
  if (state.toolbar[state.sel] !== 'pick') { toast('需要装备镐子'); return; }
  if (!spend(energyCost(6))) return;
  rock.hp--; sfx('chop'); burst(state.player.x, state.player.y - 10, '#8b847b', 8);
  if (rock.hp <= 0) {
    m.rocks.splice(m.rocks.indexOf(rock), 1);
    addItem('stone', 1 + Math.floor(Math.random()*3));
    if (rock.ore) addItem(rock.ore, 1);
    xp('mining', 10); progress('stone', 1);
    floatText(state.player.x, state.player.y - 22, rock.ore ? '+' + D.itemName(rock.ore) : '+石头', '#ffe0a0');
  }
  save();
}

// ---------------------------------------------------------------- 弹窗
function showModal(name, html) {
  closeModal();
  modalName = name;
  $('#modal-layer').innerHTML = '<div class="modal-mask"><div class="modal">' + html + '</div></div>';
  $('#modal-layer').querySelector('.modal-mask').addEventListener('mousedown', e => {
    if (e.target === e.currentTarget && name !== 'fishing') closeModal();
  });
}
function closeModal() { $('#modal-layer').innerHTML = ''; modalName = null; fishUI = null; }
function iconCanvas(id, size = 34) {
  const cv = document.createElement('canvas'); cv.width = 16; cv.height = 16;
  const x = cv.getContext('2d'); x.imageSmoothingEnabled = false; A.drawItem(x, id, 0, 0);
  // 转成 data URL：直接塞 outerHTML 会丢失画布像素
  return `<img src="${cv.toDataURL()}" alt="" style="width:${size}px;height:${size}px;image-rendering:pixelated">`;
}
const head = (title, lead) => `<div class="modal-head"><div><h2>${title}</h2><div class="lead">${lead}</div></div><button class="close" data-close>关闭 ✕</button></div>`;
function bindClose() { $('#modal-layer [data-close]')?.addEventListener('click', closeModal); }

function confirmSleep() {
  showModal('sleep', `<h2>要睡觉了吗？</h2><div class="lead">现在是 ${Math.floor(state.time.min/60)}:${String(state.time.min%60).padStart(2,'0')}。睡觉会结算出货箱、推进作物和机器。凌晨 2 点后昏倒会损失体力。</div>
    <div class="modal-foot"><span>明天是 ${seasonNow()} ${state.time.day + 1 > 28 ? 1 : state.time.day + 1} 日</span><div>
    <button class="big-btn alt" data-close>再玩一会</button> <button class="big-btn" id="do-sleep">睡觉 💤</button></div></div>`);
  bindClose();
  $('#do-sleep').onclick = () => { closeModal(); advanceDay(); };
}

function openShipping() {
  const items = Object.entries(state.inv).filter(([id, n]) => n > 0 && D.itemSell(id) > 0 && id !== 'rice');
  const rows = items.map(([id, n]) => `<div class="card">${iconCanvas(id)}<div class="info"><div class="nm">${D.itemName(id)} ×${n}</div><div class="pr">单价 ${sellPrice(id)}g · 今晚结算</div></div><button data-ship="${id}">放入 1</button><button data-shipall="${id}">全放</button></div>`).join('');
  let total = 0; for (const [id,n] of Object.entries(state.shipping)) total += sellPrice(id)*n;
  showModal('shipping', head('📦 出货箱', '放进箱子里的东西会在睡觉时自动卖出。鱼、作物、矿石都能卖。') +
    `<div class="grid">${rows || '<div class="empty">背包里暂时没有能卖的东西</div>'}</div>
    <div class="modal-foot"><span>今晚预计收入：<b style="color:#a4762e">${total} g</b></span><button class="big-btn" data-close>收好</button></div>`);
  bindClose();
  $('#modal-layer').querySelectorAll('[data-ship]').forEach(b => b.onclick = () => {
    const id = b.dataset.ship; if (removeItem(id, 1)) { state.shipping[id] = (state.shipping[id]||0)+1; save(); openShipping(); }
  });
  $('#modal-layer').querySelectorAll('[data-shipall]').forEach(b => b.onclick = () => {
    const id = b.dataset.shipall, n = state.inv[id]||0;
    if (removeItem(id, n)) { state.shipping[id] = (state.shipping[id]||0)+n; save(); openShipping(); }
  });
}

function openShop(tab = 'buy') {
  const seasons = [state.time.season];
  const seeds = Object.keys(D.SEED_PRICES).filter(id => {
    const cropId = Object.keys(D.CROPS).find(k => D.CROPS[k].seed === id);
    return D.CROPS[cropId].seasons.some(s => seasons.includes(s));
  });
  const toolUps = D.TOOL_UPGRADES.filter(u => !state.upgrades['done_' + u.id]);
  const buyRows = [
    ...seeds.map(id => {
      const cropId = Object.keys(D.CROPS).find(k => D.CROPS[k].seed === id), d = D.CROPS[cropId];
      return `<div class="card">${iconCanvas(id)}<div class="info"><div class="nm">${d.name}种子</div><div class="pr">${D.SEED_PRICES[id]}g · ${d.days}天 · 售${d.sell}g</div></div><button data-buy="${id}">买1</button><button data-buy5="${id}">×5</button></div>`;
    }),
    ...['rice','bait'].map(id => `<div class="card">${iconCanvas(id)}<div class="info"><div class="nm">${D.itemName(id)}</div><div class="pr">${D.SIMPLE_ITEMS[id].buy}g</div></div><button data-buy="${id}">买1</button><button data-buy5="${id}">×5</button></div>`),
    ...toolUps.map(u => `<div class="card" style="background:#fff6dd"><div class="info"><div class="nm">工具升级 · ${u.name}</div><div class="pr">${u.cost}g · ${u.note}</div></div><button data-up="${u.id}">升级</button></div>`)
  ].join('');
  const sellRows = Object.entries(state.inv).filter(([id,n]) => n > 0 && D.itemSell(id) > 0)
    .map(([id,n]) => `<div class="card">${iconCanvas(id)}<div class="info"><div class="nm">${D.itemName(id)} ×${n}</div><div class="pr">${sellPrice(id)}g / 个</div></div><button class="sell" data-sell="${id}">卖1</button><button class="sell" data-sellall="${id}">卖全部</button></div>`).join('');
  showModal('shop', head('🏪 皮埃尔的杂货店', '「哟，本鲸！今天的种子很新鲜，鱼片最近可爱种地了？」') +
    `<div class="tabs"><button class="tab ${tab==='buy'?'on':''}" data-tab="buy">购买</button><button class="tab ${tab==='sell'?'on':''}" data-tab="sell">出售</button></div>
    <div class="grid">${tab==='buy' ? buyRows : (sellRows || '<div class="empty">背包里没有可以卖的东西</div>')}</div>
    <div class="modal-foot"><span>持有：<b style="color:#a4762e">${state.gold} g</b></span><button class="big-btn" data-close>离开</button></div>`);
  bindClose();
  $('#modal-layer').querySelectorAll('[data-tab]').forEach(b => b.onclick = () => openShop(b.dataset.tab));
  $('#modal-layer').querySelectorAll('[data-buy]').forEach(b => b.onclick = () => buy(b.dataset.buy, 1));
  $('#modal-layer').querySelectorAll('[data-buy5]').forEach(b => b.onclick = () => buy(b.dataset.buy5, 5));
  $('#modal-layer').querySelectorAll('[data-sell]').forEach(b => b.onclick = () => sell(b.dataset.sell, 1));
  $('#modal-layer').querySelectorAll('[data-sellall]').forEach(b => b.onclick = () => sell(b.dataset.sell, state.inv[b.dataset.sellall]));
  $('#modal-layer').querySelectorAll('[data-up]').forEach(b => b.onclick = () => {
    const u = D.TOOL_UPGRADES.find(x => x.id === b.dataset.up);
    if (state.gold < u.cost) return toast('金币不够', 'bad');
    state.gold -= u.cost; state.upgrades['done_' + u.id] = true;
    for (const t of ['hoe','can','axe','pick','scythe','rod']) state.upgrades[t] = Math.max(state.upgrades[t]||0, D.TOOL_UPGRADES.indexOf(u)+1);
    sfx('coin'); toast('工具升级为' + u.name + '！'); save(); openShop('buy');
  });
}
function buy(id, n) {
  const price = D.SEED_PRICES[id] !== undefined ? D.SEED_PRICES[id] : D.SIMPLE_ITEMS[id]?.buy;
  if (!price) return;
  const cost = price * n;
  if (state.gold < cost) { toast('金币不够，先去卖点东西吧', 'bad'); sfx('bad'); return; }
  state.gold -= cost; addItem(id, n); sfx('coin'); save(); openShop('buy'); updateHUD();
}
function sell(id, n) {
  n = Math.min(n, state.inv[id] || 0); if (!n) return;
  const gain = sellPrice(id) * n;
  removeItem(id, n); state.gold += gain; state.stats.earned += gain;
  const kind = D.itemKind(id);
  if (kind === 'crop') progress('shipCrops', n);
  progress('earned', gain);
  sfx('coin'); floatText(state.player.x, state.player.y - 22, '+' + gain + 'g', '#ffd76a');
  save(); openShop('sell'); updateHUD();
}

function openInventory() {
  const items = Object.entries(state.inv).filter(([id,n]) => n > 0).sort((a,b) => D.itemKind(a[0]).localeCompare(D.itemKind(b[0])));
  const rows = items.map(([id,n]) => `<div class="card">${iconCanvas(id)}<div class="info"><div class="nm">${D.itemName(id)} ×${n}</div><div class="pr">${D.itemKind(id)==='food' ? '恢复 ' + D.SIMPLE_ITEMS[id].energy + ' 体力' : '售价 ' + sellPrice(id) + 'g'}</div></div><button data-equip="${id}">装备</button></div>`).join('');
  showModal('inventory', head('🎒 背包', '点击「装备」把物品放到当前选中的工具栏格子里。按 I 关闭。') +
    `<div class="grid">${rows || '<div class="empty">空空如也，去种点东西吧</div>'}</div>
    <div class="modal-foot"><span>金币 ${state.gold} g · 体力 ${state.player.energy}/${state.totalEnergy}</span><button class="big-btn" data-close>收好</button></div>`);
  bindClose();
  $('#modal-layer').querySelectorAll('[data-equip]').forEach(b => b.onclick = () => {
    state.toolbar[state.sel] = b.dataset.equip; renderToolbar(); save(); toast('已装备 ' + D.itemName(b.dataset.equip)); closeModal();
  });
}

function openCraft() {
  const rows = Object.entries(D.RECIPES).map(([id, r]) => {
    const mat = Object.entries(r.cost).map(([m,n]) => `${D.itemName(m)} ${state.inv[m]||0}/${n}`).join(' · ');
    return `<div class="card">${iconCanvas(id)}<div class="info"><div class="nm">${r.name}</div><div class="pr">${mat}</div></div><button data-craft="${id}">制作</button></div>`;
  }).join('');
  showModal('craft', head('🔨 制作台', D.RECIPES && '洒水器每天早上自动浇水；果酱罐和熏鱼器放进去，睡一觉就出货。') +
    `<div class="grid">${rows}</div><div class="modal-foot"><span>做好的机器会自动放进背包，选中后放在农场空地上。</span><button class="big-btn" data-close>收好</button></div>`);
  bindClose();
  $('#modal-layer').querySelectorAll('[data-craft]').forEach(b => b.onclick = () => {
    const r = D.RECIPES[b.dataset.craft];
    if (Object.entries(r.cost).some(([m,n]) => (state.inv[m]||0) < n)) { toast('材料不够，去矿井敲点矿吧', 'bad'); return; }
    for (const [m,n] of Object.entries(r.cost)) removeItem(m, n);
    addItem(b.dataset.craft, 1); sfx('level'); toast('做好了' + r.name); save(); openCraft();
  });
}

function openQuests() {
  const rows = state.quests.map(q => {
    const btn = q.claimed ? '<button disabled>已领取</button>' : q.done ? `<button data-claim="${q.id}">领奖</button>` : '<button disabled>进行中</button>';
    return `<div class="card" style="align-items:flex-start"><div class="info"><div class="nm">${q.name}</div><div class="pr">${q.desc} · ${q.progress||0}/${q.goal} · 奖励 ${q.reward}g</div></div>${btn}</div>`;
  }).join('');
  showModal('quests', head('📋 委托告示板', '完成委托后回来领取金币奖励。进度会一直累计。') + `<div class="grid">${rows}</div>`);
  bindClose();
  $('#modal-layer').querySelectorAll('[data-claim]').forEach(b => b.onclick = () => {
    const q = state.quests.find(x => x.id === b.dataset.claim);
    q.claimed = true; state.gold += q.reward; state.stats.earned += q.reward;
    sfx('coin'); toast('领取了 ' + q.reward + 'g 奖励！', 'good'); save(); updateHUD(); openQuests();
  });
}

function openFishing() {
  const avail = D.FISH.filter(f => f.seasons.includes(state.time.season) && (!f.weather || f.weather === state.time.weather));
  const hour = state.time.min / 60;
  const pool = avail.filter(f => !f.time || (f.time === 'day' ? hour >= 6 && hour < 19 : hour >= 19 || hour < 6));
  const list = pool.length ? pool : avail;
  const fish = list[Math.floor(Math.random() * list.length)];
  const up = state.upgrades.rod || 0;
  const hasBait = (state.inv.bait || 0) > 0;
  if (hasBait) removeItem('bait', 1);
  showModal('fishing', `<div class="fish-wrap"><div class="modal-head" style="text-align:left"><div><h2>🎣 钓鱼中…</h2><div class="lead">按住 空格 或下方按钮，让白色浮标停在绿色区域里</div></div><button class="close" data-close>放弃</button></div>
    <div class="fish-tank" id="tank"><div class="zone" id="fzone"></div><div class="fish" id="ffish"></div><div class="line" id="fline"></div></div>
    <div class="fish-meter"><i id="fmeter"></i></div>
    <div class="fish-tip" id="ftip">上钩的好像是「${fish.name}」…</div>
    <button class="big-btn" id="fish-btn" style="margin-top:10px">按住收线</button></div>`);
  bindClose();
  const fishEl = $('#ffish'); fishEl.innerHTML = iconCanvas(fish.id, 34);
  fishUI = { fish, t:0, y:50, fishY:50, zoneY:50, prog:0, hold:false, up, bait:hasBait, done:false };
  const btn = $('#fish-btn');
  btn.addEventListener('mousedown', e => { e.preventDefault(); fishUI.hold = true; });
  ['mouseup','mouseleave'].forEach(ev => btn.addEventListener(ev, () => { if (fishUI) fishUI.hold = false; }));
}

function openHelp() {
  showModal('help', head('❔ 玩法说明', '种地、钓鱼、挖矿、做机器——本鲸的农场啥都能干。') + `
    <div style="font-size:clamp(11px,1.3vw,14px);line-height:1.9;columns:2;column-gap:26px">
      <b>操作</b><br>WASD / 方向键：移动<br>空格 / J：使用工具、交互<br>数字键 1~9：切换工具栏<br>I：背包 · C：制作 · H：帮助<br>点击工具栏也能切换<br><br>
      <b>农场循环</b><br>① 锄头翻地 → ② 选种子按空格<br>③ 洒水壶浇水（雨天免浇）<br>④ 睡觉推进一天，作物长大<br>⑤ 成熟后按空格收获<br>⑥ 出货箱 / 商店卖钱<br><br>
      <b>赚钱路子</b><br>· 应季作物，草莓/蓝莓可反复收<br>· 海边钓鱼，河豚/鲨鱼最值钱<br>· 矿井敲矿，越深矿越好<br>· 果酱罐 / 熏鱼器加工翻倍<br>· 告示板委托额外奖励<br><br>
      <b>小贴士</b><br>· 体力用光会走不动，白饭能回体力<br>· 水壶没水时面朝水按空格装满<br>· 每天 6:00 开始，凌晨 2:00 昏倒<br>· 每 28 天换季，跨季作物会枯死<br>· 进度自动保存在此浏览器
    </div>
    <div class="modal-foot"><span>角色形象源自社区二创「溟月 / 蓝色乙」，CC BY-NC-SA 4.0</span><button class="big-btn" data-close>知道了</button></div>`);
  bindClose();
}

// ---------------------------------------------------------------- 工具栏 / HUD
function renderToolbar() {
  const bar = $('#toolbar'); bar.innerHTML = '';
  state.toolbar.forEach((id, i) => {
    const el = document.createElement('div'); el.className = 'slot' + (i === state.sel ? ' sel' : '');
    el.title = id ? D.itemName(id) + (D.TOOLS[id] ? ' — ' + D.TOOLS[id].desc : '') : '空格子';
    el.innerHTML = `<span class="key">${i+1}</span>` + (id ? iconCanvas(id, 34) + (D.TOOLS[id] ? '' : `<span class="qty">${state.inv[id]||0}</span>`) : '');
    el.onclick = () => { state.sel = i; renderToolbar(); save(); };
    bar.appendChild(el);
  });
}
function refreshToolbar() { if (state) renderToolbar(); }
function updateHUD() {
  if (!state) return;
  const t = state.time, h = Math.floor(t.min/60), m = Math.floor(t.min)%60;
  $('#hud-date').textContent = seasonNow() + ' ' + t.day + ' 日';
  $('#hud-time').textContent = `${h}:${String(m).padStart(2,'0')}`;
  $('#hud-weather').textContent = t.weather === '雨' ? '🌧' : '☀';
  $('#clockfill').style.width = clamp((t.min - 360) / 1200 * 100, 0, 100) + '%';
  $('#gold-val').textContent = state.gold;
  $('#energy-val').textContent = Math.max(0, Math.round(state.player.energy)) + '/' + state.totalEnergy;
  $('#efill').style.width = clamp(state.player.energy / state.totalEnergy * 100, 0, 100) + '%';
  $('#hud-loc').textContent = regionName(Math.floor(state.player.x/T), Math.floor(state.player.y/T));
}

// ---------------------------------------------------------------- 主循环
function update(dt) {
  tick += dt * 1000;
  if (!running || !state) return;
  // 时间
  if (!modalName || modalName === 'fishing') {
    state.time.min += dt * 6; // 1 秒 = 6 游戏分钟，一天约 3.3 分钟
    if (state.time.min >= 1560) {
      state.player.energy = Math.max(0, state.player.energy - 20);
      toast('太晚了，本鲸在外面睡着了……体力损失', 'bad'); advanceDay(); return;
    }
  }
  // 移动
  if (!modalName) {
    let dx = 0, dy = 0;
    if (keys.has('w') || keys.has('arrowup')) dy--;
    if (keys.has('s') || keys.has('arrowdown')) dy++;
    if (keys.has('a') || keys.has('arrowleft')) dx--;
    if (keys.has('d') || keys.has('arrowright')) dx++;
    if (touchDir) { dx = touchDir[0]; dy = touchDir[1]; }
    if (dx || dy) {
      const len = Math.hypot(dx, dy); dx /= len; dy /= len;
      const speed = state.player.energy > 0 ? 62 : 32;
      if (!blocked(state.player.x + dx*speed*dt, state.player.y)) state.player.x += dx*speed*dt;
      if (!blocked(state.player.x, state.player.y + dy*speed*dt)) state.player.y += dy*speed*dt;
      if (Math.abs(dx) > Math.abs(dy)) state.player.dir = dx < 0 ? 'left' : 'right';
      else state.player.dir = dy < 0 ? 'up' : 'down';
      state.player.anim += dt * 7;
      state.player.frame = Math.floor(state.player.anim) % 2;
    } else state.player.frame = 0;
  }
  // 钓鱼小游戏
  if (fishUI && modalName === 'fishing') updateFishing(dt);
  // 粒子 / 飘字
  for (let i = particles.length-1; i >= 0; i--) {
    const p = particles[i]; p.life -= dt; p.x += p.vx*dt; p.y += p.vy*dt; p.vy += 110*dt;
    if (p.life <= 0) particles.splice(i,1);
  }
  for (let i = floats.length-1; i >= 0; i--) { floats[i].life -= dt; floats[i].y -= 12*dt; if (floats[i].life<=0) floats.splice(i,1); }
  // 摄像机
  if (state.scene === 'mine') {
    camera.x = clamp(state.player.x - W/2, 0, 29*T - W);
    camera.y = clamp(state.player.y - H/2, 0, 19*T - H);
  } else {
    camera.x = clamp(state.player.x - W/2, 0, MW*T - W);
    camera.y = clamp(state.player.y - H/2, 0, MH*T - H);
  }
  updateHUD();
  const h = hintText(); const hint = $('#hint');
  if (h && !modalName) { hint.textContent = h; hint.classList.remove('hidden'); } else hint.classList.add('hidden');
}
function updateFishing(dt) {
  const f = fishUI; if (f.done) return;
  f.t += dt;
  const speed = 1.1 + f.fish.diff * 2.2;
  f.fishY = 50 + Math.sin(f.t * speed + 1) * (26 + f.fish.diff * 16);
  f.zoneY += (f.fishY - f.zoneY) * Math.min(1, dt * (1.5 + f.up * .7));
  f.y += (f.hold ? -62 : 58) * dt;
  f.y = clamp(f.y, 0, 100);
  const half = 13 + f.up * 4 + (f.bait ? 6 : 0);
  const inZone = Math.abs(f.y - f.zoneY) < half;
  f.prog += (inZone ? 52 : -32) * dt;
  f.prog = clamp(f.prog, 0, 100);
  const zone = $('#fzone'), line = $('#fline'), meter = $('#fmeter');
  if (zone) { zone.style.top = (f.zoneY - half) + '%'; zone.style.height = (half * 2) + '%'; }
  if (line) line.style.top = f.y + '%';
  if (meter) meter.style.width = f.prog + '%';
  if (f.prog >= 100) {
    f.done = true;
    addItem(f.fish.id, 1); xp('fishing', 18 + Math.round(f.fish.diff*24)); progress('fish', 1);
    sfx('catch'); toast('钓到了' + f.fish.name + '！卖 ' + sellPrice(f.fish.id) + 'g', 'good');
    floatText(state.player.x, state.player.y - 24, f.fish.name + ' +1', '#a8e6ff');
    save(); setTimeout(() => { if (modalName === 'fishing') closeModal(); }, 700);
  } else if (f.t > 35) {
    f.done = true; toast('鱼跑掉了……再试一次吧', 'bad');
    setTimeout(() => { if (modalName === 'fishing') closeModal(); }, 500);
  }
}

function render() {
  c.imageSmoothingEnabled = false;
  c.fillStyle = '#5a9c6a'; c.fillRect(0, 0, W, H);
  if (!state) return;
  const scene = state.scene;
  // 地面
  const x0 = Math.floor(camera.x/T), y0 = Math.floor(camera.y/T);
  const cols = Math.ceil(W/T)+1, rows = Math.ceil(H/T)+1;
  for (let ix = 0; ix < cols; ix++) for (let iy = 0; iy < rows; iy++) {
    const x = x0+ix, y = y0+iy;
    const sx = x*T-camera.x, sy = y*T-camera.y;
    if (scene === 'mine') A.drawGround(c, sx, sy, x, y, 0, 'cave');
    else {
      const v = groundVariant(x, y);
      if (v === 'water') A.drawWater(c, sx, sy, x, y, tick);
      else A.drawGround(c, sx, sy, x, y, state.time.season, v);
    }
  }
  if (scene === 'mine') renderMine(x0, y0, cols, rows);
  else renderWorld(x0, y0, cols, rows);
  // 天气
  if (state.time.weather === '雨' && scene !== 'mine') {
    c.strokeStyle = '#cfe9f3aa'; c.lineWidth = 1;
    for (let i = 0; i < 70; i++) {
      const rx = (i*47 + tick*.28) % (W+30) - 15, ry = (i*83 + tick*.52) % (H+30) - 15;
      c.beginPath(); c.moveTo(rx, ry); c.lineTo(rx-2, ry+7); c.stroke();
    }
  }
  // 光照
  const min = state.time.min;
  let dark = 0;
  if (min < 390) dark = .42 * (1 - (min-360)/30);
  if (min > 1080) dark = Math.min(.62, (min-1080)/260*.62);
  if (scene === 'mine') dark = .58;
  if (dark > 0) {
    c.fillStyle = `rgba(10,22,42,${dark})`; c.fillRect(0,0,W,H);
    if (scene !== 'mine') {
      for (const [wx, wy, r] of [[HOUSE.door[0]*T, HOUSE.door[1]*T, 46], [SHOP.door[0]*T, SHOP.door[1]*T, 52], [60*T, 22*T, 40]]) {
        const sx = wx-camera.x, sy = wy-camera.y;
        if (sx < -r || sx > W+r || sy < -r || sy > H+r) continue;
        const g = c.createRadialGradient(sx, sy, 2, sx, sy, r);
        g.addColorStop(0, 'rgba(255,205,110,.5)'); g.addColorStop(1, 'rgba(255,205,110,0)');
        c.fillStyle = g; c.beginPath(); c.arc(sx, sy, r, 0, 7); c.fill();
      }
    }
  }
  renderOverlay();
}
function drawFence(c, sx, sy, vertical) {
  A.R(c, sx + 6, sy + 2, 3, 13, '#8e6640');
  A.R(c, sx + 6, sy + 2, 3, 1, '#bb8d58');
  if (vertical) { A.R(c, sx + 6, sy + 4, 3, 8, '#a1784c'); A.R(c, sx + 7, sy + 4, 1, 8, '#c69b62'); }
  else { A.R(c, sx, sy + 6, 16, 3, '#a1784c'); A.R(c, sx, sy + 7, 16, 1, '#c69b62'); }
}

function renderWorld(x0, y0, cols, rows) {
  const season = state.time.season;
  // 农场栅栏（右侧留出通往小镇的门口）
  for (let x = 6; x < 41; x++) {
    drawFence(c, x*T-camera.x, 22*T-camera.y, false);
    drawFence(c, x*T-camera.x, 48*T-camera.y, false);
  }
  for (let y = 22; y < 49; y++) {
    drawFence(c, 6*T-camera.x, y*T-camera.y, true);
    if (y < 28 || y > 32) drawFence(c, 41*T-camera.x, y*T-camera.y, true);
  }
  // 野花点缀
  const flowerCols = [['#f2d85d','#e88fb4','#ffffff'], ['#e0566a','#f3bd39','#cba4d8'], ['#d98f4f','#c96a9b','#e5c65b'], ['#b69ad4','#e6eef0']][season];
  for (let ix = 0; ix < cols; ix++) for (let iy = 0; iy < rows; iy++) {
    const x = x0+ix, y = y0+iy, key = kk(x,y);
    if (features.has(key) || state.tiles[key]?.tilled || groundVariant(x,y) !== 'grass') continue;
    if (A.hash(x, y, 42) < .972) continue;
    const col = flowerCols[Math.floor(A.hash(x,y,43) * flowerCols.length)];
    A.drawFlower(c, x*T-camera.x, y*T-camera.y+2, col);
  }
  // 池塘荷叶
  for (const [px, py] of [[33,39],[35,41],[34,38]]) {
    const sx = px*T-camera.x, sy = py*T-camera.y;
    if (sx < -16 || sx > W || sy < -16 || sy > H) continue;
    A.R(c, sx+3, sy+6, 10, 5, '#4f9a5e'); A.R(c, sx+5, sy+7, 6, 3, '#68b36e');
    if (px === 34) { A.R(c, sx+7, sy+4, 3, 3, '#f0a7c0'); A.R(c, sx+8, sy+5, 1, 1, '#ffe9a0'); }
  }
  // 耕地 / 作物
  for (let ix = 0; ix < cols; ix++) for (let iy = 0; iy < rows; iy++) {
    const x = x0+ix, y = y0+iy, key = kk(x,y), t = state.tiles[key];
    if (!t?.tilled) continue;
    const sx = x*T-camera.x, sy = y*T-camera.y;
    A.drawTilled(c, sx, sy, t.watered, t.fert);
    if (t.crop) A.drawCrop(c, sx, sy, t.crop.id, t.crop.stage, t.crop.dead);
  }
  // 机器
  for (const m of state.machines) {
    const sx = m.x*T-camera.x, sy = m.y*T-camera.y;
    if (sx < -20 || sx > W+20 || sy < -20 || sy > H+20) continue;
    A.drawMachine(c, sx, sy, m.type, !!m.item);
  }
  // 出货箱 / 告示板
  let sx = 17*T-camera.x, sy = 27*T-camera.y; A.drawShipBin(c, sx, sy);
  sx = 53*T-camera.x; sy = 30*T-camera.y; A.drawBoard(c, sx, sy);
  // 建筑
  A.drawBuilding(c, HOUSE.x*T-camera.x, HOUSE.y*T-camera.y, HOUSE.w, HOUSE.h, 'house', tick);
  A.drawBuilding(c, SHOP.x*T-camera.x, SHOP.y*T-camera.y, SHOP.w, SHOP.h, 'shop', tick);
  A.drawMineEntrance(c, 44*T-camera.x, 8*T-camera.y, tick);
  // 采集物（按 y 排序与树一起画）
  const draws = [];
  for (let ix = 0; ix < cols; ix++) for (let iy = 0; iy < rows; iy++) {
    const x = x0+ix, y = y0+iy, key = kk(x,y), f = features.get(key);
    if (f) draws.push({ y, fn: () => f === 'tree' ? A.drawTree(c, x*T-camera.x, y*T-camera.y+16, season, tick)
      : A.drawRock(c, x*T-camera.x, y*T-camera.y+2) });
  }
  for (const f of state.forage) if (f.x >= x0 && f.x < x0+cols && f.y >= y0 && f.y < y0+rows)
    draws.push({ y:f.y, fn: () => A.drawFlower(c, f.x*T-camera.x, f.y*T-camera.y, D.itemColor(f.id)) });
  // 店主
  draws.push({ y:27, fn: () => A.drawWhale(c, 62*T-camera.x-8, 27*T-camera.y-21, 'down', 0, { skin:'#6f9d5c', dark:'#4b7244', light:'#9cc77e', hair:'#5b8750' }) });
  // 玩家
  draws.push({ y:state.player.y/T, fn: () => A.drawWhale(c, Math.round(state.player.x-camera.x-8), Math.round(state.player.y-camera.y-21), state.player.dir, state.player.frame) });
  draws.sort((a,b) => a.y-b.y).forEach(d => d.fn());
}
function renderMine(x0, y0, cols, rows) {
  for (const r of state.mine.rocks) {
    if (r.x < x0 || r.x >= x0+cols || r.y < y0 || r.y >= y0+rows) continue;
    A.drawRock(c, r.x*T-camera.x, r.y*T-camera.y+2, 14, r.ore);
  }
  if (state.mine.ladder) {
    const sx = state.mine.ladder[0]*T-camera.x, sy = state.mine.ladder[1]*T-camera.y;
    A.R(c, sx+2, sy+2, 12, 14, '#d6a94e');
    for (let i=0;i<4;i++) A.R(c, sx+4, sy+4+i*3, 8, 1, '#7b5c28');
    A.R(c, sx+6, sy+7, 4, 6, '#2a2622');
  }
  A.R(c, 3*T-camera.x+3, 3*T-camera.y+8, 10, 8, '#d6a94e');
  for (let i=0;i<3;i++) A.R(c, 3*T-camera.x+4, 3*T-camera.y+9+i*3, 8, 1, '#7b5c28');
  A.drawWhale(c, Math.round(state.player.x-camera.x-8), Math.round(state.player.y-camera.y-21), state.player.dir, state.player.frame);
}
function renderOverlay() {
  for (const p of particles) {
    if (p.x < camera.x || p.x > camera.x+W || p.y < camera.y || p.y > camera.y+H) continue;
    A.R(c, p.x-camera.x, p.y-camera.y, p.size, p.size, p.color);
  }
  for (const f of floats) {
    c.font = 'bold 8px system-ui, sans-serif'; c.textAlign = 'center';
    c.fillStyle = '#0008'; c.fillText(f.text, f.x-camera.x+1, f.y-camera.y+1);
    c.fillStyle = f.color; c.fillText(f.text, f.x-camera.x, f.y-camera.y);
  }
}

function loop(now) {
  const dt = Math.min(.05, (now - last)/1000); last = now;
  update(dt); render();
  requestAnimationFrame(loop);
}

// ---------------------------------------------------------------- 事件
let touchDir = null;
window.addEventListener('keydown', e => {
  const k = e.key.toLowerCase();
  if (['arrowup','arrowdown','arrowleft','arrowright',' '].includes(k)) e.preventDefault();
  if (k === 'escape' && modalName) { closeModal(); return; }
  if (modalName === 'fishing' && k === ' ') { if (fishUI) fishUI.hold = true; return; }
  if (!running) return;
  keys.add(k);
  if (k === ' ') doAction();
  if (k === 'i') openInventory();
  if (k === 'c') openCraft();
  if (k === 'h') openHelp();
  const n = parseInt(k,10);
  if (n >= 1 && n <= 9 && state.toolbar[n-1] !== undefined) { state.sel = n-1; renderToolbar(); save(); }
});
window.addEventListener('keyup', e => {
  const k = e.key.toLowerCase(); keys.delete(k);
  if (k === ' ' && fishUI) fishUI.hold = false;
});
window.addEventListener('blur', () => keys.clear());
window.addEventListener('beforeunload', save);
setInterval(() => { if (running) save(); }, 20000);

$('#btn-inv').onclick = openInventory;
$('#btn-craft').onclick = openCraft;
$('#btn-help').onclick = openHelp;
$('#btn-sound').onclick = () => {
  sfxOn = !sfxOn; $('#btn-sound').textContent = sfxOn ? '🔊' : '🔇';
  toast(sfxOn ? '声音已开启' : '声音已关闭');
};
$('#btn-new').onclick = () => {
  if (haveSave() && !confirm('已有存档，开始新游戏会覆盖它。确定吗？')) return;
  startGame(null);
};
$('#btn-continue').onclick = () => startGame(loadSave());
if (haveSave()) $('#btn-continue').classList.remove('hidden');

// 触屏
if ('ontouchstart' in window) {
  $('#touch').classList.remove('hidden');
  document.querySelectorAll('#dpad button').forEach(b => {
    const map = { up:[0,-1], down:[0,1], left:[-1,0], right:[1,0] };
    b.addEventListener('touchstart', e => { e.preventDefault(); touchDir = map[b.dataset.dir]; }, {passive:false});
    ['touchend','touchcancel'].forEach(ev => b.addEventListener(ev, () => { touchDir = null; }));
  });
  $('#touch-act').addEventListener('touchstart', e => { e.preventDefault(); doAction(); }, {passive:false});
}

// 标题插画
A.drawTitleArt($('#title-art-canvas').getContext('2d'));

// 调试钩子（供自动化测试与存档排查使用，不影响正常游玩）
window.__fishFarm = {
  get state() { return state; },
  get running() { return running; },
  get tick() { return tick; },
  get keys() { return Array.from(keys); },
  get fish() { return fishUI; },
  blockedAt(x, y) { return blocked(x, y); },
  startGame, doAction, advanceDay, openShop, openFishing, save, loadSave, addItem,
  press(k) { window.dispatchEvent(new KeyboardEvent('keydown', { key:k })); },
  release(k) { window.dispatchEvent(new KeyboardEvent('keyup', { key:k })); }
};
