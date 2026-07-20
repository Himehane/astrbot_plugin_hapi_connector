"""指令关键词映射。

数据源：
- 命令目录 / 文案：formatters.HELP_COMMANDS（export_command_catalog）
- 是否可带参：hapi_routes.ROUTE_TAKES_ARG（与路由表同源）

匹配：
- 无参命令：整句严格匹配关键词
- 可带参命令：关键词整句，或「关键词 + 空白 + 参数」
- 映射可带固定 args（如 cl → to + 1 clear）；有固定 args 时仅整句匹配关键词
"""

from __future__ import annotations

import json
from typing import Any

# 默认映射（schema / 空配置时使用）
DEFAULT_KEYWORD_MAPS: list[dict[str, Any]] = [
    {"keywords": ["stop", "停"], "command": "stop", "args": ""},
    {"keywords": ["sw"], "command": "sw", "args": ""},
    {"keywords": ["cl"], "command": "to", "args": "1 clear"},
    {"keywords": ["继续"], "command": "to", "args": "1 继续"},
]


def default_maps_storage() -> str:
    return maps_to_storage(DEFAULT_KEYWORD_MAPS)


def _takes_arg_map() -> dict[str, bool]:
    from .hapi_routes import ROUTE_TAKES_ARG

    return dict(ROUTE_TAKES_ARG)


def export_command_catalog() -> dict[str, Any]:
    """可映射命令目录：主题 + 命令（usage/summary 来自 HELP_*，takes_arg 来自路由表）。

    路由表里有、帮助表未单独列出的别名（如 stop）也会补进目录。
    """
    from . import formatters

    help_data = formatters.export_help_data()
    topics = help_data.get("topics") or []
    takes = _takes_arg_map()
    seen: set[str] = set()
    commands: list[dict[str, Any]] = []
    for item in formatters.HELP_COMMANDS:
        usage = str(item.get("usage") or "").strip()
        if not usage.startswith("/hapi"):
            continue
        rest = usage[len("/hapi") :].strip()
        if not rest:
            continue
        # /hapi list [all] → list；/hapi bind [<flavor>] → bind
        token = rest.split(None, 1)[0]
        cmd_id = token.strip("[]<>").lower()
        if not cmd_id or cmd_id in seen:
            continue
        # 只收录路由表里存在的子命令
        if cmd_id not in takes:
            continue
        seen.add(cmd_id)
        commands.append(
            {
                "id": cmd_id,
                "topic": str(item.get("topic") or ""),
                "usage": usage,
                "summary": str(item.get("summary") or ""),
                "takes_arg": bool(takes[cmd_id]),
            }
        )
    # 路由别名补全（如 stop → 与 abort 同表）
    for cmd_id, takes_arg in takes.items():
        if cmd_id in seen:
            continue
        # 跳过中文别名当主 id 已有时
        if not cmd_id.isascii():
            continue
        commands.append(
            {
                "id": cmd_id,
                "topic": "session",
                "usage": f"/hapi {cmd_id}",
                "summary": f"（路由别名）/hapi {cmd_id}",
                "takes_arg": bool(takes_arg),
            }
        )
        seen.add(cmd_id)
    return {"topics": topics, "commands": commands}


def _catalog_ids() -> set[str]:
    """合法 command id = 路由表全部键（含别名）。"""
    return set(_takes_arg_map().keys())


def normalize_maps(raw: Any) -> list[dict[str, Any]]:
    """规范化映射列表。

    支持：
    - list[dict]
    - JSON 字符串
    - 空 / 非法 → []
    每项：{keywords: [str], command: str, args?: str}
    """
    data = raw
    if data is None or data == "":
        return []
    if isinstance(data, str):
        s = data.strip()
        if not s:
            return []
        try:
            data = json.loads(s)
        except Exception:
            return []
    if not isinstance(data, list):
        return []

    valid_ids = _catalog_ids()
    out: list[dict[str, Any]] = []
    for item in data:
        if not isinstance(item, dict):
            continue
        cmd = str(item.get("command") or item.get("cmd") or "").strip().lower()
        if not cmd or (valid_ids and cmd not in valid_ids):
            continue
        kws_raw = item.get("keywords") or item.get("keys") or []
        if isinstance(kws_raw, str):
            kws_raw = [p.strip() for p in kws_raw.replace("，", ",").split(",") if p.strip()]
        if not isinstance(kws_raw, list):
            continue
        keywords: list[str] = []
        for k in kws_raw:
            t = str(k or "").strip()
            if t and t not in keywords:
                keywords.append(t)
        if not keywords:
            continue
        # 固定发送消息（仅 to 等可带参命令；如 to → 1 clear）
        args = str(item.get("args") or item.get("argument") or "").strip()
        entry: dict[str, Any] = {"keywords": keywords, "command": cmd}
        if args:
            entry["args"] = args
        out.append(entry)
    return out


def maps_to_storage(maps: list[dict[str, Any]] | Any) -> str:
    """落盘为 JSON 字符串。"""
    cleaned = normalize_maps(maps)
    return json.dumps(cleaned, ensure_ascii=False)


def find_mapped_command(
    maps: list[dict[str, Any]] | Any, text: str
) -> tuple[str, str] | None:
    """匹配关键词 → (command_id, argument)。

    - 无参：仅整句 == 关键词
    - 可带参且无固定 args：整句 == 关键词（arg 空），或 关键词 + 空白 + 用户参数
    - 有固定 args：仅整句 == 关键词时生效，argument = 固定 args
    多关键词时按长度从长到短优先。
    """
    msg = str(text or "").strip()
    if not msg:
        return None

    takes = _takes_arg_map()
    # (kw_len, kw, cmd, fixed_args)
    candidates: list[tuple[int, str, str, str]] = []
    for item in normalize_maps(maps):
        cmd = str(item["command"])
        fixed = str(item.get("args") or "").strip()
        for kw in item.get("keywords") or []:
            k = str(kw or "").strip()
            if k:
                candidates.append((len(k), k, cmd, fixed))
    candidates.sort(key=lambda x: (-x[0], x[1]))

    for _, kw, cmd, fixed in candidates:
        takes_arg = bool(takes.get(cmd, False))
        if msg == kw:
            return cmd, fixed
        # 有固定发送消息的映射只做整句匹配，避免 cl xxx 误拼参数
        if fixed:
            continue
        if takes_arg:
            if msg.startswith(kw) and len(msg) > len(kw) and msg[len(kw)].isspace():
                return cmd, msg[len(kw) :].strip()
    return None


# ── /hapi alias 展示（纯数据 → 文案，不依赖 command_handlers / main） ──

MATCH_RULES_TEXT = """匹配规则：
· 无参命令：聊天整句 = 关键词 → 执行 /hapi <命令>
· 可带参、无固定消息：整句 = 关键词，或「关键词 + 空格 + 参数」
· 有固定发送消息（仅 to 等）：整句 = 关键词 → /hapi to <固定消息>
· 仅当前窗口存在运行中/思考中会话时生效（与 LLM 工具动态注册类似）
· 仅管理员；不接管普通聊天（无映射则原样放行）"""


def _target_line(cmd: str, fixed_args: str, takes_arg: bool) -> str:
    if fixed_args:
        return f"/hapi {cmd} {fixed_args}"
    if takes_arg:
        return f"/hapi {cmd} [参数]"
    return f"/hapi {cmd}"


def _match_hint(cmd: str, fixed_args: str, takes_arg: bool) -> str:
    if fixed_args:
        return "整句（固定消息）"
    if takes_arg:
        return "整句，或 关键词 + 参数"
    return "整句"


def format_maps_list(
    maps: list[dict[str, Any]] | Any,
    *,
    filter_text: str = "",
) -> str:
    """生成 /hapi alias 输出。filter_text 可选：按关键词或命令 id 子串过滤。"""
    items = normalize_maps(maps)
    takes = _takes_arg_map()
    q = str(filter_text or "").strip().lower()

    rows: list[dict[str, Any]] = []
    for item in items:
        cmd = str(item.get("command") or "")
        fixed = str(item.get("args") or "").strip()
        kws = [str(k) for k in (item.get("keywords") or []) if k]
        if q:
            # 过滤：优先完整字段相等；否则仅当查询长度≥2 时在整字段上做前缀/子串
            # 注意：不能把 "to" 当子串去匹配 "stop"（"to" in "stop" 为真）
            def _field_hit(field: str) -> bool:
                f = str(field or "").lower()
                if not f:
                    return False
                if f == q:
                    return True
                # 短查询（1 字）只做相等，避免误伤
                if len(q) < 2:
                    return False
                # 中文或较长查询：允许包含；英文命令 id 用前缀，避免 to⊂stop
                if any("一" <= ch <= "鿿" for ch in q):
                    return q in f
                return f.startswith(q) or f == q

            hit = (
                _field_hit(cmd)
                or _field_hit(fixed)
                or any(_field_hit(k) for k in kws)
            )
            # 固定消息里允许较长英文子串（如 clear）
            if not hit and fixed and len(q) >= 3 and q in fixed.lower():
                hit = True
            if not hit:
                continue
        rows.append(
            {
                "keywords": kws,
                "command": cmd,
                "args": fixed,
                "takes_arg": bool(takes.get(cmd, False)),
            }
        )

    lines: list[str] = [
        "指令关键词映射",
        f"共 {len(rows)} 条" + (f"（过滤「{filter_text.strip()}」）" if q else ""),
        "",
        MATCH_RULES_TEXT.strip(),
        "",
    ]

    if not rows:
        lines.append("（无映射）")
        lines.append("在 WebUI「交互优化 → 指令关键词映射」添加，或恢复配置默认。")
        return "\n".join(lines)

    for i, row in enumerate(rows, 1):
        kw_txt = "、".join(row["keywords"])
        target = _target_line(row["command"], row["args"], row["takes_arg"])
        hint = _match_hint(row["command"], row["args"], row["takes_arg"])
        lines.append(f"{i}. {kw_txt}")
        lines.append(f"   → {target}")
        lines.append(f"   匹配：{hint}")
        lines.append("")

    lines.append("配置：WebUI 交互优化 · 指令关键词映射")
    lines.append("命令：/hapi alias [过滤词]")
    return "\n".join(lines).rstrip() + "\n"
