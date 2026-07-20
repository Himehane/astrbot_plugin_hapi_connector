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


def _cfg_get(cfg: Any, key: str, default: Any = None) -> Any:
    if cfg is None:
        return default
    try:
        if hasattr(cfg, "get"):
            val = cfg.get(key, default)
        else:
            val = cfg[key]  # type: ignore[index]
    except Exception:
        val = getattr(cfg, key, default)
    return default if val is None else val


def _cfg_dict(plugin) -> dict[str, Any]:
    """从 plugin.config 读出卡相关配置（兼容 AstrBotConfig / dict）。"""
    cfg = getattr(plugin, "config", None)
    defaults = card_render.config_defaults()
    out: dict[str, Any] = dict(defaults)
    for k in defaults:
        val = _cfg_get(cfg, k, defaults[k])
        if val is not None:
            out[k] = val
    # 再读一遍关键键，防止 defaults 漏键
    for k in ("render_mode", "render_kinds", "formula_mode", "card_custom_css", "card_font_path"):
        val = _cfg_get(cfg, k, out.get(k))
        if val is not None:
            out[k] = val
    out["render_mode"] = card_render.normalize_render_mode(out.get("render_mode"))
    return out


def build_session_list_payload(
    sessions: list[dict],
    current_sid: str | None,
    *,
    header: str = "",
    all_sessions: list[dict] | None = None,
    header_current_window: str | None = None,
    max_items: int = 40,
) -> dict[str, Any]:
    """与 formatters.format_session_list 对齐：

    - 按 path（文件夹）分组
    - 主行是 session 标题，不是 flavor
    - 序号优先用全局 all_sessions 编号（兼容 list / list all / sw）
    """
    from . import formatters

    # 全局序号（与 /hapi list 文本、/hapi sw <n> 一致）
    index_by_sid: dict[str, int] = {}
    if all_sessions:
        for idx, session in enumerate(all_sessions, 1):
            sid = session.get("id")
            if sid and sid not in index_by_sid:
                index_by_sid[sid] = idx

    rows: list[dict[str, Any]] = []
    shown = 0
    truncated = 0
    current_path = None

    for local_idx, s in enumerate(sessions, 1):
        if shown >= max_items:
            truncated = len(sessions) - shown
            break

        meta = s.get("metadata") or {}
        if not isinstance(meta, dict):
            meta = {}
        path = str(meta.get("path") or "(无路径)")
        sid = s.get("id") or "?"
        sid_short = sid[:8]
        display_idx = index_by_sid.get(sid, local_idx)
        title = formatters.get_session_title(s)
        flavor = str(meta.get("flavor") or "?").strip().lower()
        model = s.get("modelMode") or "default"
        pending = s.get("pendingRequestsCount") or 0

        if path != current_path:
            count = sum(
                1
                for x in sessions
                if (x.get("metadata") or {}).get("path", "(无路径)") == path
            )
            # 卡片用纯文本分组（避免 Pillow 缺 emoji 字形出方块）
            rows.append({
                "type": "section",
                "label": f"· {path}",
                "detail": f"{count} 个",
            })
            current_path = path

        if s.get("thinking"):
            status = "思考中"
        elif s.get("active"):
            status = "运行中"
        else:
            status = "已关闭"

        parts = [status, f"{flavor}:{model}"]
        if pending:
            parts.append(f"待审批 {pending}")
        if current_sid and sid == current_sid:
            parts.append("<<当前")

        rows.append({
            "type": "session",
            "index": display_idx,
            "sid_short": sid_short,
            "label": title,  # 主标题：会话名，不是 flavor
            "detail": " | ".join(parts),
        })
        shown += 1

    subtitle_bits = []
    if header_current_window:
        win = header_current_window
        if len(win) > 36:
            win = win[:16] + "…" + win[-16:]
        subtitle_bits.append(f"窗口 {win}")
    subtitle_bits.append(header or f"共 {len(sessions)} 个")
    if truncated:
        subtitle_bits.append(f"另有 {truncated} 个未展示")

    return {
        "title": "Session 列表",
        "subtitle": " · ".join(subtitle_bits),
        "rows": rows,
        "footer": "/hapi sw <序号或ID前缀>  切换    > 消息  快捷发送",
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
        logger.info(
            "card skip kind=%s mode=%s kinds=%s (需 render_mode=card 且 kinds 含该类型)",
            kind, mode, ",".join(kinds),
        )
        return None

    style = card_render.style_from_config(cfg)
    result = card_render.render_card(kind, data, style, formula_mode=formula_mode)
    if not result.ok or not result.png:
        logger.warning(
            "card present fallback kind=%s error=%s engine=%s",
            kind, result.error, result.engine,
        )
        return None
    logger.info(
        "card rendered kind=%s engine=%s bytes=%s ms=%.1f",
        kind, result.engine, result.bytes_len, result.ms,
    )
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
        logger.info("card push kind=%s path=%s sid=%s", kind, path, (session_id or "")[:8])
        await notification_mgr.push_image_notification(
            path,
            session_id,
            sessions_cache,
            caption=footer,
            dedupe_key=f"card:{kind}:{session_id}:{hash(fallback_text) & 0xFFFFFFFF:x}",
        )
        return True
    except Exception as e:
        logger.warning("present_push image failed kind=%s: %s", kind, e)
        await notification_mgr.push_notification(
            fallback_text, session_id, sessions_cache
        )
        return True
    finally:
        if path:
            # 稍延迟删除，避免部分适配器异步读文件时已被删
            try:
                import asyncio

                async def _unlink_later(p: str):
                    try:
                        await asyncio.sleep(30)
                        os.remove(p)
                    except OSError:
                        pass

                try:
                    asyncio.get_running_loop().create_task(_unlink_later(path))
                except RuntimeError:
                    try:
                        os.remove(path)
                    except OSError:
                        pass
            except Exception:
                try:
                    os.remove(path)
                except OSError:
                    pass
