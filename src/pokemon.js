/*
 * pokemon.js — 宝可梦数据专用源（0 元、不需要任何 Key）
 *
 * 为什么有这个文件（2026-11-02，主人选「A. 一分钱不花」）：
 *   智谱搜索没余额（429），只能落到 Bing 抓页；而 Bing 把「超级烈空坐种族值」拆成单字，
 *   抓回来的全是「超级简历」「烈」这种无关网页，模型只能拿记忆里的数字硬答 → 701 / 634 就是这么来的。
 *   宝可梦这题有现成的权威数据源，根本不用搜索引擎：PokeAPI（pokeapi.co）把官方游戏数据
 *   原样开放，免 Key、免注册、不限次数。所以这类问题直接查数据，不猜。
 *
 * 一条数据链：
 *   中文名 → 图鉴编号 / 英文名 / 形态表（本地表 data/pokemon-zh.json，一次建好，1025 条）
 *         → 挑对形态（「超级烈空坐」= rayquaza-mega，不是 rayquaza，两者种族值差 100）
 *         → 拉该形态的种族值 / 属性 / 身高体重
 *         → 拼成一段带来源的确定数据交给模型
 *
 * 拿不到的（特性、招式、进化链、对战强弱）一律不编：返回 null，交回 Bing 兜底或让它说记不清。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const INDEX_FILE = path.join(ROOT, 'data', 'pokemon-zh.json');
const GQL = 'https://beta.pokeapi.co/graphql/v1beta';
// PokeAPI 要求带能识别调用方的 UA，否则会被限流
const UA = 'xuhbot/1.0 (QQ bot; pokemon lookup; contact: local)';

const TYPE_ZH = {
  normal: '一般', fire: '火', water: '水', electric: '电', grass: '草', ice: '冰',
  fighting: '格斗', poison: '毒', ground: '地面', flying: '飞行', psychic: '超能力',
  bug: '虫', rock: '岩石', ghost: '幽灵', dragon: '龙', dark: '恶', steel: '钢', fairy: '妖精',
};

// 2 字名字必须同时出现「宝可梦语境词」才算数——否则「蛋蛋」「喵喵」「地鼠」「炎帝」
// 这些日常/历史词会被当成宝可梦，把无关数据硬塞给模型。3 字及以上几乎不会撞词，直接认。
const POKE_CTX = /宝可梦|寶可夢|精灵宝可梦|神奇宝贝|神奇寶貝|口袋妖怪|宠物小精灵|種族值|种族值|个体值|個體值|努力值|图鉴|圖鑑|进化|進化|屬性|属性|克制|弱点|弱點|招式|配招|特性|几号|幾號|编号|編號|mega|极巨化|極巨化|太晶|御三家|道馆|道館|训练家|訓練家|捕捉|孵蛋|蛋群/i;

let _idx = null;        // 中文名 -> { id, en, forms[], def }
let _building = null;
const cache = new Map(); // 形态英文名 -> { t, d }

// ===== 本地名表 =====
function readIndex() {
  if (_idx) return _idx;
  try {
    const j = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
    const m = j && j.map;
    if (!m) return null;
    // 格式校验：必须是 { 中文名: { id, en, forms[] } }。旧格式（值是纯数字）不能用，当没有
    const k0 = Object.keys(m)[0];
    const v0 = k0 && m[k0];
    if (!v0 || typeof v0 !== 'object' || !Array.isArray(v0.forms) || !v0.forms.length) return null;
    if (Object.keys(m).length < 100) return null;
    _idx = m;
    return _idx;
  } catch (e) { return null; }
}

// 名表丢了才现建（正常部署时文件已在，不会走到这里）。建成前这次查询直接放弃，不拖慢回复。
function buildIndex() {
  if (_building) return _building;
  _building = (async () => {
    const q = `{ sp: pokemon_v2_pokemonspecies {
      id name
      pokemon_v2_pokemonspeciesnames(where:{language_id:{_eq:12}}) { name }
      pokemon_v2_pokemons { name is_default }
    } }`;
    try {
      const r = await fetch(GQL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
        body: JSON.stringify({ query: q }),
        signal: AbortSignal.timeout(90000),
      });
      const j = await r.json();
      const sp = (j.data && j.data.sp) || [];
      const map = {};
      for (const s of sp) {
        const cn = s.pokemon_v2_pokemonspeciesnames && s.pokemon_v2_pokemonspeciesnames[0] && s.pokemon_v2_pokemonspeciesnames[0].name;
        const list = s.pokemon_v2_pokemons || [];
        if (!cn || !s.name || !list.length || map[cn]) continue;
        // 默认形态排第一，pickForm 才能用 forms[0] 兜底
        const def = (list.find(p => p.is_default) || list[0]).name;
        const forms = [def].concat(list.map(p => p.name).filter(n => n !== def));
        map[cn] = { id: s.id, en: s.name, forms, def };
      }
      if (Object.keys(map).length < 100) return null;
      fs.mkdirSync(path.dirname(INDEX_FILE), { recursive: true });
      fs.writeFileSync(INDEX_FILE, JSON.stringify({ builtAt: new Date().toISOString(), count: Object.keys(map).length, map }), 'utf8');
      _idx = map;
      console.log('[pokemon] 中文名表已重建，' + Object.keys(map).length + ' 条');
      return map;
    } catch (e) {
      console.log('[pokemon] 建名表失败：' + (e.name === 'TimeoutError' ? '超时' : e.message));
      return null;
    } finally { _building = null; }
  })();
  return _building;
}

// 这句话提到了哪些宝可梦（长名优先，被更长的框住就丢，避免一只算两次）
function matchNames(text, idx, limit) {
  const s = String(text || '');
  if (!s) return [];
  const hasCtx = POKE_CTX.test(s);
  const hits = [];
  for (const name of Object.keys(idx)) {
    if (name.length < 2) continue;
    if (name.length === 2 && !hasCtx) continue;   // 「蛋蛋」这类，没语境词就不认
    const at = s.indexOf(name);
    if (at < 0) continue;
    hits.push({ name, at, len: name.length, e: idx[name] });
  }
  hits.sort((a, b) => b.len - a.len || a.at - b.at);
  const out = [];
  for (const h of hits) {
    if (out.some(u => h.at >= u.at && h.at + h.len <= u.at + u.len)) continue; // 已被更长的覆盖
    if (out.some(u => u.e.id === h.e.id)) continue;                            // 同一只，别重复
    out.push(h);
    if (out.length >= (limit || 2)) break;
  }
  return out;
}

// ===== 形态 =====
// 「超级烈空坐」是 rayquaza-mega（种族值 780），「烈空坐」是 rayquaza（680）。
// 认错形态 = 给错数字，比查不到更糟，所以这里按修饰词精确挑。
const FORM_RULES = [
  { re: /超级巨化|超极巨化|极巨化|極巨化|gmax/i, suffix: '-gmax' },
  { re: /原始回归|原始|primal/i, suffix: '-primal' },
  { re: /超级|超級|mega|m进化/i, suffix: '-mega' },
  { re: /伽勒尔|伽勒爾|galar/i, suffix: '-galar' },
  { re: /阿罗拉|阿羅拉|alola/i, suffix: '-alola' },
  { re: /洗翠|hisui/i, suffix: '-hisui' },
  { re: /帕底亚|帕底亞|paldea/i, suffix: '-paldea' },
];

function pickForm(entry, text) {
  const forms = (entry && entry.forms) || [];
  const def = (entry && entry.def) || forms[0] || (entry && entry.en);
  if (!forms.length) return def;
  const t = String(text || '');
  for (const rule of FORM_RULES) {
    if (!rule.re.test(t)) continue;
    // 超级进化有 X／Y 两种（超级超梦X、超级喷火龙Y）——要再确认，选错就是另一个形态的数据
    if (rule.suffix === '-mega') {
      if (/[xX]/.test(t)) { const h = forms.find(f => /-mega-x$/.test(f)); if (h) return h; }
      if (/[yY]/.test(t)) { const h = forms.find(f => /-mega-y$/.test(f)); if (h) return h; }
    }
    const hit = forms.find(f => f.endsWith(rule.suffix))
      // 伽勒尔形态在数据里叫 -galarian，两种拼法都要认
      || (rule.suffix === '-galar' ? forms.find(f => f.endsWith('-galarian')) : null);
    if (hit) return hit;
    return def;   // 说了超级但数据里没这个形态 → 退回默认，不瞎编
  }
  return def;
}

// ===== 取数据 =====
// 为什么用 GraphQL 而不是 REST（2026-11-02 实测）：
//   REST /pokemon/{名字} 一次吐 294KB（还带全部招式表），这台机器网络一抖就 7 秒超时；
//   GraphQL 只回种族值/属性/身高体重，1.5KB、0.4~1.7 秒，还能一次查好几只（比较题只需一次请求）。
const STAT_ORDER = ['hp', 'attack', 'defense', 'special-attack', 'special-defense', 'speed'];
const STAT_ZH = { hp: 'HP', attack: '攻击', defense: '防御', 'special-attack': '特攻', 'special-defense': '特防', speed: '速度' };

function shape(p) {
  const raw = {};
  for (const s of p.pokemon_v2_pokemonstats || []) {
    const n = s.pokemon_v2_stat && s.pokemon_v2_stat.name;
    if (n) raw[n] = s.base_stat;
  }
  return {
    en: p.name,
    types: (p.pokemon_v2_pokemontypes || []).map(t => TYPE_ZH[(t.pokemon_v2_type || {}).name] || (t.pokemon_v2_type || {}).name || '').filter(Boolean),
    height: (p.height || 0) / 10,
    weight: (p.weight || 0) / 10,
    stats: STAT_ORDER.map(k => [STAT_ZH[k], raw[k] || 0]),
    total: STAT_ORDER.reduce((a, k) => a + (raw[k] || 0), 0),
  };
}

async function fetchMany(formNames) {
  const out = new Map();          // name -> data
  const need = [];
  for (const n of formNames) {
    const hit = cache.get(n);
    if (hit && Date.now() - hit.t < 6 * 3600 * 1000) out.set(n, hit.d);
    else need.push(n);
  }
  if (!need.length) return out;
  const q = `{ pk: pokemon_v2_pokemon(where:{name:{_in:${JSON.stringify(need)}}}) {
    name height weight
    pokemon_v2_pokemonstats { base_stat pokemon_v2_stat { name } }
    pokemon_v2_pokemontypes { pokemon_v2_type { name } }
  } }`;
  try {
    const r = await fetch(GQL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
      body: JSON.stringify({ query: q }),
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) { console.log('[pokemon] 取数据 HTTP ' + r.status); return out; }
    const j = await r.json();
    for (const p of ((j.data && j.data.pk) || [])) {
      const d = shape(p);
      out.set(p.name, d);
      cache.set(p.name, { t: Date.now(), d });
    }
    if (cache.size > 400) cache.delete(cache.keys().next().value);
  } catch (e) {
    console.log('[pokemon] 取数据失败：' + (e.name === 'TimeoutError' ? '超时' : e.message));
  }
  return out;
}

const FORM_ZH = [
  [/mega-x$/, '超级进化 X'], [/mega-y$/, '超级进化 Y'], [/mega$/, '超级进化'],
  [/gmax$/, '超极巨化'], [/primal$/, '原始回归'], [/galarian$|-galar$/, '伽勒尔的样子'],
  [/alola$/, '阿罗拉的样子'], [/hisui$/, '洗翠的样子'], [/paldea$/, '帕底亚的样子'],
];

function render(rows) {
  const lines = rows.map(({ cn, form, d, dexNo, isDef }) => {
    let title = cn;
    if (!isDef) {
      const zh = FORM_ZH.find(([re]) => re.test(form));
      title = cn + '・' + (zh ? zh[1] : form);   // 形态必须写出来，不然「超级烈空坐」看着像普通烈空坐
    }
    return '【' + title + '】 No.' + String(dexNo).padStart(4, '0')
      + '\n属性：' + (d.types.join(' / ') || '（数据里没写）')
      + '\n身高 ' + d.height.toFixed(1) + ' m　体重 ' + d.weight.toFixed(1) + ' kg'
      + '\n种族值：' + d.stats.map(([k, v]) => k + ' ' + v).join(' ｜ ')
      + '\n种族值合计：' + d.total;
  });
  return '（以下是从 PokeAPI 取的**官方游戏数据**，数字确定、不是我猜的。'
    + '问数值就直接照抄这些数字，一个都不许改、不许四舍五入、不许用记忆里的旧数字；'
    + '如果你记得的不一样，以这里为准。）\n\n'
    + lines.join('\n\n')
    + '\n\n（来源：pokeapi.co。这里只有属性/身高体重/六项种族值，'
    + '特性、招式、进化链、谁打得过谁这些**它没有**——问到了就说不知道，别自己补。）';
}

// 主入口：能确定这只宝可梦就返回给模型看的文本，否则 null（交回原来的 Bing 兜底）
async function lookup(q) {
  const idx = readIndex();
  if (!idx) { buildIndex(); return null; }
  const hits = matchNames(q, idx, 2);
  if (!hits.length) return null;
  const picked = hits.map(h => ({
    cn: h.name,
    form: pickForm(h.e, q),
    dexNo: h.e.id,
    def: h.e.def || h.e.forms[0],
  }));
  const mons = await fetchMany([...new Set(picked.map(p => p.form))]);
  const rows = picked.map(p => {
    const d = mons.get(p.form);
    return d ? { cn: p.cn, form: p.form, d, dexNo: p.dexNo, isDef: p.form === p.def } : null;
  }).filter(Boolean);
  if (!rows.length) return null;
  console.log('[pokemon] 命中 ' + rows.map(r => r.cn + '→' + r.form).join('、'));
  return render(rows);
}

module.exports = { lookup, _matchNames: matchNames, _pickForm: pickForm, _readIndex: readIndex, _buildIndex: buildIndex };
