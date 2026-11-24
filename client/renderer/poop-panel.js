'use strict';
/* app/renderer/poop-panel.js — 搬屎页（只读）：状态 / 冷却 / 最近消息。
 * 数据来自主进程 xuh:poop（复用 client/poop-data.js，和公开客户端同一份实现）。
 * 这个文件不读文件、不写配置，也不碰转发逻辑。 */
(function () {
  function esc(s) {
    if (typeof window.esc === "function") return window.esc(s);
    return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" }[c];
    });
  }

  function cell(label, value) {
    return '<div class="poop-cell"><b>' + esc(value) + '</b><span>' + esc(label) + "</span></div>";
  }

  function html(S) {
    var d = S.poop || {};
    if (d.error) {
      return '<div class="poop-wrap"><div class="poop-card"><h3>读不到搬屎状态</h3>'
        + '<p class="poop-sub">' + esc(d.error) + "</p>"
        + '<button class="btn" data-act="poop-refresh" type="button">再读一次</button></div></div>';
    }
    var cfg = d.cfg || {};
    var q = d.quality || {};
    var on = !!cfg.enabled;
    var parts = [];
    parts.push('<div class="poop-wrap">');
    parts.push('<div class="poop-head"><h2>搬屎</h2>'
      + '<span class="poop-badge ' + (on ? "is-on" : "") + '">' + (on ? "开着" : "关着") + "</span>"
      + '<button class="btn" data-act="poop-refresh" type="button">刷新</button></div>');
    parts.push('<p class="poop-sub">' + (on ? "源群有新内容就会搬到目标群；同样的内容不会搬第二次。" : "关着的时候一条都不会转发。") + "</p>");

    parts.push('<div class="poop-card"><h3>现在的状态</h3><div class="poop-grid">');
    parts.push(cell("已记录（不重复搬的条数）", d.total || 0));
    parts.push(cell("源群", (cfg.sourceGroups || []).length));
    parts.push(cell("目标群", (cfg.targetGroups || []).length));
    parts.push(cell("模式", cfg.mode === "emoji" ? "emoji（等表情投票）" : "plain（收到就搬）"));
    parts.push(cell("轮询间隔", (cfg.pollSeconds || 0) + " 秒"));
    parts.push(cell("重复判定", q.enabled ? "开" : "关"));
    parts.push("</div></div>");

    parts.push('<div class="poop-card"><h3>冷却</h3>');
    parts.push('<p class="poop-sub">目标群太安静的时候用这两条，避免一次性刷屏；填 0 就是不限。</p>');
    parts.push('<div class="poop-grid">');
    parts.push(cell("白天冷却", (cfg.cooldownDaySeconds || 0) + " 秒（" + (cfg.cooldownDayStart || "--:--") + " 起）"));
    parts.push(cell("夜间冷却", (cfg.cooldownNightSeconds || 0) + " 秒（" + (cfg.cooldownNightStart || "--:--") + " 起）"));
    parts.push(cell("每批查表情", (cfg.batchSize || 0) + " 条"));
    parts.push(cell("好评门槛", cfg.minGoodMinusBad || 0));
    parts.push("</div></div>");

    parts.push('<div class="poop-card"><h3>最近记下的消息</h3>');
    var list = d.recent || [];
    if (!list.length) {
      parts.push('<p class="poop-empty">还没有记录。把源群、目标群填好、把搬屎打开，第一条进来这里就有了。</p>');
    } else {
      parts.push('<table class="poop-table"><thead><tr><th>时间</th><th>群</th><th>消息 id</th></tr></thead><tbody>');
      list.forEach(function (r) {
        parts.push("<tr><td>" + esc(r.when || "—") + "</td><td>" + esc(r.group || "—")
          + "</td><td class='poop-id'>" + esc(String(r.id || "").slice(0, 18)) + "</td></tr>");
      });
      parts.push("</tbody></table>");
    }
    parts.push("</div>");

    /* 群统计：和面板、公开客户端、日报读同一份（src/poop-stats.js），这里只负责显示 */
    var fw = d.forwarded || {};
    var qq = d.queue || {};
    parts.push('<div class="poop-card"><h3>群统计</h3>');
    parts.push('<p class="poop-sub">面板、客户端、日报读的是同一份统计，这里的数和别处一致。</p>');
    parts.push('<div class="poop-grid">');
    parts.push(cell("近 1 小时待搬", qq.total || 0));
    parts.push(cell("今日搬成功", fw.today || 0));
    parts.push(cell("累计搬成功", fw.total || 0));
    parts.push(cell("涉及群数", Object.keys(fw.byGroup || {}).length));
    parts.push("</div>");
    /* 待搬按来源群、今日搬成功按目标群，两个口径分开列，不混在一张表 */
    var qRows = qq.byGroup || [];
    parts.push('<p class="poop-sub">近 1 小时待搬（按来源群）</p>');
    if (!qRows.length) {
      parts.push('<p class="poop-empty">还没有待搬的消息。</p>');
    } else {
      parts.push('<table class="poop-table"><thead><tr><th>群</th><th>条数</th><th>最久等了</th></tr></thead><tbody>');
      qRows.forEach(function (x) {
        parts.push("<tr><td>" + esc(x.groupId || "—") + "</td><td>" + (x.count || 0)
          + "</td><td>" + (x.oldestSec != null ? x.oldestSec : 0) + " 秒</td></tr>");
      });
      parts.push("</tbody></table>");
    }
    var fRows = Object.keys(fw.todayByGroup || {});
    parts.push('<p class="poop-sub">今日搬成功（按目标群）</p>');
    if (!fRows.length) {
      parts.push('<p class="poop-empty">今天还没搬成功过。</p>');
    } else {
      parts.push('<table class="poop-table"><thead><tr><th>群</th><th>今日</th><th>累计</th></tr></thead><tbody>');
      fRows.forEach(function (g) {
        parts.push("<tr><td>" + esc(g) + "</td><td>" + (fw.todayByGroup[g] || 0)
          + "</td><td>" + ((fw.byGroup || {})[g] || 0) + "</td></tr>");
      });
      parts.push("</tbody></table>");
    }
    parts.push("</div>");

    if (d.cacheFile) parts.push('<p class="poop-foot">缓存文件：' + esc(d.cacheFile) + "</p>");
    parts.push('<p class="poop-foot">这里只读；要改开关和群号，去机器人页的开关面板。</p>');
    parts.push("</div>");
    return parts.join("");
  }

  function bind(root) {
    if (!root || root.__poopBound) return;
    root.__poopBound = true;
    root.addEventListener("click", function (e) {
      var b = e.target.closest ? e.target.closest('[data-act="poop-refresh"]') : null;
      if (!b) return;
      e.preventDefault();
      load(true);
    });
  }

  function load(force) {
    if (!window.xuh || !window.xuh.poop) {
      S.poop = { loaded: true, error: "客户端没有开放这个接口（xuh:poop），重启一下客户端" };
      if (typeof render === "function") render();
      return;
    }
    if (force) { S.poop = null; if (typeof render === "function") render(); }
    window.xuh.poop().then(function (d) {
      if (d && d.error) S.poop = { loaded: true, error: d.error };
      else { d = d || {}; d.loaded = true; S.poop = d; }
      if (typeof render === "function") render();
    }).catch(function (e) {
      S.poop = { loaded: true, error: (e && e.message) || String(e) };
      if (typeof render === "function") render();
    });
  }

  window.PoopPanel = { html: html, bind: bind, load: load };
})();
