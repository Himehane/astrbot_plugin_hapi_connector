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
    scope: str = "window",
) -> dict[str, Any]:
    """结构卡用会话列表数据（信息与文本列表一致，版式独立美化）。

    - 按 path 分组
    - 主行是 session 标题
    - 序号优先用全局 all_sessions（兼容 list / list all / sw）
    - 字段拆开：status_key / flavor / model / pending / is_current，供卡片排版
    """
    from . import formatters

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
    n_thinking = n_active = n_closed = 0

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
        pending = int(s.get("pendingRequestsCount") or 0)

        if path != current_path:
            count = sum(
                1
                for x in sessions
                if (x.get("metadata") or {}).get("path", "(无路径)") == path
            )
            # 卡片分组：短路径优先展示末两段，完整 path 放 full_path
            short_path = path
            if path not in ("(无路径)",) and "/" in path:
                parts = [p for p in path.split("/") if p]
                if len(parts) > 2:
                    short_path = "…/" + "/".join(parts[-2:])
            rows.append({
                "type": "section",
                "label": short_path,
                "full_path": path,
                "detail": f"{count}",
                "count": count,
            })
            current_path = path

        if s.get("thinking"):
            status_key = "thinking"
            status = "思考中"
            n_thinking += 1
        elif s.get("active"):
            status_key = "active"
            status = "运行中"
            n_active += 1
        else:
            status_key = "closed"
            status = "已关闭"
            n_closed += 1

        is_current = bool(current_sid and sid == current_sid)
        # detail 仅作兼容/回退文本；真正出图用结构化字段
        detail_bits = [status, f"{flavor}:{model}"]
        if pending:
            detail_bits.append(f"待审 {pending}")
        if is_current:
            detail_bits.append("当前")

        rows.append({
            "type": "session",
            "index": display_idx,
            "sid_short": sid_short,
            "label": title,
            "detail": " · ".join(detail_bits),
            "status": status,
            "status_key": status_key,
            "flavor": flavor,
            "model": str(model),
            "pending": pending,
            "is_current": is_current,
            "path": path,
        })
        shown += 1

    scope_label = "全局" if scope == "all" else "当前窗口"
    subtitle_bits = [f"{scope_label} · {len(sessions)} 个"]
    if header and header not in subtitle_bits[0]:
        # 调用方自定义 header 时优先
        subtitle_bits = [header]
    if header_current_window and scope != "all":
        win = header_current_window
        if len(win) > 28:
            win = win[:12] + "…" + win[-12:]
        subtitle_bits.append(f"窗口 {win}")
    stats = []
    if n_thinking:
        stats.append(f"思考 {n_thinking}")
    if n_active:
        stats.append(f"运行 {n_active}")
    if n_closed:
        stats.append(f"关闭 {n_closed}")
    if stats:
        subtitle_bits.append(" / ".join(stats))
    if truncated:
        subtitle_bits.append(f"另有 {truncated} 个未展示")

    return {
        "title": "Session 列表" if scope != "all" else "全部 Session",
        "subtitle": " · ".join(subtitle_bits),
        "rows": rows,
        "layout": "session_list",
        "footer": "sw <序号|ID> 切换   ·   > 消息 快捷发送   ·   list all 全局",
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


def _strip_emoji(text: str) -> str:
    """卡片用：去掉 emoji / 杂符号，避免 Pillow 缺字形出方块或发灰。"""
    import re

    if not text:
        return ""
    # 常见 emoji / 杂项符号区（保留中英文、数字、标点、换行）
    text = re.sub(
        "["
        "\U0001F300-\U0001FAFF"  # 杂项符号与象形
        "\U00002700-\U000027BF"  # Dingbats
        "\U00002600-\U000026FF"  # 杂项符号
        "\U0000FE00-\U0000FE0F"  # 变体选择符
        "\U0000200D"             # ZWJ
        "\U000020E3"             # 键帽
        "]+",
        "",
        text,
    )
    # 文本列表里常见的装饰前缀（再保险）
    for ch in ("🏷️", "💬", "📂", "🤖", "📋", "🛠️", "💭", "🟢", "⚪", "⚠️", "💡", "📁"):
        text = text.replace(ch, "")
    # 行内多余空白
    text = re.sub(r"[ \t]{2,}", " ", text)
    text = re.sub(r"[ \t]+\n", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    # 装饰分隔符残留「 |  · 」等压扁
    text = re.sub(r"[ \t]*·[ \t]*·[ \t]*", " · ", text)
    text = re.sub(r"[ \t]*\|[ \t]*\|[ \t]*", " | ", text)
    return text.strip()


def build_message_payload(
    *,
    label: str,
    body: str,
    title: str = "Agent 消息",
    footer: str = "",
) -> dict[str, Any]:
    # 卡片路径：无 emoji；副标题压成单行便于排版
    sub = _strip_emoji(label or "")
    sub = " · ".join(p.strip() for p in sub.splitlines() if p.strip())
    return {
        "title": _strip_emoji(title) or "Agent 消息",
        "subtitle": sub,
        "body": _strip_emoji(body or ""),
        "footer": _strip_emoji(footer or ""),
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
