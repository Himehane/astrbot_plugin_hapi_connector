"""戳一戳快捷操作：可配置映射到若干安全、无参/弱参指令。

设计：
- poke_approve=false → 总开关关闭，不响应
- poke_action 选择具体动作（默认 approve，兼容旧行为）
- 仅暴露无交互、低风险、适合「一戳即做」的动作；不开放任意 shell
"""

from __future__ import annotations

from typing import Any, AsyncIterator

try:
    from astrbot.api.event import AstrMessageEvent
except ImportError:  # pragma: no cover
    AstrMessageEvent = object  # type: ignore

from ..render import formatters
from ..core import session_ops
# id → 元数据（WebUI / 文档同源）
POKE_ACTIONS: dict[str, dict[str, str]] = {
    "approve": {
        "label": "批准待审",
        "desc": "批准当前窗口可见的非 question 权限请求（原默认行为）",
        "cmd": "/hapi a",
        "emoji": "✅",
    },
    # 刻意不提供 deny：一戳拒绝全部误触成本过高，请用 /hapi deny
    "pending": {
        "label": "查看待审",
        "desc": "列出当前窗口待审批请求",
        "cmd": "/hapi pending",
        "emoji": "📋",
    },
    "list": {
        "label": "会话列表",
        "desc": "列出当前窗口可见的 session",
        "cmd": "/hapi list",
        "emoji": "☰",
    },
    "status": {
        "label": "当前状态",
        "desc": "查看当前绑定 session 状态",
        "cmd": "/hapi s",
        "emoji": "◎",
    },
    "stop": {
        "label": "中止当前",
        "desc": "中止当前窗口生效中的 session",
        "cmd": "/hapi abort",
        "emoji": "⏹",
    },
    "output_cycle": {
        "label": "切换推送级别",
        "desc": "在 silence → simple → summary → detail 间循环",
        "emoji": "📢",
    },
    "none": {
        "label": "仅确认（无业务）",
        "desc": "提示已收到戳一戳，不执行业务动作",
        "emoji": "👋",
    },
}

DEFAULT_POKE_ACTION = "approve"
OUTPUT_CYCLE = ("silence", "simple", "summary", "detail")


def normalize_poke_action(raw: Any) -> str:
    s = str(raw or DEFAULT_POKE_ACTION).strip().lower()
    # 历史配置可能仍是 deny：降级为 approve，避免一戳全拒
    if s == "deny":
        return DEFAULT_POKE_ACTION
    if s in POKE_ACTIONS:
        return s
    return DEFAULT_POKE_ACTION


def poke_actions_meta() -> list[dict[str, str]]:
    out: list[dict[str, str]] = []
    for k, v in POKE_ACTIONS.items():
        item = {
            "id": k,
            "label": v["label"],
            "desc": v["desc"],
            "emoji": v.get("emoji", ""),
        }
        if v.get("cmd"):
            item["cmd"] = v["cmd"]
        out.append(item)
    return out


def _visible_sids(plugin, event: AstrMessageEvent) -> set[str]:
    sids = {
        s.get("id")
        for s in plugin.state_mgr.visible_sessions_for_window(event, plugin.sessions_cache)
        if s.get("id")
    }
    sids.add(event.unified_msg_origin)
    return sids


async def run_poke_action(
    plugin,
    event: AstrMessageEvent,
    action: str | None = None,
) -> AsyncIterator[Any]:
    """执行戳一戳动作，yield event 结果对象。"""
    raw = action
    if raw is None:
        raw = getattr(plugin, "_poke_action", None)
    if raw is None and hasattr(plugin, "config"):
        raw = plugin.config.get("poke_action")
    action = normalize_poke_action(raw)
    meta = POKE_ACTIONS.get(action) or POKE_ACTIONS[DEFAULT_POKE_ACTION]
    tag = f"[戳一戳 · {meta['label']}]"

    handlers = {
        "none": _act_none,
        "approve": _act_approve,
        "pending": _act_pending,
        "list": _act_list,
        "status": _act_status,
        "stop": _act_stop,
        "output_cycle": _act_output_cycle,
    }
    handler = handlers.get(action, _act_none)
    async for r in handler(plugin, event, tag):
        yield r


async def _act_none(plugin, event, tag: str) -> AsyncIterator[Any]:
    yield event.plain_result(f"{tag} 已收到")


async def _act_approve(plugin, event, tag: str) -> AsyncIterator[Any]:
    visible_sids = _visible_sids(plugin, event)
    items = plugin.pending_mgr.flatten_pending(event, visible_sids)
    if not items:
        return  # 无待审静默（兼容旧体验）

    regular = [
        (sid, rid, req)
        for sid, rid, req in items
        if not formatters.is_question_request(req)
    ]
    questions = [
        (sid, rid, req)
        for sid, rid, req in items
        if formatters.is_question_request(req)
    ]

    if regular:
        result = await plugin.pending_mgr.approve_items(regular, plugin.client)
        if result:
            yield event.plain_result(f"{tag} {result}")

    if questions:
        yield event.plain_result(f"{tag} 还有 {len(questions)} 个问题需要回答:")
        from astrbot.core.utils.session_waiter import session_waiter, SessionController

        await plugin.pending_mgr.answer_questions_interactive(
            event, questions, plugin.client, session_waiter, SessionController
        )


async def _act_pending(plugin, event, tag: str) -> AsyncIterator[Any]:
    from ..render import output_present
    visible_sids = _visible_sids(plugin, event)
    pending = plugin.pending_mgr.get_pending_for_window(event, visible_sids)
    text = formatters.format_pending_requests(pending, plugin.sessions_cache)
    payload = output_present.build_pending_payload(pending, plugin.sessions_cache)
    async for result in output_present.present(
        plugin, event, "pending", payload, f"{tag}\n{text}"
    ):
        yield result


async def _act_list(plugin, event, tag: str) -> AsyncIterator[Any]:
    from ..render import output_present
    await plugin._refresh_sessions()
    visible = plugin.state_mgr.visible_sessions_for_window(event, plugin.sessions_cache)
    if not visible:
        yield event.plain_result(
            f"{tag}\n{plugin._format_no_visible_sessions_text(event)}"
        )
        return
    current_sid = plugin.state_mgr.effective_sid(event)
    text = formatters.format_session_list(
        visible,
        current_sid,
        plugin.sessions_cache,
        header_current_window=event.unified_msg_origin,
    )
    payload = output_present.build_session_list_payload(
        visible,
        current_sid,
        all_sessions=plugin.sessions_cache,
        header=f"{tag} · {len(visible)} 个",
        header_current_window=event.unified_msg_origin,
    )
    async for result in output_present.present(
        plugin, event, "session_list", payload, f"{tag}\n{text}"
    ):
        yield result


async def _act_status(plugin, event, tag: str) -> AsyncIterator[Any]:
    await plugin._refresh_sessions()
    sid = plugin.state_mgr.effective_sid(event)
    if not sid:
        yield event.plain_result(f"{tag} 当前窗口未绑定 session，请先 /hapi sw")
        return
    session = next((s for s in plugin.sessions_cache if s.get("id") == sid), None)
    if not session:
        yield event.plain_result(f"{tag} 未找到 session [{sid[:8]}]")
        return
    text = formatters.format_session_status(session)
    yield event.plain_result(f"{tag}\n{text}")


async def _act_stop(plugin, event, tag: str) -> AsyncIterator[Any]:
    await plugin._refresh_sessions()
    sid = plugin.state_mgr.effective_sid(event)
    if not sid:
        yield event.plain_result(f"{tag} 当前无生效 session，无法中止")
        return
    ok, msg = await session_ops.abort_session(plugin.client, sid)
    mark = "✓" if ok else "✗"
    yield event.plain_result(f"{tag} {mark} {msg}")


async def _act_output_cycle(plugin, event, tag: str) -> AsyncIterator[Any]:
    cur = str(plugin.config.get("output_level") or "simple").strip().lower()
    try:
        idx = OUTPUT_CYCLE.index(cur)
    except ValueError:
        idx = 1
    nxt = OUTPUT_CYCLE[(idx + 1) % len(OUTPUT_CYCLE)]
    plugin.config["output_level"] = nxt
    try:
        plugin.sse_listener.output_level = nxt
    except Exception:
        pass
    try:
        from ..webui.web_api import _persist_config

        await _persist_config(plugin)
    except Exception:
        save = getattr(plugin.config, "save_config_async", None) or getattr(
            plugin.config, "save_config", None
        )
        if callable(save):
            result = save()
            if hasattr(result, "__await__"):
                await result
    yield event.plain_result(f"{tag} 推送级别: {cur} → {nxt}")
