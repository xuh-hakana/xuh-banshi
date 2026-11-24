/*
 * region.js — 认地区（问天气时用）+ 地区表（按人物）
 *
 * 规则（主人 2026-10-20 定）：
 *   ① 问题里写了地区 → 用问题里的
 *   ② 没写 → 看地区表（按人物，一个人所有账号共用一份）
 *   ③ 地区表也没有 → 反问她住在哪里（不瞎猜）
 *
 * 地区表按「人物」对应（主人 2026-11-19 令：「我的地区表功能，需要能对应每个人…
 * 我现在有人物表功能了。对应上即可」）：data/people-region.json 的键现在存**人物ID**
 * （p_xxx）。老数据是裸 QQ 号，getRegion 会把这个人的所有键都试一遍，读到老键也算；
 * 下次 setRegion 写新键时顺手把老键挪走（一个人只留一条）。
 *
 * AI 记地区（2026-11-19，当晚主人纠正）：
 *   面板上有多细显示多细 —— learnFrom 认出的是**最细的原文**（如「西安市 未央区」），
 *   原样存进地区表，客户端人物卡照原样显示，汇报主人也报这条完整的。
 *   只有喂给 AI 时才降级 —— briefForAI(full) 把「西安市 未央区小寨路街道」砍到
 *   「西安市 未央区」（市/区级），街道门牌和图上那一大堆 OCR 原文都不进提示词。
 *   绝不把「精简」做在存储层，否则面板就看不到细节了。
 */
const fs = require('fs');
const path = require('path');
const { botWrite } = require('./wlog');
const people = require('./people');

// 直辖市 / 省会 / 主要地级市。只求认得出日常说法，不求全。
const CITIES = ('北京 上海 天津 重庆 成都 绵阳 乐山 宜宾 泸州 德阳 南充 达州 自贡 攀枝花 广元 遂宁 内江 眉山 广安 雅安 巴中 资阳 凉山 阿坝 甘孜 '
  + '广州 深圳 珠海 东莞 佛山 中山 惠州 汕头 江门 湛江 肇庆 清远 韶关 梅州 河源 阳江 茂名 揭阳 潮州 云浮 汕尾 '
  + '杭州 宁波 温州 嘉兴 湖州 绍兴 金华 台州 丽水 衢州 舟山 '
  + '南京 苏州 无锡 常州 南通 徐州 扬州 镇江 泰州 盐城 淮安 连云港 宿迁 '
  + '济南 青岛 烟台 潍坊 临沂 淄博 济宁 泰安 威海 日照 东营 聊城 德州 滨州 菏泽 枣庄 '
  + '福州 厦门 泉州 漳州 莆田 宁德 三明 南平 龙岩 '
  + '武汉 宜昌 襄阳 荆州 黄石 十堰 孝感 荆门 黄冈 咸宁 恩施 '
  + '长沙 株洲 湘潭 衡阳 岳阳 常德 郴州 邵阳 益阳 永州 怀化 娄底 张家界 湘西 '
  + '郑州 洛阳 开封 新乡 安阳 南阳 许昌 平顶山 焦作 信阳 商丘 周口 驻马店 三门峡 漯河 濮阳 鹤壁 济源 '
  + '石家庄 唐山 保定 廊坊 秦皇岛 邯郸 邢台 沧州 承德 张家口 衡水 '
  + '太原 大同 临汾 运城 长治 晋城 阳泉 晋中 忻州 吕梁 朔州 '
  + '西安 咸阳 宝鸡 渭南 汉中 榆林 延安 安康 商洛 铜川 '
  + '合肥 芜湖 蚌埠 安庆 阜阳 亳州 黄山 马鞍山 淮南 淮北 铜陵 宿州 滁州 六安 宣城 池州 '
  + '南昌 赣州 九江 上饶 宜春 吉安 抚州 景德镇 萍乡 新余 鹰潭 '
  + '昆明 大理 丽江 曲靖 玉溪 保山 昭通 普洱 临沧 楚雄 红河 '
  + '贵阳 遵义 六盘水 安顺 毕节 铜仁 黔东南 黔南 黔西南 '
  + '南宁 桂林 柳州 北海 玉林 梧州 钦州 贵港 百色 河池 贺州 来宾 崇左 '
  + '海口 三亚 儋州 琼海 '
  + '兰州 天水 白银 酒泉 张掖 武威 平凉 庆阳 定西 陇南 '
  + '银川 石嘴山 吴忠 固原 中卫 西宁 海东 '
  + '乌鲁木齐 喀什 伊宁 克拉玛依 库尔勒 阿克苏 石河子 拉萨 日喀则 林芝 '
  + '呼和浩特 包头 鄂尔多斯 赤峰 通辽 呼伦贝尔 乌兰察布 '
  + '沈阳 大连 鞍山 抚顺 本溪 丹东 锦州 营口 阜新 辽阳 盘锦 铁岭 朝阳 葫芦岛 '
  + '长春 吉林 四平 通化 白山 松原 白城 延吉 '
  + '哈尔滨 齐齐哈尔 大庆 牡丹江 佳木斯 鸡西 双鸭山 伊春 七台河 鹤岗 绥化 黑河 '
  + '台北 高雄 台中 台南 新北 桃园 新竹 基隆 香港 澳门').split(/\s+/).filter(Boolean);

const PROVS = '河北 山西 辽宁 吉林 黑龙江 江苏 浙江 安徽 福建 江西 山东 河南 湖北 湖南 广东 海南 四川 贵州 云南 陕西 甘肃 青海 台湾 内蒙古 广西 西藏 宁夏 新疆'.split(/\s+/);

const CITY_SET = new Set(CITIES);
const PROV_SET = new Set(PROVS);

// 从一句话里找地区。城市优先于省（「四川 成都」→ 成都）
function detectCity(text) {
  const t = String(text || '');
  if (!t) return '';
  let best = '';
  for (const n of CITY_SET) if (t.includes(n) && n.length > best.length) best = n;
  if (best) return best;
  for (const n of PROV_SET) if (t.includes(n) && n.length > best.length) best = n;
  if (best) return best;
  // 「XX市 / XX省 / XX区 / XX县」兜底，排除疑问词误判
  const m = t.match(/([\u4e00-\u9fa5]{2,5}?)(?:市|省|区|县)/);
  if (m && !/什么|哪个|哪一|这个|那个|今天|明天|昨天|外地|地区/.test(m[1])) return m[1];
  return '';
}

// 解析资料卡里的地区字段（可能是「四川 成都」「四川·成都」「成都市」「四川」）
function parseArea(raw) {
  const s = String(raw || '').replace(/[·,，、/\\|\-_]/g, ' ').trim();
  if (!s) return '';
  return detectCity(s);
}

// ===== 地区登记表（按人物） =====
// 现实情况：NapCat 4.18 的 get_stranger_info / get_group_member_info 已拿不到 city（腾讯不返回了），
// 群成员列表里 area 也全是空。所以真正可靠的来源是这张表 + 聊天里自己说的话。
let FILE = path.join(__dirname, 'data', 'people-region.json');
function _setFile(p) { FILE = p; }   // 测试用：指到临时文件，绝不碰线上数据

function loadAll() { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')) || {}; } catch { return {}; } }

/* 传进来的号（裸 QQ / platform:id / 人物ID）→ 属于哪个人物 */
function pidOf(uid) {
  const s = String(uid == null ? '' : uid).trim();
  if (!s) return '';
  if (/^p_/.test(s) && people.get(s)) return s;   // 已经是人物ID
  return people.pidOfKey(s) || '';
}

/* 落盘键：优先人物ID（一个人所有账号共用一份地区）；没建档的按 platform:id 存 */
function keyFor(uid) {
  const pid = pidOf(uid);
  if (pid) return pid;
  return people.keyOf(uid) || String(uid == null ? '' : uid).trim();
}

/* 这个人所有「可能存过地区的键」——老数据是裸 QQ 号，新数据是人物ID。
 * 读取时全试一遍，写新键时把其它键挪走（一个人只留一条）。 */
function allKeys(uid) {
  const s = String(uid == null ? '' : uid).trim();
  const out = [];
  const add = k => { k = String(k == null ? '' : k).trim(); if (k && out.indexOf(k) < 0) out.push(k); };
  add(keyFor(uid));
  const pid = pidOf(uid);
  if (pid) {
    add(pid);
    for (const a of people.accountsOf(pid)) { add(a.id); add(a.platform + ':' + a.id); }
  } else {
    add(s);
    add(people.keyOf(s));
    const sp = people.splitUid(s);
    if (sp) add(sp.id);
  }
  return out;
}

function getRegion(uid) {
  return getFrom(loadAll(), uid);
}

/* 整表一次读出（core 生成「你认得的人」时批量查，避免每人读一次文件） */
function all() { return loadAll(); }
function getFrom(t, uid) {
  for (const k of allKeys(uid)) if (t[k]) return t[k];
  return '';
}

/* 写地区。返回 {changed, city, prev, key}：
 * changed=false = 这个人本来就记着同一个城市（主人 2026-11-19：没变化就不记，不记就不汇报）。 */
function setRegion(uid, city) {
  const key = keyFor(uid);
  const c = String(city == null ? '' : city).trim();
  if (!key || !c) return { changed: false, city: c, key, prev: '' };
  const t = loadAll();
  const prev = getRegion(uid);
  if (prev === c) return { changed: false, city: c, key, prev };
  for (const k of allKeys(uid)) if (k !== key) delete t[k];   // 老键挪走，一个人一条
  t[key] = c;
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(t, null, 1), 'utf8');
    botWrite('data/people-region.json', '地区', key + ' 在 ' + c);
    console.log(`[region] 记住 ${key} 在 ${c}`);
    return { changed: true, city: c, prev, key };
  } catch (e) {
    console.error('[region] 登记失败', e.message);
    return { changed: false, city: c, key, prev };
  }
}

function clearRegion(uid) {
  const t = loadAll();
  const keys = allKeys(uid);
  let hit = false;
  for (const k of keys) if (t[k]) { delete t[k]; hit = true; }
  if (!hit) return false;
  try {
    fs.writeFileSync(FILE, JSON.stringify(t, null, 1), 'utf8');
    botWrite('data/people-region.json', '删地区', keyFor(uid));
    return true;
  } catch (e) { console.error('[region] 删除失败', e.message); return false; }
}

/* 从聊天 / 图上认地区 —— 返回**最细的原文**，原样存、原样给面板看。
 * ① 自称：「我在成都」「我住西安市未央区」「坐标杭州」
 * ② 带标签的字（对方发的图上 OCR 出来的也算）：「登陆地点：西安市 未央区」
 *    「IP属地：四川」「所在地：成都」「位置：北京」。
 * 不做「只留城市名」的压缩——那是喂 AI 时才做的事（见 briefForAI）。 */
const SELF_M = /(?:我(?:在|人在|住(?:在)?|家(?:在)?|这边(?:是)?|这儿(?:是)?|这里是|这边)|坐标|本人(?:在)?)[，,、\s]*([^\/|；;\n\r]{2,32})/;
const AREA_LABEL = /(?:登陆地点|登录地点|登陆地|登录地|IP属地|ip属地|Ip属地|所在地|所在地区|现居地|居住地|常住地|属地|位置|坐标)[：:\s]{0,4}([^\/|；;\n\r]{2,40})/;

/* 把截到的地区串洗干净：去掉后面的字段标签 / 分隔符 / 语气词，市区之间的空格留着。
 * 「西安市 未央区 / 情绪：委屈」→「西安市 未央区」；「成都啊」→「成都」。 */
function _cleanArea(s) {
  return String(s == null ? '' : s)
    .split(/(?:情绪|是什么|字[：:]|【|\[)/)[0]
    .replace(/[\/|]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^(?:在|住在|位于|是|这边是|这里是)+/, '')
    .replace(/[啊呀呢吧哦噢嘛哈]+$/, '')
    .trim();
}

/* 认得出是真地区才算（别把「登陆地点：暂无」这种收进来） */
function _validArea(s) {
  if (!s) return false;
  return !!detectCity(s) || /[\u4e00-\u9fa5]{2,8}(?:市|省|区|县|州)/.test(s);
}

function learnFrom(text) {
  const t = String(text == null ? '' : text);
  if (!t) return '';
  // 带标签的先认（图上「登陆地点：西安市 未央区」这种最明确）
  const lab = t.match(AREA_LABEL);
  if (lab) {
    const area = _cleanArea(lab[1]);
    if (_validArea(area)) return area;      // 最细原文，不砍成城市名
  }
  // 自称
  const m = t.match(SELF_M);
  if (!m) return '';
  const area = _cleanArea(m[1]);
  return _validArea(area) ? area : '';
}

/* 喂给 AI 的精简版（2026-11-19 主人令：「面板上有多细显示多细，仅仅不给 ai 喂，
 * 只喂到市级或区级」）：保留原文写法，从城市出现处一直截到第一个「区/县」为止，
 * 后面的街道、门牌、一大堆 OCR 原文全丢。认不出城市就只截一小段兜底。
 *   「西安市 未央区小寨路街道」→「西安市 未央区」
 *   「成都武侯区」→「成都武侯区」   「西安」→「西安」   「四川」→「四川」 */
function briefForAI(full) {
  const s = String(full == null ? '' : full).trim();
  if (!s) return '';
  const city = detectCity(s);
  if (!city) return s.slice(0, 24);
  const i = s.indexOf(city);
  const dm = s.slice(i).match(/[\u4e00-\u9fa5]{2,8}?(?:区|县)/);
  if (dm) return s.slice(0, i + dm.index + dm[0].length).trim();
  return city;
}

module.exports = {
  detectCity, parseArea, getRegion, setRegion, clearRegion, learnFrom, briefForAI, all,
  keyFor, pidOf, allKeys, CITIES, PROVS, FILE,
  _setFile,
};
