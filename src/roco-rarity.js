'use strict';
/* src/roco-rarity.js —— 远行商人商品稀有度（2026-11-21 主人定）
 *
 * 主人原话：「稀有度是棱镜球、祝福项坠、炫彩蛋。根据这个排名。动态算每天的提醒额度。」
 *          「一天已经发了十次稀有的，就不在下一轮发炫彩蛋这种不稀有的。」
 *          「如果一天发了炫彩蛋这种不稀有的，下次就要突破限制再发棱镜球、祝福项坠。」
 *
 * 排名只写一处：features.json → rocoMerchant.rarity。QQ 的 @ 提醒和 B站 的评论区提醒
 * 都读这一份，别各写一份（写两份早晚对不上）。数字越大越稀有；
 * 配置里没有的商品算 0，不参与额度判断（既不占稀有额度，也不占普通额度）。
 *
 * 为什么单开一个文件：roco-merchant 要 require roco-bili，roco-bili 又要判稀有度，
 * 两者互相 require 会拿到半截 exports。抽到第三方文件，谁都能安全 require。
 */

const configStore = require('./config');

const DEFAULTS = { '棱镜球': 3, '祝福项坠': 2, '炫彩蛋': 1, '炫彩精灵蛋': 1 };
const RARE_MIN = 2;     // ≥2 算稀有（棱镜球 3、祝福项坠 2）；1 算普通（炫彩蛋）

/* 当前生效的排名表：默认值打底，配置里能改、能加。 */
function map() {
  let cfg = null;
  try { cfg = (configStore.cfgLive().rocoMerchant || {}).rarity; } catch { cfg = null; }
  const out = Object.assign({}, DEFAULTS);
  if (cfg && typeof cfg === 'object') {
    for (const k of Object.keys(cfg)) {
      const name = String(k || '').trim();
      const n = Number(cfg[k]);
      if (name && Number.isFinite(n) && n > 0) out[name] = n;
      else if (name && Number.isFinite(n) && n <= 0) delete out[name];
    }
  }
  return out;
}

function norm(s) { return String(s || '').replace(/[\s\u3000]+/g, '').trim(); }

/* 商品名 → 稀有度。先精确匹配，再做包含匹配（数据源会写「炫彩精灵蛋」「炫彩蛋」两种）。 */
function of(name) {
  const n = norm(name);
  if (!n) return 0;
  const m = map();
  if (m[n] != null) return m[n];
  let best = 0;
  for (const k of Object.keys(m)) {
    const key = norm(k);
    if (!key) continue;
    if (n.indexOf(key) >= 0 || key.indexOf(n) >= 0) best = Math.max(best, m[k]);
  }
  return best;
}

/* 一组商品里最稀有的那个 → {name, rank}。都不认识就 {name:'', rank:0}。 */
function rarest(list) {
  let out = { name: '', rank: 0 };
  for (const it of (Array.isArray(list) ? list : [])) {
    const name = String((it && it.name) || it || '').trim();
    if (!name) continue;
    const r = of(name);
    if (r > out.rank) out = { name, rank: r };
  }
  return out;
}

function isRare(name) { return of(name) >= RARE_MIN; }

module.exports = { map, of, rarest, isRare, DEFAULTS, RARE_MIN };
