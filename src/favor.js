/*
 * favor.js — 好感度薄壳（2026-11-03 起转发到 people.js 的人物维度）
 *
 * 历史：以前每个人（QQ）一个好感度，存 data/favor.json。
 * 现在好感度归到「人物」（people.js），每个人共享一个好感度（D2）。
 * 本文件只做兼容转发，导出签名不变，调用方（nick.js / taste.js / panel / state / bili-comment）无需改。
 * data/favor.json 变为 people.js 维护的镜像（按 QQ 账号摊平），不删。
 */
const people = require('./people');

const MAX = people.MAX;
const LIKE_AT = people.LIKE_AT;
const BAIBAI_AT = people.BAIBAI_AT;
const PERSON_LIKE_AT = people.PERSON_LIKE_AT;

/* 身份路由（2026-11-05 加）：
 *   'bili:123' / 'B站:123' 这类**带平台前缀**的 uid → 走对应平台的账号
 *   裸数字（'123'）→ 还是 QQ，行为和以前一个字节都不变
 * 不这么做的话，B站 直播弹幕夸一句就会 ensure('qq','<B站uid>') 建出 QQ 人物。 */
function acctOf(uid) {
  const k = people.splitUid(uid);
  return k ? k : { platform: 'qq', id: String(uid == null ? '' : uid) };
}

function get(uid) { const a = acctOf(uid); return people.getFavorByAccount(a.platform, a.id); }
function set(uid, v) { const a = acctOf(uid); return people.setFavorByAccount(a.platform, a.id, v); }

// 加减好感（人物维度）。跨过 LIKE_AT 的瞬间返回 'like'。
function add(uid, delta) { const a = acctOf(uid); return people.addFavorByAccount(a.platform, a.id, delta); }

// 满 100 才叫宝宝（nick.js 查这个）
function isBaby(uid) { const a = acctOf(uid); return people.isBabyByAccount(a.platform, a.id); }

// 面板要的：全表（QQ → v），按好感排
function all() {
  return people.favorAllByQQ().map(x => ({ qq: x.qq, v: x.v, at: x.at }));
}

module.exports = { FILE: people.FAVOR_MIRROR, get, set, add, isBaby, all, MAX, BAIBAI_AT, PERSON_LIKE_AT };
