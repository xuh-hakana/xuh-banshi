'use strict';
/* 有上限的 Map：只加这一层，读法/命中/删法全不变，只是超过上限时淘汰最早插入的项。
 *
 * 以前这些缓存（成员资料、拉资料卡时间、禁言到期、上次发图时间……）都是裸 new Map()，
 * 只增不减：跑一天两天看不出来，跑一周就是几万到几十万条小对象。
 * 上限取得比正常群/私聊数量大一个量级，正常使用永远碰不到淘汰。
 */
function boundedMap(max, ttlMs) {
  const m = new Map();
  const limit = Math.max(16, Number(max) || 2000);
  const put = m.set.bind(m);
  m.set = function (k, v) {
    put(k, v);
    if (m.size > limit) {
      // 先清过期，再按插入顺序淘汰最老的
      if (ttlMs) {
        const now = Date.now();
        for (const [key, val] of m) {
          const at = val && typeof val === 'object' ? (val.t || val.at || 0) : 0;
          if (at && now - at > ttlMs) m.delete(key);
        }
      }
      while (m.size > limit) {
        const first = m.keys().next();
        if (first.done) break;
        m.delete(first.value);
      }
    }
    return m;
  };
  return m;
}

module.exports = { boundedMap };
