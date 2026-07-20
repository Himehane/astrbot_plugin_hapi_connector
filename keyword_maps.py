"""指令关键词映射。

数据源：
- 命令目录 / 文案：formatters.HELP_COMMANDS（export_command_catalog）
- 是否可带参：command_handlers.CommandHandlers.ROUTE_TAKES_ARG（与路由表同源）

匹配：
- 无参命令：整句严格匹配关键词
- 可带参命令：关键词整句，或「关键词 + 空白 + 参数」
"""

from __future__ import annotations

import json
from typing import Any


def _takes_arg_map() -> dict[str, bool]:
    from .hapi_routes import ROUTE_TAKES_ARG

    return dict(ROUTE_TAKES_ARG)


def export_command_catalog() -> dict[str, Any]:
    """可映射命令目录：主题 + 命令（usage/summary 来自 HELP_*，takes_arg 来自路由表）。"""
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
    return {"topics": topics, "commands": commands}


def _catalog_ids() -> set[str]:
    return {c["id"] for c in export_command_catalog().get("commands") or []}


def normalize_maps(raw: Any) -> list[dict[str, Any]]:
    """规范化映射列表。

    支持：
    - list[dict]
    - JSON 字符串
    - 空 / 非法 → []
    每项：{keywords: [str], command: str}
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
        out.append({"keywords": keywords, "command": cmd})
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
    - 可带参：整句 == 关键词（arg 空），或 关键词 + 空白 + 参数
    多关键词时按长度从长到短优先。
    """
    msg = str(text or "").strip()
    if not msg:
        return None

    takes = _takes_arg_map()
    # (kw_len, kw, cmd)
    candidates: list[tuple[int, str, str]] = []
    for item in normalize_maps(maps):
        cmd = str(item["command"])
        for kw in item.get("keywords") or []:
            k = str(kw or "").strip()
            if k:
                candidates.append((len(k), k, cmd))
    candidates.sort(key=lambda x: (-x[0], x[1]))

    for _, kw, cmd in candidates:
        takes_arg = bool(takes.get(cmd, False))
        if takes_arg:
            if msg == kw:
                return cmd, ""
            if msg.startswith(kw) and len(msg) > len(kw) and msg[len(kw)].isspace():
                return cmd, msg[len(kw) :].strip()
        else:
            if msg == kw:
                return cmd, ""
    return None
