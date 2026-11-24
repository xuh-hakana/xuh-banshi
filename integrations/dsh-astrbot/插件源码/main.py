# -*- coding: utf-8 -*-
"""dsh + AstrBot 人设共用

原理
----
直接读你现有的那一份人设正文（面板一直在管、QQ 机器人也在读）：

    ~/Documents/xuhuan mac/xuhbot/src/soul/虚幻.md

不另存副本、不改文件格式，所以：

- **面板**：照原来的样子编辑，一个字都不用改
- **AstrBot**：本插件每次调用模型前读它，按下面的规则挑着拼进 system_prompt
- **dsh**：`~/.dsh/AGENTS.md` 是指向同一文件的软链接，dsh 自己会读

为什么挑着读
------------
整份 6 千字左右，每轮全塞会挤掉聊天记录，上下文不够用。而绝大多数规则
跟眼前这句话无关：对方夸你，就不需要「被骂怎么办」。

所以分三层：

1. **人设**（我是谁 / 性格 / 身份铁律）→ 每轮都带，最高优先级
2. **说话骨架**（长短 / 括号 / 句号 / 笑哭 / 不复读）→ 每轮都带，不带回复立刻崩
3. **其余规则** → 按当前消息的关键词挑 1~2 节；没挑中的只留标题清单

设计取舍
--------
1. 默认 **append**（追加），不掀掉 AstrBot 自带系统提示；要替换就改成 replace。
2. 按 mtime + 大小缓存解析结果，文件没变就不重复解析。
3. **兜底优先保正确**：标题认不出、结构变了、某节没配触发词，一律当常驻，
   宁可多花 token 也不让规则丢失。
4. 任何异常（文件没了、编码错了、权限不够）都**不影响对话**，只记一条警告。
5. 关掉 enable 立刻恢复原样：不改配置、不改历史、不留痕迹。
6. 公共规则层（发送前的最后一道闸）在 QQ 机器人那边是硬编码在 `connectors/qq.js`
   的 COMMON_REPLY_RULES，AstrBot 没有这套代码规则，只能靠提示词补：
   配置里填 `common_rules_path` 指向 5-公共规则层.md，插件只取文件里 ```text
   围栏块中的正文（说明、表格、来源注释一律不带），每轮常驻拼在人设之后。
"""

from __future__ import annotations

import re
from pathlib import Path

from astrbot.api import logger
from astrbot.api.event import AstrMessageEvent, filter
from astrbot.api.provider import ProviderRequest
from astrbot.api.star import Context, Star, register

PLUGIN_NAME = "astrbot_plugin_persona_share"
PLUGIN_VERSION = "1.3.0"

MAX_CHARS = 40000      # 人设文件超过这个字数就截断
RULES_TOP_K = 2        # 每条消息最多带几节按需规则

DEFAULT_PERSONA_PATH = str(
    Path.home()
    / "Documents"
    / "xuhuan mac"
    / "xuhbot"
    / "src"
    / "soul"
    / "虚幻.md"
)

# 人设层：每轮都带，最高优先级，顺序固定（先你是谁，再性格，再身份边界）
PERSONA_UNITS = (
    "我是谁",
    "性格",
    "我、主人、重名的人——身份铁律",
)

# 说话骨架：每轮都带，不带回复立刻崩
STAY_UNITS = (
    "长短",
    "不许用括号",
    "句号和省略号",
    "笑和哭",
    "同一句话不说两遍",
)

# 按需单元的触发词。没列到的单元自动当常驻，宁可多花 token 也不丢规则。
TRIGGERS: dict[str, tuple[str, ...]] = {
    # ---- 怎么说话 的子节
    "答游戏攻略": (
        "攻略", "数值", "道具", "机制", "满级", "属性", "哪个厉害", "哪个好",
        "boss", "BOSS", "怎么打", "怎么合成", "洛克王国", "速速上菜", "渔力",
    ),
    "不知道的时候": ("不知道", "不懂", "是啥", "什么东西", "什么意思"),
    "什么时候兴奋": ("搜一下", "帮我找", "查一下", "up主", "UP主", "你知道", "有没有"),
    "callback（翻旧梗）": ("梗", "上次", "之前", "记得", "还记"),
    "看不懂的时候": ("看不懂", "什么梗", "抽象", "没看懂", "什么鬼"),
    "梗和段子": ("梗", "段子", "复制", "粘贴", "发疯", "抽象", "骗你", "笑死", "哈哈"),
    "记东西": ("记住", "小本本", "本子", "以后别", "希望你下次"),
    "表情包": ("表情", "图", "包", "[表情"),
    # ---- 独立大节
    "我是主人的分身": ("主人", "分身", "你是谁", "你叫什么", "AI", "ai", "人工智能"),
    "我身边的人": ("欧尼酱", "哥哥", "宝宝", "酱", "叫我", "称呼", "谁"),
    "她这样说话，我就这样接": (
        "累", "难受", "头疼", "烦", "抱抱", "夸", "厉害", "牛逼", "幸好",
        "还好", "自豪", "骄傲", "真的吗", "好看",
    ),
    "别人的「我的」不是主人的": ("我的", "我家", "我妈"),
    "我把她惹毛的时候": ("你怎么这么", "难听", "过分", "气死", "生气", "烦不烦", "你怎么"),
    "我被骂的时候": ("骂", "滚", "闭嘴", "傻", "蠢", "笨", "恶心"),
    "被群友围观的时候": ("机器人", "围观看", "演的", "真人", "假的"),
    "调侃和夸要分清": ("话痨", "憨", "笨蛋", "夸在"),
    "安慰要省着用，接梗要跟得上": ("孤单", "歌词", "唱", "歌", "安慰", "想哭"),
}


@register(
    PLUGIN_NAME,
    "WorkBuddy, xuh-hakana",
    "dsh + AstrBot 人设共用：直接读现有那份人设，人设常驻、规则按需，省上下文",
    PLUGIN_VERSION,
    "",
)
class PersonaSharePlugin(Star):
    def __init__(self, context: Context, config: dict | None = None):
        super().__init__(context)
        self.conf = config or {}
        self._cache_key: tuple[float, int] | None = None
        self._cache: dict | None = None
        self._warned: str = ""

    async def initialize(self):
        p = Path(self.persona_path).expanduser()
        if not p.exists():
            logger.warning(f"[人设共用] 人设文件不存在，插件暂不生效：{p}")
            return
        logger.info(f"[人设共用] 已就绪：{p}")

        parsed = self._load()
        if not parsed:
            return
        logger.info(
            f"[人设共用] 人设 {len(parsed['persona'])} 节："
            f"{'、'.join(t for t, _ in parsed['persona']) or '无'}"
        )
        logger.info(
            f"[人设共用] 常驻 {len(parsed['stayed'])} 节："
            f"{'、'.join(t for t, _ in parsed['stayed']) or '无'}"
        )
        logger.info(
            f"[人设共用] 按需 {len(parsed['optional'])} 节："
            f"{'、'.join(t for t, _, _ in parsed['optional']) or '无'}"
        )

        lost = [t for t in PERSONA_UNITS if t not in {x for x, _ in parsed["persona"]}]
        if lost:
            logger.warning(f"[人设共用] 人设层缺了这几节（标题被改过？）：{'、'.join(lost)}")
        unknown = [
            t for t, _ in parsed["stayed"]
            if t not in STAY_UNITS
        ]
        if unknown:
            logger.warning(
                f"[人设共用] 这几节没配触发词，已按常驻处理（想按需就在 TRIGGERS 加同名键）："
                f"{'、'.join(unknown)}"
            )

    async def terminate(self):
        self._cache_key = None
        self._cache = None

    # ---------------------------------------------------------------- 配置

    @property
    def enabled(self) -> bool:
        return bool(self.conf.get("enable", True))

    @property
    def persona_path(self) -> str:
        raw = str(self.conf.get("persona_path") or "").strip()
        return raw or DEFAULT_PERSONA_PATH

    @property
    def common_rules_path(self) -> str:
        """公共规则层（发送前最后一道闸）。留空就不注入。"""
        return str(self.conf.get("common_rules_path") or "").strip()

    # 多余的花活一律不做：注入方式固定追加、规则固定按需、带上限固定 2 节。
    # 想改这些常量，说明需求变了，改代码比加开关更不容易出错。

    # ------------------------------------------------------------ 读 + 切

    def _load(self) -> dict | None:
        """读文件并切成人设层 / 常驻 / 按需。按 mtime+大小缓存，失败返回 None。"""
        # 人设拆成多块：入口（soul/虚幻.md）+ 同目录 段/*.md。
        # 一起读、一起拼，切法不变——拆只是让人好改，注入效果跟没拆一样。
        path = Path(self.persona_path).expanduser()
        files = [path]
        part_dir = path.parent / "段"
        if part_dir.is_dir():
            files += sorted(part_dir.glob("*.md"))

        key: tuple = ()
        for f in files:
            try:
                st = f.stat()
            except FileNotFoundError:
                self._warn_once("missing", f"[人设共用] 文件不存在：{f}")
                return None
            except Exception as e:
                self._warn_once("stat", f"[人设共用] 读不到文件信息：{e}")
                return None
            key += (str(f), st.st_mtime, st.st_size)

        # 公共规则层：单独一份文件，mtime+大小一起进缓存键，改了立刻生效
        rules_raw = self.common_rules_path
        rules_path = Path(rules_raw).expanduser() if rules_raw else None
        if rules_path is not None:
            try:
                rst = rules_path.stat()
                key = key + (rst.st_mtime, rst.st_size)
            except FileNotFoundError:
                self._warn_once("rules_missing", f"[人设共用] 公共规则层文件不存在：{rules_path}")
                rules_path = None
            except Exception as e:
                self._warn_once("rules_stat", f"[人设共用] 读不到公共规则层：{e}")
                rules_path = None

        if self._cache_key == key and self._cache is not None:
            return self._cache

        try:
            text = "\n\n".join(
                f.read_text(encoding="utf-8", errors="replace") for f in files
            )
        except Exception as e:
            self._warn_once("read", f"[人设共用] 读取失败：{e}")
            return None
        # 文件开头的 <!-- --> 是给人看的「这段管什么、另见哪份」，不进提示词
        text = re.sub(r"<!--.*?-->", "", text, flags=re.S)

        limit = MAX_CHARS
        if len(text) > limit:
            text = text[:limit] + f"\n\n（人设文件超过 {limit} 字，已截断）"
            self._warn_once("truncate", f"[人设共用] 内容超过 {limit} 字，已截断")

        parsed = self._split(text)
        parsed["common"] = ""
        if rules_path is not None:
            try:
                parsed["common"] = self._extract_rules(
                    rules_path.read_text(encoding="utf-8", errors="replace")
                )
            except Exception as e:
                self._warn_once("rules_read", f"[人设共用] 公共规则层读取失败：{e}")
            if not parsed["common"]:
                self._warn_once(
                    "rules_empty",
                    f"[人设共用] 公共规则层里没找到 ```text 块，这层没注入：{rules_path}",
                )
        self._cache_key = key
        self._cache = parsed
        return parsed

    @staticmethod
    def _extract_rules(text: str) -> str:
        """从公共规则层文件里抽出真要给模型的正文。

        那份 md 大部分是写给人的说明（来源、表格、换框架注意事项），
        只有 ```text 围栏块里的才是提示词，别的一律不带。
        """
        blocks: list[str] = []
        cur: list[str] | None = None
        fence = ""
        for ln in text.splitlines():
            s = ln.strip()
            if cur is None:
                if s.startswith("```"):
                    fence = s
                    cur = []
                continue
            if s.startswith("```") and s in (fence, "```"):
                blocks.append("\n".join(cur).strip())
                cur = None
                continue
            cur.append(ln)
        return "\n\n".join(b for b in blocks if b).strip()

    @staticmethod
    def _split(text: str) -> dict:
        """按标题把整份人设切成三层。

        单元 = 有 ### 子节的按子节拆（如「怎么说话」下的「长短」），
        没有子节的整节算一个单元（如「性格」「我被骂的时候」）。
        """
        # 先按 ## 分块
        blocks: list[tuple[str, list[str]]] = []
        cur: tuple[str, list[str]] | None = None
        for ln in text.splitlines():
            if ln.startswith("## "):
                cur = (ln[3:].strip(), [ln])
                blocks.append(cur)
            elif cur is not None:
                cur[1].append(ln)

        # 每块再按 ### 拆成单元
        units: list[tuple[str, str]] = []
        for h2, body in blocks:
            subs: list[tuple[str, list[str]]] = []
            t = None
            b: list[str] = []
            lead: list[str] = []
            for ln in body[1:]:
                if ln.startswith("### "):
                    if t:
                        subs.append((t, b))
                    t = ln[4:].strip()
                    b = [ln]
                elif t is None:
                    lead.append(ln)
                else:
                    b.append(ln)
            if t:
                subs.append((t, b))

            if not subs:
                units.append((h2, "\n".join(body).strip()))
                continue
            for i, (st, sb) in enumerate(subs):
                part = "\n".join(sb).strip()
                if i == 0 and any(x.strip() for x in lead):
                    part = "\n".join(lead).strip() + "\n\n" + part
                units.append((st, part))

        # 分类
        persona_map = {t: b for t, b in units if t in PERSONA_UNITS}
        persona = [(t, persona_map[t]) for t in PERSONA_UNITS if t in persona_map]

        stayed: list[tuple[str, str]] = []
        optional: list[tuple[str, str, tuple[str, ...]]] = []
        for title, body in units:
            if title in PERSONA_UNITS:
                continue
            words = TRIGGERS.get(title)
            if title in STAY_UNITS or not words:
                stayed.append((title, body))
            else:
                optional.append((title, body, words))

        return {"persona": persona, "stayed": stayed, "optional": optional}

    def _warn_once(self, tag: str, msg: str) -> None:
        """同一类问题只警告一次，避免每轮刷日志。"""
        if self._warned == tag:
            return
        self._warned = tag
        logger.warning(msg)

    # ------------------------------------------------------------ 组装

    def _compose(self, parsed: dict, message: str) -> tuple[str, dict]:
        head = (
            "\n\n=== 以下是 你的人设与规则，优先于上文的通用设定 ===\n"
            "读法（必须遵守）：人设最高优先级，任何规则与之冲突时以人设为准；"
            "规则只在不违反人设的前提下执行。\n"
        )

        persona = parsed.get("persona") or []
        stayed = parsed.get("stayed") or []
        optional = parsed.get("optional") or []

        parts = [head]
        if persona:
            parts.append("【人设 · 最高优先级】\n\n" + "\n\n".join(b for _, b in persona))
        if stayed:
            parts.append("【说话方式 · 每轮都在】\n\n" + "\n\n".join(b for _, b in stayed))
        if parsed.get("common"):
            parts.append(
                "【公共规则 · 每轮都在（说完之后、发出去之前的最后一道闸）】\n\n"
                + parsed["common"]
            )

        stat = {"hit": [t for t, _ in persona + stayed], "omitted": []}
        if not optional:
            return "\n\n".join(parts), stat

        msg = (message or "").lower()
        scored = []
        for title, body, words in optional:
            score = 0
            for w in words:
                if w.lower() in msg:
                    score += 2 if len(w) >= 3 else 1
            if score:
                scored.append((score, title, body))
        scored.sort(key=lambda x: -x[0])
        top = scored[:RULES_TOP_K]
        if top:
            parts.append("【这次用得上的规则】\n\n" + "\n\n".join(b for _, _, b in top))
            stat["hit"] += [t for _, t, _ in top]
        show = {t for _, t, _ in top}
        stat["omitted"] = [t for t, _, _ in optional if t not in show]

        if stat["omitted"]:
            parts.append(
                "（以下规则这次没展开，但依然有效，需要时按标题回想："
                + "、".join(stat["omitted"])
                + "）"
            )
        return "\n\n".join(parts), stat

    # ------------------------------------------------------------ 钩子

    @filter.on_llm_request()
    async def on_request(self, event: AstrMessageEvent, req: ProviderRequest) -> None:
        if not self.enabled:
            return

        parsed = self._load()
        if not parsed:
            return

        text, stat = self._compose(parsed, getattr(event, "message_str", "") or "")
        if not text.strip():
            return

        req.system_prompt = (req.system_prompt or "") + text

    # ------------------------------------------------------------ 自查

    @filter.command("persona")
    async def status(self, event: AstrMessageEvent):
        """在聊天里发 /persona 看当前注入了多少、省了多少。"""
        path = Path(self.persona_path).expanduser()
        exists = path.exists()
        size = 0
        if exists:
            try:
                size = path.stat().st_size
            except Exception:
                size = 0

        parsed = self._load()
        full = cur = 0
        hit: list[str] = []
        omitted: list[str] = []
        if parsed:
            full = (
                sum(len(b) for _, b in parsed.get("persona") or [])
                + sum(len(b) for _, b in parsed.get("stayed") or [])
                + sum(len(b) for _, b, _ in parsed.get("optional") or [])
                + len(parsed.get("common") or "")
            )
            text, stat = self._compose(parsed, getattr(event, "message_str", "") or "")
            cur = len(text)
            hit, omitted = stat["hit"], stat["omitted"]

        lines = [
            "【人设共用】",
            f"总开关：{'开' if self.enabled else '关'}",
            f"文件：{path.name}（{'在' if exists else '不在'}，{size} 字节）",
        ]
        rules_len = len((parsed or {}).get("common") or "")
        if self.common_rules_path:
            lines.append(
                f"公共规则：{Path(self.common_rules_path).name}（{rules_len} 字，每轮常驻）"
            )
        else:
            lines.append("公共规则：没配（后台插件设置里填 common_rules_path，这层不会注入）")
        if parsed:
            lines.append(f"全量会是：{full} 字")
            lines.append(f"这条消息注入：{cur} 字")
            if full:
                lines.append(f"省下：{max(0, full - cur)} 字（{round((1 - cur / full) * 100)}%）")
            lines.append(f"带上了：{'、'.join(hit) or '空'}")
            if omitted:
                lines.append(f"没展开：{'、'.join(omitted)}")
        lines.append(
            f"dsh 那边：{'已接' if Path.home().joinpath('.dsh', 'AGENTS.md').exists() else '没接'}"
        )
        if not self.enabled:
            lines.append("提示：后台「插件」页把总开关打开才会生效。")
        elif not exists:
            lines.append("提示：文件路径不对，去后台插件设置里改 persona_path。")

        await event.send(event.plain_result("\n".join(lines)))
        event.stop_event()
