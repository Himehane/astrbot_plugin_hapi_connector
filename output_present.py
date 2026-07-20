"""推送呈现：按配置决定纯文本或结构卡图片。

Pillow 为可选依赖；不可用或渲染失败时永远回退文本。
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
    # AstrBotConfig 可能是 dict 子类
    try:
        return dict(cfg)
    except Exception:
        out = {}
        for k in card_render.config_defaults():
            out[k] = cfg.get(k) if hasattr(cfg, "get") else None
        for k in (
            "render_mode",
            "formula_mode",
            "render_kinds",
            "card_style_preset",
            "card_width",
            "card_accent",
            "card_bg",
            "card_fg",
            "card_font_scale",
            "card_density",
            "card_show_brand",
            "card_mono",
        ):
            if hasattr(cfg, "get"):
                out[k] = cfg.get(k)
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


async def present(
    plugin,
    event: AstrMessageEvent,
    kind: str,
    data: dict[str, Any],
    fallback_text: str,
) -> AsyncIterator:
    """yield 一条 event 结果：优先图片卡，否则纯文本。"""
    cfg = _cfg_dict(plugin)
    mode = str(cfg.get("render_mode") or "text").strip().lower()
    kinds = card_render.parse_kinds(cfg.get("render_kinds"))
    formula_mode = str(cfg.get("formula_mode") or "off").strip().lower()

    if not card_render.should_render_card(kind=kind, render_mode=mode, kinds=kinds):
        yield event.plain_result(fallback_text)
        return

    style = card_render.style_from_config(cfg)
    result = card_render.render_card(kind, data, style, formula_mode=formula_mode)
    if not result.ok or not result.png:
        if result.error:
            logger.info("card present fallback (%s): %s", kind, result.error)
        yield event.plain_result(fallback_text)
        return

    path = None
    try:
        fd, path = tempfile.mkstemp(prefix="hapi_card_", suffix=".png")
        os.close(fd)
        with open(path, "wb") as f:
            f.write(result.png)

        # 优先 image_result；部分环境再链一条短说明
        if hasattr(event, "image_result"):
            yield event.image_result(path)
            # 附一行操作提示（footer），避免纯图不可复制指令
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
