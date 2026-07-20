"""推送呈现：按配置决定纯文本或结构卡/对话卡图片。

Pillow / Playwright 为可选依赖；不可用或渲染失败时永远回退文本。
"""

from __future__ import annotations

import os
import tempfile
from typing import Any, AsyncIterator

try:
    from astrbot.api import logger
except ImportError:  # pragma: no cover
    import logging

    logger = logging.getLogger("hapi_connector.output_present")

try:
    from astrbot.api.event import AstrMessageEvent
except ImportError:  # pragma: no cover
    AstrMessageEvent = object  # type: ignore

from . import card_render


def _cfg_dict(plugin) -> dict[str, Any]:
    cfg = getattr(plugin, "config", {}) or {}
    keys = list(card_render.config_defaults().keys())
    try:
        out = dict(cfg)
        for k in keys:
            if k not in out and hasattr(cfg, "get"):
                out[k] = cfg.get(k)
        return out
    except Exception:
        out = {}
        for k in keys:
            out[k] = cfg.get(k) if hasattr(cfg, "get") else None
        return out


def build_session_list_payload(
    sessions: list[dict],
    current_sid: str | None,
    *,
    header: str = "",
) -> dict[str, Any]:
    rows = []
    for i, s in enumerate(sessions[:12], 1):
        sid = s.get("id") or ""
        meta = s.get("metadata") or {}
        flavor = str(meta.get("flavor") or "?").strip().lower()
        from . import formatters

        title = formatters.get_session_title(s) if hasattr(formatters, "get_session_title") else (
            meta.get("name") or meta.get("title") or sid[:8]
        )
        flags = []
        if sid and current_sid and sid == current_sid:
            flags.append("当前")
        if s.get("thinking"):
            flags.append("thinking")
        elif s.get("active"):
            flags.append("active")
        else:
            flags.append("idle")
        pend = s.get("pendingRequestsCount") or 0
        if pend:
            flags.append(f"pending {pend}")
        detail = f"{title} · {' · '.join(flags)}"
        rows.append({"index": i, "label": flavor, "detail": detail[:120]})
    more = ""
    if len(sessions) > 12:
        more = f" · 另有 {len(sessions) - 12} 个未展示"
    return {
        "title": "Session 列表",
        "subtitle": (header or f"共 {len(sessions)} 个") + more,
        "rows": rows,
        "footer": "/hapi sw <n>  切换    > 消息  快捷发送",
    }


def build_pending_payload(
    pending: dict[str, dict],
    sessions_cache: list[dict],
) -> dict[str, Any]:
    from . import formatters

    rows = []
    total = 0
    for sid, reqs in pending.items():
        for rid, req in reqs.items():
            total += 1
            if len(rows) >= 10:
                continue
            label = formatters.session_label_short(sid, sessions_cache)
            detail = formatters.format_request_detail(req)
            index = req.get("index", 0)
            rows.append({
                "index": index,
                "label": label[:40],
                "detail": str(detail)[:100],
            })
    extra = ""
    if total > 10:
        extra = f" · 仅显示前 10 / 共 {total}"
    return {
        "title": "待审批",
        "subtitle": f"当前窗口 {total} 项{extra}",
        "rows": rows or [{"index": 0, "label": "(空)", "detail": "没有待审批的请求"}],
        "footer": "/hapi a  全部批准    /hapi allow <n>  单项    /hapi pending",
    }


def build_message_payload(
    *,
    label: str,
    body: str,
    title: str = "Agent 消息",
    footer: str = "",
) -> dict[str, Any]:
    return {
        "title": title,
        "subtitle": label or "",
        "body": body or "",
        "footer": footer or "",
    }


def try_render_png(plugin, kind: str, data: dict[str, Any]) -> card_render.RenderResult | None:
    """若配置要求出卡且引擎可用，返回 RenderResult；否则 None（调用方发文本）。"""
    cfg = _cfg_dict(plugin)
    mode = card_render.normalize_render_mode(cfg.get("render_mode"))
    kinds = card_render.parse_kinds(cfg.get("render_kinds"))
    formula_mode = str(cfg.get("formula_mode") or "off").strip().lower()

    if not card_render.should_render_card(kind=kind, render_mode=mode, kinds=kinds):
        logger.debug(
            "card skip kind=%s mode=%s kinds=%s",
            kind, mode, ",".join(kinds),
        )
        return None

    style = card_render.style_from_config(cfg)
    result = card_render.render_card(kind, data, style, formula_mode=formula_mode)
    if not result.ok or not result.png:
        if result.error:
            logger.warning("card present fallback (%s): %s", kind, result.error)
        return None
    logger.info("card rendered kind=%s engine=%s bytes=%s", kind, result.engine, result.bytes_len)
    return result


def write_temp_png(png: bytes) -> str:
    fd, path = tempfile.mkstemp(prefix="hapi_card_", suffix=".png")
    os.close(fd)
    with open(path, "wb") as f:
        f.write(png)
    return path


async def present(
    plugin,
    event: AstrMessageEvent,
    kind: str,
    data: dict[str, Any],
    fallback_text: str,
) -> AsyncIterator:
    """yield 一条 event 结果：优先图片卡，否则纯文本。"""
    result = try_render_png(plugin, kind, data)
    if result is None:
        yield event.plain_result(fallback_text)
        return

    path = None
    try:
        path = write_temp_png(result.png or b"")
        if hasattr(event, "image_result"):
            yield event.image_result(path)
            footer = (data or {}).get("footer")
            if footer:
                yield event.plain_result(str(footer))
            return

        import astrbot.api.message_components as Comp

        chain = [Comp.Image.fromFileSystem(path)]
        footer = (data or {}).get("footer")
        if footer:
            chain.append(Comp.Plain(str(footer)))
        if hasattr(event, "chain_result"):
            yield event.chain_result(chain)
        else:
            yield event.plain_result(fallback_text)
    except Exception as e:
        logger.warning("present image failed: %s", e)
        yield event.plain_result(fallback_text)
    finally:
        if path:
            try:
                os.remove(path)
            except OSError:
                pass


async def present_push(
    plugin,
    notification_mgr,
    kind: str,
    data: dict[str, Any],
    fallback_text: str,
    session_id: str,
    sessions_cache: list[dict],
) -> bool:
    """SSE/后台推送路径：尝试发图，失败则发文本。返回是否已发送（图或文）。"""
    result = try_render_png(plugin, kind, data)
    if result is None or not result.png:
        await notification_mgr.push_notification(
            fallback_text, session_id, sessions_cache
        )
        return True

    path = None
    try:
        path = write_temp_png(result.png)
        footer = str((data or {}).get("footer") or "")
        await notification_mgr.push_image_notification(
            path,
            session_id,
            sessions_cache,
            caption=footer,
            dedupe_key=fallback_text,
        )
        return True
    except Exception as e:
        logger.warning("present_push image failed: %s", e)
        await notification_mgr.push_notification(
            fallback_text, session_id, sessions_cache
        )
        return True
    finally:
        if path:
            try:
                os.remove(path)
            except OSError:
                pass
