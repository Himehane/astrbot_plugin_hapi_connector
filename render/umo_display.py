"""统一消息源（UMO）展示名。

格式约定（聊天 / WebUI 共用）：
  Bot:{平台}-{私聊|群聊|频道}-{名称或ID}

优先顺序：
  1. 用户自定义别名（AstrBot /name 写入的 user_alias）
  2. 平台自动名（auto_name，如群名/好友昵称）
  3. session id 尾号
"""

from __future__ import annotations

from typing import Any

try:
    from astrbot.api import logger
except ImportError:  # pragma: no cover
    import logging

    logger = logging.getLogger("hapi_connector.umo_display")


def parse_umo(umo: str | None) -> dict[str, str]:
    """platform:message_type:session_id → 结构化字段。"""
    raw = str(umo or "").strip()
    if not raw:
        return {
            "platform": "",
            "msg_type": "",
            "kind": "unknown",
            "kind_label": "窗口",
            "session_id": "",
            "raw": "",
        }

    parts = raw.split(":")
    if len(parts) >= 3:
        platform = parts[0]
        msg_type = parts[1]
        session_id = ":".join(parts[2:])
    elif len(parts) == 2:
        platform, session_id = parts[0], parts[1]
        msg_type = ""
    else:
        platform, msg_type, session_id = "", "", raw

    mt = msg_type or ""
    mt_l = mt.lower()
    if "group" in mt_l or mt in ("GroupMessage", "Group"):
        kind, kind_label = "group", "群聊"
    elif (
        "friend" in mt_l
        or "private" in mt_l
        or mt in ("FriendMessage", "PrivateMessage", "Private")
    ):
        kind, kind_label = "private", "私聊"
    elif "channel" in mt_l:
        kind, kind_label = "channel", "频道"
    elif "guild" in mt_l:
        kind, kind_label = "guild", "频道"
    else:
        kind = mt or "unknown"
        kind_label = mt or "窗口"

    return {
        "platform": platform,
        "msg_type": msg_type,
        "kind": kind,
        "kind_label": kind_label,
        "session_id": session_id,
        "raw": raw,
    }


def format_umo_title(
    umo: str | None,
    *,
    name: str | None = None,
    max_tail: int = 36,
) -> str:
    """生成展示标题：Bot:maimai-群聊-名称或ID。"""
    info = parse_umo(umo)
    if not info["raw"]:
        return "—"

    platform = info["platform"] or "bot"
    kind_label = info["kind_label"] or "窗口"
    sid = info["session_id"] or info["raw"]

    tail = (name or "").strip() or sid
    if len(tail) > max_tail:
        tail = tail[: max_tail - 1] + "…"

    return f"Bot:{platform}-{kind_label}-{tail}"


def _alias_fields(alias: Any) -> tuple[str | None, str | None]:
    """从 UmoAlias 对象或 dict 取 user_alias / auto_name。"""
    if alias is None:
        return None, None
    if isinstance(alias, dict):
        user = alias.get("user_alias") or alias.get("userAlias")
        auto = alias.get("auto_name") or alias.get("autoName")
    else:
        user = getattr(alias, "user_alias", None) or getattr(alias, "userAlias", None)
        auto = getattr(alias, "auto_name", None) or getattr(alias, "autoName", None)
    user_s = str(user).strip() if user else None
    auto_s = str(auto).strip() if auto else None
    return user_s or None, auto_s or None


def _db_helper(context) -> Any | None:
    if context is None:
        return None
    for attr in ("db_helper", "db", "database"):
        db = getattr(context, attr, None)
        if db is not None:
            return db
    # 偶发：core_lifecycle.db_helper
    core = getattr(context, "core_lifecycle", None) or getattr(
        context, "astrbot_core_lifecycle", None
    )
    if core is not None:
        for attr in ("db_helper", "db"):
            db = getattr(core, attr, None)
            if db is not None:
                return db
    return None


async def resolve_umo_name(context, umo: str | None) -> str | None:
    """查 AstrBot UMO 别名：user_alias > auto_name。失败返回 None。"""
    if not umo:
        return None
    db = _db_helper(context)
    if db is None:
        return None

    # 单条
    getter = getattr(db, "get_umo_alias", None)
    if callable(getter):
        try:
            alias = await getter(str(umo))
            user, auto = _alias_fields(alias)
            if user or auto:
                return user or auto
        except Exception as e:
            logger.debug("get_umo_alias failed umo=%s: %s", str(umo)[:40], e)

    # 批量接口
    getters = getattr(db, "get_umo_aliases", None)
    if callable(getters):
        try:
            rows = await getters([str(umo)])
            if isinstance(rows, dict):
                user, auto = _alias_fields(rows.get(str(umo)))
                if user or auto:
                    return user or auto
            elif isinstance(rows, (list, tuple)):
                for row in rows:
                    # 列表元素可能是 UmoAlias
                    row_umo = (
                        getattr(row, "umo", None)
                        if not isinstance(row, dict)
                        else row.get("umo")
                    )
                    if row_umo and str(row_umo) == str(umo):
                        user, auto = _alias_fields(row)
                        if user or auto:
                            return user or auto
        except Exception as e:
            logger.debug("get_umo_aliases failed: %s", e)

    return None


async def resolve_umo_names(context, umos: list[str] | set[str]) -> dict[str, str]:
    """批量解析展示名（仅有别名/自动名时写入 map）。"""
    uniq = [str(u) for u in umos if u]
    if not uniq:
        return {}

    out: dict[str, str] = {}
    db = _db_helper(context)
    if db is None:
        return out

    getters = getattr(db, "get_umo_aliases", None)
    if callable(getters):
        try:
            rows = await getters(uniq)
            if isinstance(rows, dict):
                for k, v in rows.items():
                    user, auto = _alias_fields(v)
                    name = user or auto
                    if name:
                        out[str(k)] = name
            elif isinstance(rows, (list, tuple)):
                for row in rows:
                    if isinstance(row, dict):
                        k = row.get("umo")
                        user, auto = _alias_fields(row)
                    else:
                        k = getattr(row, "umo", None)
                        user, auto = _alias_fields(row)
                    name = user or auto
                    if k and name:
                        out[str(k)] = name
            if out:
                return out
        except Exception as e:
            logger.debug("batch get_umo_aliases failed: %s", e)

    # 回退逐条
    for u in uniq:
        name = await resolve_umo_name(context, u)
        if name:
            out[u] = name
    return out


def format_umo_title_with_names(
    umo: str | None,
    names: dict[str, str] | None = None,
    *,
    max_tail: int = 36,
) -> str:
    names = names or {}
    name = names.get(str(umo or "")) if umo else None
    return format_umo_title(umo, name=name, max_tail=max_tail)
