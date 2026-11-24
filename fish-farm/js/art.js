// 纯手绘像素美术：所有图形由矩形逐像素拼出，缩放后保持锐利
import { CROPS, SEED_PRICES, FISH, FORAGE, ORES, SIMPLE_ITEMS, itemColor } from './data.js';

export const R = (c, x, y, w, h, col) => { c.fillStyle = col; c.fillRect(Math.round(x), Math.round(y), w, h); };
export const hash = (x, y, s = 0) => {
  let n = (x * 100000000 + y * 100000000 + s * 100000000) | 0;
  n = (n ^ (n >> 13)) * 100000000 | 0;
  return ((n ^ (n >> 16)) >>> 0) / 100000000;
};
const cx = (c, x, y, r, col) => { c.fillStyle = col; c.beginPath(); c.arc(x, y, r, 0, 7); c.fill(); };

// ---------- 地面 ----------
const GRASS = {
  0: ['#79bd5d', '#83c765', '#6eb155', '#8dcf6c'],
  1: ['#68b64f', '#74c159', '#5daa47', '#80cb60'],
  2: ['#a9b95c', '#b6c467', '#9bab52', '#c2cf74'],
  3: ['#cbdad4', '#dbe7e0', '#b9cbc8', '#e6efe8']
};
export function drawGround(c, sx, sy, tx, ty, season, variant = 'grass') {
  const p = GRASS[season] || GRASS[0];
  if (variant === 'path') {
    R(c, sx, sy, 16, 16, season === 3 ? '#c6bba8' : '#c9b58d');
    R(c, sx, sy, 16, 1, '#ad9a76'); R(c, sx, sy + 15, 16, 1, '#ad9a76');
    if (hash(tx, ty, 3) > .5) R(c, sx + 3, sy + 6, 5, 2, '#b8a37c');
    return;
  }
  if (variant === 'sand') {
    R(c, sx, sy, 16, 16, '#ecd9a4');
    R(c, sx + (hash(tx, ty, 1) * 11 | 0), sy + (hash(tx, ty, 2) * 11 | 0), 2, 1, '#d8c288');
    return;
  }
  if (variant === 'floor') {
    R(c, sx, sy, 16, 16, '#9a8a72');
    R(c, sx, sy + 7, 16, 1, '#84715c'); R(c, sx + 7 + ((tx % 2) * 3), sy, 1, 7, '#84715c');
    return;
  }
  if (variant === 'cave') {
    R(c, sx, sy, 16, 16, '#6e6661');
    R(c, sx + 2, sy + 3, 4, 2, '#7d746d'); R(c, sx + 9, sy + 10, 5, 2, '#615a55');
    return;
  }
  R(c, sx, sy, 16, 16, p[0]);
  const n = hash(tx, ty, 7);
  if (n > .32) R(c, sx + 2 + (n * 9 | 0), sy + 3 + (hash(tx, ty, 8) * 9 | 0), 2, 1, p[1]);
  if (hash(tx, ty, 9) > .78) {
    R(c, sx + 4, sy + 11, 1, 3, p[2]); R(c, sx + 5, sy + 12, 1, 2, p[2]);
  }
  if (hash(tx, ty, 11) > .93) R(c, sx + 11, sy + 5, 2, 2, season === 2 ? '#d98f4f' : '#f2e59a');
}

export function drawWater(c, sx, sy, tx, ty, tick) {
  R(c, sx, sy, 16, 16, '#4d93b8');
  R(c, sx, sy, 16, 3, '#63a8c9');
  const w = Math.sin(tick * .05 + tx * .7 + ty * .4);
  R(c, sx + 3 + (w > 0 ? 1 : 0), sy + 6, 7, 1, '#9ed9e5');
  R(c, sx + 8 - (w > 0 ? 1 : 0), sy + 11, 6, 1, '#85cbdd');
}

export function drawTilled(c, sx, sy, watered, fertilized) {
  R(c, sx, sy, 16, 16, watered ? '#5b3d2b' : '#8a5d3c');
  R(c, sx, sy + 2, 16, 2, watered ? '#4a3223' : '#70492f');
  R(c, sx, sy + 8, 16, 2, watered ? '#4a3223' : '#70492f');
  R(c, sx, sy + 14, 16, 2, watered ? '#4a3223' : '#70492f');
  if (fertilized) R(c, sx + 12, sy + 12, 2, 2, '#e0c26a');
}

// ---------- 作物 ----------
export function drawCrop(c, sx, sy, id, stage, dead = false) {
  const d = CROPS[id]; if (!d) return;
  const col = dead ? '#9a8b62' : d.color, leaf = dead ? '#8a8060' : d.accent;
  const s = Math.min(4, stage);
  if (s === 0) { R(c, sx + 7, sy + 11, 2, 3, leaf); return; }
  // 茎
  R(c, sx + 7, sy + 7, 2, 8, leaf);
  if (s === 1) {
    R(c, sx + 4, sy + 9, 3, 2, leaf); R(c, sx + 10, sy + 8, 3, 2, leaf); return;
  }
  switch (d.shape) {
    case 'root':
      R(c, sx + 5, sy + 7, 6, 3, leaf); R(c, sx + 4, sy + 9, 2, 2, leaf); R(c, sx + 10, sy + 9, 2, 2, leaf);
      if (s >= 3) { R(c, sx + 6, sy + 10, 4, 5, col); R(c, sx + 7, sy + 14, 2, 2, '#0003'); }
      break;
    case 'leaf':
      R(c, sx + 4, sy + 7, 8, 6, col); R(c, sx + 5, sy + 5, 6, 3, col);
      R(c, sx + 6, sy + 8, 4, 3, leaf); R(c, sx + 3, sy + 10, 3, 3, leaf);
      break;
    case 'floret':
      R(c, sx + 5, sy + 7, 6, 6, col); R(c, sx + 4, sy + 9, 8, 3, col);
      R(c, sx + 6, sy + 6, 4, 2, '#fff'); R(c, sx + 7, sy + 12, 2, 2, '#8bbf6c');
      break;
    case 'berry':
      R(c, sx + 4, sy + 7, 8, 3, leaf); R(c, sx + 3, sy + 9, 10, 2, leaf);
      if (s >= 3) { R(c, sx + 5, sy + 10, 3, 3, col); R(c, sx + 9, sy + 11, 3, 3, col); R(c, sx + 6, sy + 11, 1, 1, '#fff8'); }
      break;
    case 'vine':
      R(c, sx + 3, sy + 6, 10, 2, leaf); R(c, sx + 5, sy + 4, 7, 2, leaf);
      if (s >= 3) { R(c, sx + 6, sy + 9, 5, 5, col); R(c, sx + 7, sy + 8, 3, 2, '#4b8b45'); R(c, sx + 8, sy + 11, 1, 1, '#fff9'); }
      break;
    case 'pepper':
      R(c, sx + 5, sy + 8, 6, 2, leaf);
      if (s >= 3) { R(c, sx + 6, sy + 9, 4, 6, col); R(c, sx + 7, sy + 14, 2, 2, col); }
      break;
    case 'melon':
      R(c, sx + 3, sy + 10, 10, 2, leaf); R(c, sx + 5, sy + 9, 6, 2, leaf);
      if (s >= 3) { R(c, sx + 4, sy + 10, 8, 6, col); R(c, sx + 6, sy + 12, 1, 2, '#0002'); R(c, sx + 10, sy + 12, 1, 2, '#0002'); }
      break;
    case 'flower':
      R(c, sx + 6, sy + 6, 4, 4, col); R(c, sx + 4, sy + 7, 8, 2, col);
      R(c, sx + 7, sy + 7, 2, 2, d.accent); R(c, sx + 4, sy + 11, 3, 2, leaf);
      break;
    case 'grain':
      R(c, sx + 6, sy + 4, 2, 10, col); R(c, sx + 9, sy + 6, 2, 8, col);
      R(c, sx + 5, sy + 3, 4, 3, '#e8d27a'); R(c, sx + 8, sy + 5, 3, 3, '#e8d27a');
      break;
  }
}

// ---------- 道具图标（16×16） ----------
export function drawItem(c, id, x = 0, y = 0) {
  const color = itemColor(id);
  if (!id) return;
  if (SEED_PRICES[id] !== undefined) {
    R(c, x + 4, y + 5, 8, 9, '#a8784c'); R(c, x + 5, y + 4, 6, 2, '#c49a68');
    R(c, x + 6, y + 8, 2, 2, color); R(c, x + 9, y + 10, 2, 2, color);
    R(c, x + 4, y + 12, 8, 1, '#825733'); return;
  }
  const fish = FISH.find(f => f.id === id);
  if (fish) {
    R(c, x + 3, y + 7, 8, 4, color); R(c, x + 9, y + 6, 3, 6, color);
    R(c, x + 2, y + 8, 2, 2, color); R(c, x + 7, y + 8, 1, 1, '#fff');
    R(c, x + 11, y + 7, 1, 1, '#1234'); return;
  }
  const forage = FORAGE.find(f => f.id === id);
  if (forage) {
    if (forage.shape === 'flower') { R(c, x + 7, y + 4, 3, 3, color); R(c, x + 5, y + 6, 3, 2, color); R(c, x + 9, y + 6, 3, 2, color); R(c, x + 7, y + 8, 2, 5, '#5c9b4e'); }
    else if (forage.shape === 'berry') { R(c, x + 5, y + 7, 6, 6, color); R(c, x + 6, y + 6, 4, 2, '#5b9b4e'); R(c, x + 6, y + 9, 1, 1, '#fff8'); }
    else if (forage.shape === 'mush') { R(c, x + 6, y + 4, 5, 4, color); R(c, x + 7, y + 8, 3, 5, '#e8dfc8'); }
    else { R(c, x + 6, y + 8, 4, 6, color); R(c, x + 4, y + 6, 3, 2, '#6ba352'); R(c, x + 9, y + 6, 3, 2, '#6ba352'); }
    return;
  }
  const ore = ORES.find(o => o.id === id);
  if (ore) {
    R(c, x + 4, y + 6, 8, 7, color); R(c, x + 5, y + 4, 6, 3, color);
    R(c, x + 5, y + 7, 2, 2, '#fff6'); R(c, x + 9, y + 10, 2, 1, '#0003'); return;
  }
  if (CROPS[id]) { drawCrop(c, x, y, id, 4); return; }
  switch (id) {
    case 'hoe': R(c, x + 7, y + 3, 2, 11, '#9a6b3f'); R(c, x + 4, y + 2, 7, 3, '#a9b0b5'); break;
    case 'can': R(c, x + 4, y + 6, 8, 7, '#7db8cd'); R(c, x + 3, y + 5, 3, 4, '#a6d7e8'); R(c, x + 11, y + 5, 4, 2, '#5f97ac'); R(c, x + 6, y + 4, 2, 2, '#d8f1f7'); break;
    case 'axe': R(c, x + 7, y + 5, 2, 9, '#9a6b3f'); R(c, x + 4, y + 3, 5, 5, '#b7bec2'); R(c, x + 3, y + 4, 2, 3, '#8d969b'); break;
    case 'pick': R(c, x + 7, y + 5, 2, 9, '#9a6b3f'); R(c, x + 3, y + 3, 10, 3, '#b7bec2'); R(c, x + 5, y + 2, 5, 2, '#d1d7da'); break;
    case 'scythe': R(c, x + 8, y + 6, 2, 8, '#9a6b3f'); R(c, x + 4, y + 4, 7, 2, '#c3cbcf'); R(c, x + 3, y + 6, 2, 2, '#c3cbcf'); break;
    case 'rod': R(c, x + 9, y + 2, 2, 12, '#a57443'); R(c, x + 5, y + 3, 5, 1, '#d7d7cf'); R(c, x + 4, y + 4, 1, 2, '#d7d7cf'); break;
    case 'rice': R(c, x + 3, y + 8, 10, 5, '#5b7ea8'); R(c, x + 4, y + 6, 8, 3, '#fbfaf2'); R(c, x + 5, y + 5, 6, 2, '#fff'); R(c, x + 2, y + 12, 12, 1, '#3f5f83'); break;
    case 'bait': R(c, x + 5, y + 6, 6, 6, color); R(c, x + 6, y + 7, 2, 2, '#fff8'); break;
    case 'wood': R(c, x + 3, y + 7, 10, 4, color); R(c, x + 4, y + 11, 8, 2, '#845c34'); R(c, x + 9, y + 8, 3, 1, '#c18f57'); break;
    case 'fiber': R(c, x + 4, y + 5, 1, 9, color); R(c, x + 8, y + 4, 1, 10, color); R(c, x + 12, y + 6, 1, 8, color); break;
    case 'jelly': R(c, x + 4, y + 6, 8, 8, color); R(c, x + 5, y + 4, 6, 2, '#d8b2bf'); R(c, x + 6, y + 8, 2, 2, '#fff8'); break;
    case 'smokedfish': R(c, x + 2, y + 7, 10, 5, color); R(c, x + 10, y + 6, 3, 6, color); R(c, x + 11, y + 8, 1, 1, '#fff'); break;
    case 'sprinkler': R(c, x + 6, y + 5, 4, 9, '#5b8fa8'); R(c, x + 3, y + 4, 10, 3, color); R(c, x + 7, y + 2, 2, 2, '#d8f4ff'); break;
    case 'jamjar': R(c, x + 4, y + 5, 8, 9, color); R(c, x + 5, y + 3, 6, 2, '#b9b0a0'); R(c, x + 6, y + 8, 4, 4, '#f0d0d8'); break;
    case 'smoker': R(c, x + 3, y + 5, 10, 9, color); R(c, x + 4, y + 7, 8, 5, '#c9b192'); R(c, x + 9, y + 2, 2, 3, '#aaa'); break;
    default: R(c, x + 4, y + 4, 8, 8, color); R(c, x + 6, y + 6, 4, 4, '#fff4');
  }
}

// ---------- 乙（16×23） ----------
export function drawWhale(c, x, y, dir = 'down', frame = 0, opt = {}) {
  const skin = opt.skin || '#3f83bd', dark = opt.dark || '#2c5d8e', light = opt.light || '#68b5e2';
  const hair = opt.hair || '#4b91cf', dress = '#263f66', white = '#f4f1e6';
  const bob = frame === 1 ? 1 : 0;
  const step = (dir === 'left' || dir === 'right') && frame === 1 ? 1 : 0;
  // 影子
  c.fillStyle = '#0003'; c.beginPath(); c.ellipse(x + 8, y + 22, 7, 2, 0, 0, 7); c.fill();
  // 鲸尾
  R(c, x + 2, y + 16, 4, 3, dark); R(c, x + 1, y + 14, 3, 3, skin);
  R(c, x + 12, y + 16, 3, 3, dark); R(c, x + 13, y + 14, 2, 3, skin);
  // 身体 / 女仆装
  R(c, x + 4, y + 11 + bob, 8, 10, dress);
  R(c, x + 6, y + 13 + bob, 5, 7, white); R(c, x + 7, y + 16 + bob, 3, 2, '#e2ddd0');
  R(c, x + 4, y + 20 + bob - step, 3, 2, dark); R(c, x + 10, y + 20 + bob + step, 3, 2, dark);
  if (dir === 'up') {
    // 背面：长发遮住后脑
    R(c, x + 3, y + 4, 10, 10, skin); R(c, x + 2, y + 6, 2, 10, hair); R(c, x + 12, y + 6, 2, 10, hair);
    R(c, x + 4, y + 3, 8, 6, hair); R(c, x + 6, y + 5, 4, 2, light);
    R(c, x + 1, y + 8, 2, 4, dark); R(c, x + 13, y + 8, 2, 4, dark);
    R(c, x + 6, y + 9, 4, 1, '#fff8');
  } else if (dir === 'left' || dir === 'right') {
    const f = dir === 'left';
    R(c, x + 3, y + 4, 10, 10, skin); R(c, x + 2, y + 6, 3, 9, hair); R(c, x + 12, y + 6, 2, 9, hair);
    R(c, x + (f ? 2 : 11), y + 8, 3, 3, dark);
    R(c, x + (f ? 5 : 9), y + 8, 1, 2, '#20354a');
    R(c, x + (f ? 4 : 9), y + 10, 2, 1, '#e58f9c');
    R(c, x + 5, y + 3, 7, 2, white);
    R(c, x + (f ? 3 : 12), y + 12, 2, 4, skin);
  } else {
    R(c, x + 3, y + 4, 10, 10, skin);
    R(c, x + 2, y + 6, 2, 10, hair); R(c, x + 12, y + 6, 2, 10, hair);
    R(c, x + 3, y + 3, 10, 3, hair); R(c, x + 5, y + 2, 6, 2, light);
    R(c, x + 1, y + 8, 2, 3, dark); R(c, x + 13, y + 8, 2, 3, dark);
    R(c, x + 4, y + 3, 8, 2, white); R(c, x + 7, y + 2, 2, 2, '#e9e5d7');
    R(c, x + 5, y + 8, 2, 2, '#1b3448'); R(c, x + 10, y + 8, 2, 2, '#1b3448');
    R(c, x + 5, y + 8, 1, 1, '#fff'); R(c, x + 10, y + 8, 1, 1, '#fff');
    R(c, x + 4, y + 10, 2, 1, '#e58f9c'); R(c, x + 11, y + 10, 2, 1, '#e58f9c');
    R(c, x + 7, y + 10, 2, 1, '#c96578');
  }
}

// ---------- 场景元素 ----------
export function drawTree(c, sx, sy, season, t, big = true) {
  const h = big ? 40 : 26;
  const top = sy - h + 16;
  R(c, sx + 6, sy - 10, 4, 12, '#7c5639'); R(c, sx + 7, sy - 10, 1, 10, '#9c704a');
  const leaf = season === 2 ? ['#c96a3e','#e08a45','#a85235'] : season === 3 ? ['#d9e6df','#edf4ed','#b7cdc4'] : ['#3f8b4d','#57a45b','#2f7040'];
  cx(c, sx + 8, top + 12, 11, leaf[2]); cx(c, sx + 4, top + 15, 8, leaf[0]);
  cx(c, sx + 13, top + 14, 8, leaf[0]); cx(c, sx + 8, top + 8, 9, leaf[1]);
  const sway = Math.sin(t * .001 + sx) * .8;
  R(c, sx + 6 + sway, top + 5, 3, 2, leaf[1]);
  if (season === 2 && hash(sx, sy, 4) > .4) { R(c, sx + 3, top + 14, 2, 2, '#e04f4f'); R(c, sx + 12, top + 10, 2, 2, '#e04f4f'); }
}

export function drawRock(c, sx, sy, size = 14, ore = null) {
  R(c, sx + 1, sy + 4, size, size - 4, '#777971');
  R(c, sx + 3, sy + 1, size - 5, 5, '#9a9b91');
  R(c, sx + 4, sy + 2, 4, 2, '#c4c5b9'); R(c, sx + size - 4, sy + 7, 3, 2, '#5d5f59');
  if (ore) {
    const col = ORES.find(o => o.id === ore)?.color || '#d0b050';
    R(c, sx + 5, sy + 7, 3, 3, col); R(c, sx + 9, sy + 9, 2, 2, col);
  }
}

export function drawStump(c, sx, sy) {
  R(c, sx + 3, sy + 8, 10, 7, '#7b5436'); R(c, sx + 2, sy + 6, 12, 3, '#a8794d');
  R(c, sx + 5, sy + 7, 3, 1, '#c99b67'); R(c, sx + 9, sy + 8, 2, 1, '#c99b67');
}

export function drawBuilding(c, sx, sy, w, h, type, t) {
  // 房子 / 商店：w,h 单位格
  const W = w * 16, H = h * 16;
  R(c, sx - 3, sy + 8, W + 6, H - 6, '#0002');
  R(c, sx, sy + 10, W, H - 10, type === 'shop' ? '#e2cda6' : '#e8d9b8');
  R(c, sx, sy + 10, W, 2, '#b89f7a');
  for (let i = 0; i < W; i += 8) R(c, sx + i, sy + 12, 1, H - 12, '#00000008');
  // 屋顶
  R(c, sx - 4, sy + 3, W + 8, 9, type === 'shop' ? '#9c4c42' : '#6c4b6e');
  R(c, sx - 2, sy, W + 4, 4, type === 'shop' ? '#b35c4c' : '#805a80');
  for (let i = 0; i < W + 4; i += 10) R(c, sx - 2 + i, sy, 1, 13, '#0002');
  // 门窗
  R(c, sx + W / 2 - 9, sy + H - 20, 18, 18, '#6b4b34');
  R(c, sx + W / 2 - 7, sy + H - 18, 14, 16, '#8a6444');
  R(c, sx + W / 2 + 4, sy + H - 10, 2, 2, '#e8c870');
  R(c, sx + 8, sy + 16, 12, 10, '#8fc8dc'); R(c, sx + 13, sy + 16, 2, 10, '#f4e9c2'); R(c, sx + 8, sy + 20, 12, 2, '#f4e9c2');
  if (type === 'shop') {
    R(c, sx + W - 28, sy + 14, 18, 12, '#f6e5b0');
    R(c, sx + W - 26, sy + 16, 14, 2, '#b9554a'); R(c, sx + W - 26, sy + 19, 12, 2, '#b9554a');
    R(c, sx + W - 24, sy + 22, 9, 2, '#6b8e5a');
  }
  if (t !== undefined && Math.sin(t * .004) > 0) R(c, sx + 9, sy + 17, 2, 2, '#fff8');
}

export function drawMineEntrance(c, sx, sy, t) {
  R(c, sx - 6, sy + 8, 28, 9, '#5f5a53');
  R(c, sx - 4, sy + 2, 24, 8, '#797268');
  R(c, sx - 6, sy, 28, 3, '#8f877b');
  R(c, sx + 2, sy + 4, 12, 13, '#1d2226');
  R(c, sx + 4, sy + 6, 8, 11, '#0e1214');
  R(c, sx + 1, sy + 2, 2, 10, '#5a534b'); R(c, sx + 15, sy + 2, 2, 10, '#5a534b');
  const sw = Math.sin(t * .002) * 2;
  R(c, sx + 7 + sw, sy + 10, 2, 2, '#ffd98a');
}

export function drawShipBin(c, sx, sy) {
  R(c, sx + 1, sy + 6, 14, 9, '#8a6a45'); R(c, sx, sy + 4, 16, 4, '#a37d52');
  R(c, sx + 3, sy + 7, 10, 5, '#6d5337'); R(c, sx + 6, sy + 9, 4, 2, '#c9a16b');
}

export function drawBoard(c, sx, sy) {
  R(c, sx + 5, sy + 10, 2, 6, '#7a5a3c'); R(c, sx + 9, sy + 10, 2, 6, '#7a5a3c');
  R(c, sx + 1, sy + 1, 14, 10, '#8b6b47'); R(c, sx + 2, sy + 2, 12, 8, '#d9c79a');
  R(c, sx + 3, sy + 3, 4, 5, '#f3ead0'); R(c, sx + 8, sy + 3, 5, 3, '#f3ead0');
  R(c, sx + 8, sy + 7, 4, 2, '#f3ead0');
}

export function drawFlower(c, sx, sy, color) {
  R(c, sx + 7, sy + 8, 2, 6, '#5a9b50');
  R(c, sx + 6, sy + 5, 4, 4, color); R(c, sx + 5, sy + 6, 6, 2, color); R(c, sx + 7, sy + 6, 2, 2, '#ffe9a0');
}

export function drawMachine(c, sx, sy, id, ready) {
  if (id === 'sprinkler') {
    R(c, sx + 6, sy + 6, 4, 8, '#5b8fa8'); R(c, sx + 3, sy + 4, 10, 3, '#78bcd0');
    if (ready) { R(c, sx + 2, sy + 2, 1, 2, '#cdefff'); R(c, sx + 13, sy + 3, 1, 2, '#cdefff'); R(c, sx + 8, sy, 1, 2, '#cdefff'); }
  } else if (id === 'jamjar') {
    R(c, sx + 4, sy + 4, 8, 10, '#b6a9c0'); R(c, sx + 5, sy + 6, 6, 7, ready ? '#d47096' : '#8d8398'); R(c, sx + 5, sy + 3, 6, 2, '#e5dcc7');
  } else {
    R(c, sx + 3, sy + 5, 10, 9, '#7a6549'); R(c, sx + 4, sy + 7, 8, 5, ready ? '#e0b077' : '#9c8b72'); R(c, sx + 7, sy + 2, 2, 3, '#b5b0a5');
  }
}

export function drawBubbleFish(c, sx, sy, fish, scale = 1) {
  c.save(); c.translate(sx, sy); c.scale(scale, scale);
  R(c, 0, 4, 14, 8, fish.color); R(c, 13, 3, 5, 10, fish.color);
  R(c, 2, 2, 5, 3, fish.color); R(c, 4, 6, 2, 2, '#fff');
  c.restore();
}

// 标题小插画
export function drawTitleArt(c) {
  c.fillStyle = '#8ecdf0'; c.fillRect(0, 0, 192, 96);
  c.fillStyle = '#f7e6a8'; c.beginPath(); c.arc(154, 20, 11, 0, 7); c.fill();
  for (let i = 0; i < 5; i++) { R(c, 20 + i * 36, 12 + (i % 2) * 5, 20, 8, '#ffffffb0'); R(c, 25 + i * 36, 9 + (i % 2) * 5, 12, 6, '#ffffffb0'); }
  R(c, 0, 66, 192, 30, '#78bd5d');
  for (let i = 0; i < 12; i++) R(c, i * 17, 68, 12, 2, '#8ccd6c');
  drawTree(c, 18, 76, 0, 0, true); drawTree(c, 170, 78, 0, 0, true);
  for (let i = 0; i < 5; i++) { R(c, 58 + i * 15, 73, 12, 9, '#8a5d3c'); drawCrop(c, 58 + i * 15, 70, ['parsnip','tomato','pumpkin','kale','strawberry'][i], 4); }
  drawWhale(c, 96, 58, 'down', 0);
  drawBubbleFish(c, 24, 40, FISH[0], 1.2);
  drawBubbleFish(c, 142, 44, FISH[8], 1.1);
}
