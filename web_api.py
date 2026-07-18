"""AstrBot Plugin Pages 后端 API。

注册方式：main.__init__ 中调用 register_pages(plugin)（与官方 plugin-pages 示例一致）。
规范见 dev-docs/plugin-pages.md 与 dev-docs/webui开发计划.md。
"""

from __future__ import annotations

import asyncio
from typing import Any
from urllib.parse import urlparse

from astrbot.api import logger

from . import formatters, flavor_profiles

PLUGIN_NAME = "astrbot_plugin_hapi_connector"

# 与 _conf_schema.json 对齐的可读写键
CONFIG_KEYS = (
    "hapi_endpoint",
    "access_token",
    "proxy_url",
    "cf_access_client_id",
    "cf_access_client_secret",
    "max_reconnect_attempts",
    "jwt_lifetime",
    "refresh_before_expiry",
    "output_level",
    "summary_msg_count",
    "quick_prefix",
    "poke_approve",
    "remind_pending",
    "remind_interval",
    "auto_approve_enabled",
    "auto_approve_start",
    "auto_approve_end",
    "default_notification_window",
)

SENSITIVE_KEYS = frozenset({"access_token", "cf_access_client_secret"})

# 改这些后需要重建 client / 重启 SSE
RECONNECT_KEYS = frozenset({
    "hapi_endpoint",
    "access_token",
    "proxy_url",
    "cf_access_client_id",
    "cf_access_client_secret",
    "jwt_lifetime",
    "refresh_before_expiry",
    "max_reconnect_attempts",
})

OUTPUT_LEVELS = ("silence", "simple", "summary", "detail")

BOOL_KEYS = frozenset({
    "poke_approve",
    "remind_pending",
    "auto_approve_enabled",
})

INT_KEYS = frozenset({
    "max_reconnect_attempts",
    "jwt_lifetime",
    "refresh_before_expiry",
    "summary_msg_count",
    "remind_interval",
})


def register_pages(plugin) -> None:
    """在插件 Context 上注册全部 Page API。"""
    ctx = plugin.context
    prefix = f"/{PLUGIN_NAME}"
    api = WebApi(plugin)

    routes = [
        (f"{prefix}/meta", api.meta, ["GET"], "WebUI meta"),
        (f"{prefix}/overview", api.overview, ["GET"], "WebUI overview"),
        (f"{prefix}/config", api.get_config, ["GET"], "WebUI get config"),
        (f"{prefix}/config", api.post_config, ["POST"], "WebUI save config"),
        (f"{prefix}/help", api.help_data, ["GET"], "WebUI help"),
        (f"{prefix}/connection/wake", api.connection_wake, ["POST"], "WebUI wake SSE"),
        (f"{prefix}/connection/reconnect", api.connection_reconnect, ["POST"], "WebUI reconnect HAPI"),
        (f"{prefix}/sessions/snapshot", api.sessions_snapshot, ["GET"], "WebUI sessions snapshot"),
        (f"{prefix}/sessions/batch", api.sessions_batch, ["POST"], "WebUI batch lifecycle"),
        (f"{prefix}/sessions/<sid>/permission", api.session_permission, ["POST"], "WebUI set permission"),
        (f"{prefix}/sessions/<sid>/bind", api.session_bind, ["POST"], "WebUI bind session"),
        (f"{prefix}/sessions/<sid>/lifecycle", api.session_lifecycle, ["POST"], "WebUI session lifecycle"),
        (f"{prefix}/sessions/<sid>", api.session_detail, ["GET"], "WebUI session detail"),
        (f"{prefix}/routes/primary", api.routes_primary, ["POST"], "WebUI set primary route"),
        (f"{prefix}/routes/flavor", api.routes_flavor, ["POST"], "WebUI set flavor route"),
    ]
    for route, handler, methods, desc in routes:
        ctx.register_web_api(route, handler, methods, desc)
    logger.info("HAPI Connector WebUI API registered (%d routes)", len(routes))


class WebApi:
    """持有 plugin 引用的 handler 集合。"""

    def __init__(self, plugin):
        self.plugin = plugin

    # ──── handlers ────

    async def meta(self):
        from astrbot.api.web import json_response

        profiles = flavor_profiles.export_profiles_meta()
        return json_response({
            "plugin_name": PLUGIN_NAME,
            "plugin_version": _plugin_version(self.plugin),
            "output_levels": list(OUTPUT_LEVELS),
            **profiles,
        })

    async def overview(self):
        from astrbot.api.web import json_response, request

        # 默认读缓存；?fresh=1 才强制拉 HAPI。绝不 wake SSE。
        force = _query_truthy(request, "fresh")
        await soft_refresh_sessions(self.plugin, force=force)
        snap = build_sessions_snapshot(self.plugin)
        return json_response({
            "connection": snap["connection"],
            "metrics": snap["metrics"],
            "config": public_config(self.plugin),
            "plugin_version": _plugin_version(self.plugin),
            "cache": snap.get("cache"),
        })

    async def get_config(self):
        from astrbot.api.web import json_response

        return json_response({"config": public_config(self.plugin)})

    async def post_config(self):
        from astrbot.api.web import error_response, json_response, request

        payload = await request.json(default={})
        if not isinstance(payload, dict):
            return error_response("请求体必须是 JSON 对象", status_code=400)

        try:
            result = await save_plugin_config(self.plugin, payload)
        except ConfigValidationError as e:
            return error_response(str(e), status_code=400)
        except Exception as e:
            logger.exception("WebUI save config failed")
            return error_response(f"保存失败: {e}", status_code=500)

        return json_response(result)

    async def help_data(self):
        from astrbot.api.web import json_response

        return json_response(formatters.export_help_data())

    async def connection_wake(self):
        from astrbot.api.web import json_response

        was = bool(self.plugin.sse_listener._hibernated)
        self.plugin.sse_listener.wake_up()
        return json_response({
            "woken": was,
            "connection": self.plugin.sse_listener.get_connection_status(),
        })

    async def sessions_snapshot(self):
        from astrbot.api.web import json_response, request

        force = _query_truthy(request, "fresh")
        await soft_refresh_sessions(self.plugin, force=force)
        return json_response(build_sessions_snapshot(self.plugin))

    async def session_detail(self, sid: str):
        from astrbot.api.web import error_response, json_response
        from . import session_ops

        sid = (sid or "").strip()
        if not sid:
            return error_response("缺少 session id", status_code=400)
        try:
            detail = await session_ops.fetch_session_detail(self.plugin.client, sid)
        except Exception as e:
            logger.warning("WebUI session detail failed: %s", e)
            return error_response(f"获取详情失败: {e}", status_code=502)

        snap = build_sessions_snapshot(self.plugin)
        row = next((s for s in snap["sessions"] if s["id"] == sid or s["id"].startswith(sid)), None)
        flavor = (row or {}).get("flavor") or (detail.get("metadata") or {}).get("flavor") or "unknown"
        modes = flavor_profiles.permission_modes_for(flavor)
        return json_response({
            "session": row,
            "detail": detail,
            "permission_modes": modes,
            "allows_any_permission_mode": flavor_profiles.allows_any_permission_mode(flavor),
        })

    async def session_permission(self, sid: str):
        from astrbot.api.web import error_response, json_response, request
        from . import session_ops

        sid = (sid or "").strip()
        payload = await request.json(default={})
        mode = str((payload or {}).get("mode") or "").strip()
        if not sid or not mode:
            return error_response("需要 sid 与 mode", status_code=400)

        session = _find_session(self.plugin, sid)
        if not session:
            return error_response("session 不存在", status_code=404)
        flavor = str((session.get("metadata") or {}).get("flavor") or "").strip().lower() or "unknown"
        if flavor_profiles.profile_for(flavor).permission_modes is not None and not flavor_profiles.permission_modes_for(flavor):
            return error_response(f"{flavor} 不支持运行时权限切换", status_code=400)
        if not flavor_profiles.allows_any_permission_mode(flavor) and not flavor_profiles.is_permission_mode_allowed(flavor, mode):
            modes = flavor_profiles.permission_modes_for(flavor)
            return error_response(f"无效权限模式: {mode}（可用: {', '.join(modes)}）", status_code=400)

        try:
            ok, msg = await session_ops.set_permission_mode(self.plugin.client, sid, mode)
        except Exception as e:
            logger.exception("set permission failed")
            return error_response(f"切换失败: {e}", status_code=502)
        if not ok:
            return error_response(msg, status_code=502)
        try:
            await self.plugin._refresh_sessions()
        except Exception:
            pass
        return json_response({"ok": True, "message": msg, "session": _session_row(self.plugin, sid)})

    async def session_bind(self, sid: str):
        from astrbot.api.web import error_response, json_response, request

        sid = (sid or "").strip()
        payload = await request.json(default={})
        if not isinstance(payload, dict):
            return error_response("请求体必须是对象", status_code=400)
        if "umo" not in payload:
            return error_response("需要 umo 字段（string 或 null）", status_code=400)
        umo = payload.get("umo")
        if umo is not None:
            umo = str(umo).strip() or None

        session = _find_session(self.plugin, sid)
        if not session:
            # 仍允许解绑已不在列表中的 id
            if umo is not None:
                return error_response("session 不存在", status_code=404)

        try:
            if umo is None:
                await self.plugin.state_mgr.unbind_session(sid)
                message = "已解绑，通知将按推送设置投递"
            else:
                if len(umo) > 256 or ".." in umo:
                    return error_response("非法 umo", status_code=400)
                flavor = "unknown"
                if session:
                    flavor = str((session.get("metadata") or {}).get("flavor") or "unknown")
                await self.plugin.state_mgr.capture_window(sid, umo, flavor)
                message = f"已绑定到 {window_display_title(umo)}"
        except Exception as e:
            logger.exception("bind session failed")
            return error_response(f"绑定失败: {e}", status_code=500)

        return json_response({
            "ok": True,
            "message": message,
            "session": _session_row(self.plugin, sid),
            "snapshot": build_sessions_snapshot(self.plugin),
        })

    async def session_lifecycle(self, sid: str):
        from astrbot.api.web import error_response, json_response, request

        sid = (sid or "").strip()
        payload = await request.json(default={})
        action = str((payload or {}).get("action") or "").strip().lower()
        if action not in ("resume", "archive", "delete", "abort"):
            return error_response("action 必须是 resume|archive|delete|abort", status_code=400)

        try:
            result = await run_lifecycle(self.plugin, sid, action)
        except LifecycleError as e:
            return error_response(str(e), status_code=e.status)
        except Exception as e:
            logger.exception("lifecycle failed")
            return error_response(f"操作失败: {e}", status_code=502)

        return json_response(result)

    async def sessions_batch(self):
        from astrbot.api.web import error_response, json_response, request

        payload = await request.json(default={})
        if not isinstance(payload, dict):
            return error_response("请求体必须是对象", status_code=400)
        ids = payload.get("ids") or []
        action = str(payload.get("action") or "").strip().lower()
        if action not in ("resume", "archive", "delete", "abort"):
            return error_response("action 必须是 resume|archive|delete|abort", status_code=400)
        if not isinstance(ids, list) or not ids:
            return error_response("ids 必须是非空数组", status_code=400)
        if len(ids) > 50:
            return error_response("单次最多 50 个 session", status_code=400)

        results = []
        for raw in ids:
            sid = str(raw or "").strip()
            if not sid:
                results.append({"id": raw, "ok": False, "message": "空 id"})
                continue
            try:
                r = await run_lifecycle(self.plugin, sid, action)
                results.append({"id": sid, "ok": True, **{k: v for k, v in r.items() if k != "snapshot"}})
            except LifecycleError as e:
                results.append({"id": sid, "ok": False, "message": str(e)})
            except Exception as e:
                results.append({"id": sid, "ok": False, "message": str(e)})

        ok_n = sum(1 for r in results if r.get("ok"))
        return json_response({
            "ok": ok_n == len(results),
            "action": action,
            "results": results,
            "message": f"完成 {ok_n}/{len(results)}",
            "snapshot": build_sessions_snapshot(self.plugin),
        })

    async def routes_primary(self):
        from astrbot.api.web import error_response, json_response, request

        payload = await request.json(default={})
        umo = payload.get("umo")
        if umo is not None:
            umo = str(umo).strip() or None
        try:
            result = await set_primary_route(self.plugin, umo, payload.get("user_id"))
        except LifecycleError as e:
            return error_response(str(e), status_code=e.status)
        return json_response(result)

    async def routes_flavor(self):
        from astrbot.api.web import error_response, json_response, request

        payload = await request.json(default={})
        flavor = str(payload.get("flavor") or "").strip().lower()
        if not flavor:
            return error_response("需要 flavor", status_code=400)
        umo = payload.get("umo")
        if umo is not None:
            umo = str(umo).strip() or None
        try:
            result = await set_flavor_route(self.plugin, flavor, umo, payload.get("user_id"))
        except LifecycleError as e:
            return error_response(str(e), status_code=e.status)
        return json_response(result)

    async def connection_reconnect(self):
        from astrbot.api.web import error_response, json_response

        try:
            result = await reconnect_hapi(self.plugin)
        except Exception as e:
            logger.exception("reconnect failed")
            return error_response(f"重连失败: {e}", status_code=500)
        return json_response(result)


# ──── session ops helpers ────


class LifecycleError(Exception):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


def _find_session(plugin, sid: str) -> dict | None:
    for s in plugin.sessions_cache or []:
        if s.get("id") == sid:
            return s
    # prefix unique match
    matches = [s for s in (plugin.sessions_cache or []) if str(s.get("id") or "").startswith(sid)]
    if len(matches) == 1:
        return matches[0]
    return None


def _session_row(plugin, sid: str) -> dict | None:
    snap = build_sessions_snapshot(plugin)
    for s in snap["sessions"]:
        if s["id"] == sid or s["id"].startswith(sid):
            return s
    return None


async def run_lifecycle(plugin, sid: str, action: str) -> dict:
    """执行 resume|archive|delete|abort，返回结果 dict。"""
    from . import session_ops

    session = _find_session(plugin, sid)
    if session:
        sid = session["id"]
    elif action != "delete":
        # delete 允许清理残留绑定
        raise LifecycleError("session 不存在", 404)

    new_id = None
    if action == "abort":
        ok, msg = await session_ops.abort_session(plugin.client, sid)
        if not ok:
            raise LifecycleError(msg, 502)
    elif action == "archive":
        ok, msg = await session_ops.archive_session(plugin.client, sid)
        if not ok:
            raise LifecycleError(msg, 502)
    elif action == "delete":
        if session and session.get("active"):
            ok_arc, msg_arc = await session_ops.archive_session(plugin.client, sid)
            if not ok_arc:
                raise LifecycleError(f"归档失败，删除中止: {msg_arc}", 502)
        ok, msg = await session_ops.delete_session(plugin.client, sid)
        if not ok:
            raise LifecycleError(msg, 502)
        await plugin.state_mgr.unbind_session(sid)
    elif action == "resume":
        if session and session.get("active"):
            raise LifecycleError("session 已是 active，无需恢复", 400)
        old_bound = plugin.binding_mgr._session_owners.get(sid)
        old_flavor = "unknown"
        if session:
            old_flavor = str((session.get("metadata") or {}).get("flavor") or "unknown")
        ok, msg, resumed_sid = await session_ops.resume_session(plugin.client, sid)
        if not ok:
            raise LifecycleError(msg, 502)
        new_id = resumed_sid or sid
        if new_id != sid:
            # 迁移绑定
            if old_bound:
                await plugin.state_mgr.unbind_session(sid)
                await plugin.state_mgr.capture_window(new_id, old_bound, old_flavor)
        else:
            if old_bound:
                await plugin.state_mgr.capture_window(new_id, old_bound, old_flavor)
    else:
        raise LifecycleError("未知 action", 400)

    try:
        await plugin._refresh_sessions()
    except Exception as e:
        logger.warning("refresh after lifecycle failed: %s", e)

    return {
        "ok": True,
        "action": action,
        "id": sid,
        "new_id": new_id,
        "message": msg if action != "resume" else msg,
        "session": _session_row(plugin, new_id or sid),
        "snapshot": build_sessions_snapshot(plugin),
    }


def _resolve_writable_user(plugin, user_id=None) -> str:
    states = getattr(plugin.state_mgr, "_user_states_cache", {}) or {}
    known = list(states.keys())
    if user_id is not None:
        uid = str(user_id).strip()
        if uid not in states:
            raise LifecycleError(f"未知 user_id: {uid}", 400)
        return uid
    if len(known) == 0:
        raise LifecycleError("尚无已知用户；请先在聊天中使用 /hapi bind", 400)
    if len(known) > 1:
        raise LifecycleError(
            f"存在 {len(known)} 个用户路由，Web 端暂不支持改默认推送；请用聊天 /hapi bind",
            400,
        )
    return known[0]


async def set_primary_route(plugin, umo: str | None, user_id=None) -> dict:
    uid = _resolve_writable_user(plugin, user_id)
    state = dict(plugin.state_mgr._user_states_cache.get(uid, {}))
    if umo:
        if len(umo) > 256:
            raise LifecycleError("umo 过长", 400)
        state["primary_umo"] = umo
        message = f"已设置默认推送窗口为 {window_display_title(umo)}"
    else:
        state.pop("primary_umo", None)
        message = "已清除默认推送窗口"
    plugin.state_mgr._user_states_cache[uid] = state
    await plugin.put_kv_data(f"user_state_{uid}", state)
    return {
        "ok": True,
        "message": message,
        "defaults": aggregate_route_defaults(plugin),
        "snapshot": build_sessions_snapshot(plugin),
    }


async def set_flavor_route(plugin, flavor: str, umo: str | None, user_id=None) -> dict:
    from .flavor_profiles import is_bindable_flavor, normalize_flavor

    flavor = normalize_flavor(flavor)
    if not is_bindable_flavor(flavor):
        raise LifecycleError(f"非法 flavor: {flavor}", 400)
    uid = _resolve_writable_user(plugin, user_id)
    state = dict(plugin.state_mgr._user_states_cache.get(uid, {}))
    routes = plugin.state_mgr.normalized_flavor_primary_umos(state)
    if umo:
        if len(umo) > 256:
            raise LifecycleError("umo 过长", 400)
        routes[flavor] = umo
        message = f"已设置 {flavor} 推送窗口为 {window_display_title(umo)}"
    else:
        routes.pop(flavor, None)
        message = f"已清除 {flavor} 推送窗口"
    state["flavor_primary_umos"] = routes
    plugin.state_mgr._user_states_cache[uid] = state
    await plugin.put_kv_data(f"user_state_{uid}", state)
    return {
        "ok": True,
        "message": message,
        "defaults": aggregate_route_defaults(plugin),
        "snapshot": build_sessions_snapshot(plugin),
    }


async def reconnect_hapi(plugin) -> dict:
    """按当前已落盘配置重建 client 并重启 SSE。"""
    from .hapi_client import AsyncHapiClient
    from .cf_access import CfAccessManager

    endpoint = str(plugin.config.get("hapi_endpoint") or "").strip()
    token = str(plugin.config.get("access_token") or "")
    proxy = str(plugin.config.get("proxy_url") or "").strip() or None
    jwt_life = int(plugin.config.get("jwt_lifetime", 900) or 900)
    refresh_before = int(plugin.config.get("refresh_before_expiry", 180) or 180)

    cf_id = str(plugin.config.get("cf_access_client_id") or "").strip()
    cf_secret = str(plugin.config.get("cf_access_client_secret") or "").strip()
    if cf_id.lower().startswith("cf-access-client-id:"):
        cf_id = cf_id.split(":", 1)[1].strip()
    if cf_secret.lower().startswith("cf-access-client-secret:"):
        cf_secret = cf_secret.split(":", 1)[1].strip()
    cf_mgr = None
    if cf_id and cf_secret:
        cf_mgr = CfAccessManager(client_id=cf_id, client_secret=cf_secret)

    # stop SSE
    try:
        await plugin.sse_listener.stop()
    except Exception as e:
        logger.warning("stop SSE before reconnect: %s", e)

    # close old client
    try:
        await plugin.client.close()
    except Exception as e:
        logger.warning("close client before reconnect: %s", e)

    new_client = AsyncHapiClient(
        endpoint=endpoint,
        access_token=token,
        proxy_url=proxy,
        jwt_lifetime=jwt_life,
        refresh_before=refresh_before,
        cf_access_mgr=cf_mgr,
    )
    await new_client.init()
    plugin.client = new_client
    plugin.sse_listener.client = new_client

    # restart SSE with current runtime flags
    output_level = plugin.config.get("output_level", "simple")
    remind = plugin.config.get("remind_pending", True)
    remind_interval = plugin.config.get("remind_interval", 180)
    auto_approve = plugin.config.get("auto_approve_enabled", False)
    auto_approve_start = plugin.config.get("auto_approve_start", "23:00")
    auto_approve_end = plugin.config.get("auto_approve_end", "07:00")
    max_reconnect = plugin.config.get("max_reconnect_attempts", 30)
    summary_msg_count = plugin.config.get("summary_msg_count", 5)

    plugin.sse_listener._hibernated = False
    plugin.sse_listener.conn_fail_count = 0
    plugin.sse_listener.conn_error = None
    plugin.sse_listener.start(
        output_level,
        remind_pending=remind,
        remind_interval=remind_interval,
        auto_approve_enabled=auto_approve,
        auto_approve_start=auto_approve_start,
        auto_approve_end=auto_approve_end,
        summary_msg_count=summary_msg_count,
        max_reconnect_attempts=max_reconnect,
    )

    try:
        await plugin._refresh_sessions()
    except Exception as e:
        logger.warning("refresh after reconnect: %s", e)

    return {
        "ok": True,
        "message": "已按当前配置重建连接并重启 SSE",
        "connection": connection_view(plugin),
        "config": public_config(plugin),
    }


# ──── config helpers ────


class ConfigValidationError(ValueError):
    """配置校验失败。"""


def public_config(plugin) -> dict[str, Any]:
    """脱敏后的配置视图（给前端）。"""
    cfg = plugin.config
    token = str(cfg.get("access_token") or "")
    ns = None
    if ":" in token:
        ns = token.split(":", 1)[1].strip() or None

    cf_id = str(cfg.get("cf_access_client_id") or "").strip()
    out: dict[str, Any] = {}
    for key in CONFIG_KEYS:
        if key in SENSITIVE_KEYS:
            continue
        out[key] = cfg.get(key)

    out["access_token_configured"] = bool(token.strip())
    out["access_token_namespace"] = ns
    out["cf_access_client_secret_configured"] = bool(
        str(cfg.get("cf_access_client_secret") or "").strip()
    )
    out["cf_access_enabled"] = bool(cf_id)
    return out


async def save_plugin_config(plugin, patch: dict) -> dict:
    """校验 → 写 AstrBotConfig → save_config(_async) 落盘 → 热更新。

    落盘失败则整单失败，不半热更新。
    """
    cleaned = validate_config_patch(patch)
    if not cleaned:
        return {
            "saved": False,
            "changed": [],
            "reconnect_required": False,
            "config": public_config(plugin),
            "message": "没有变更",
        }

    prev = {k: plugin.config.get(k) for k in cleaned}
    for k, v in cleaned.items():
        plugin.config[k] = v

    await _persist_config(plugin)

    try:
        apply_runtime_config(plugin, cleaned)
    except Exception:
        # 落盘已成功；热更新失败只记日志，仍返回成功并提示可能需重载
        logger.exception("apply_runtime_config failed after save")

    reconnect_required = bool(RECONNECT_KEYS & set(cleaned))
    return {
        "saved": True,
        "changed": sorted(cleaned.keys()),
        "reconnect_required": reconnect_required,
        "config": public_config(plugin),
        "previous": {k: _mask_if_sensitive(k, prev[k]) for k in cleaned},
        "message": "已保存" + ("（部分项需重连 HAPI 后生效）" if reconnect_required else ""),
    }


async def _persist_config(plugin) -> None:
    """调用 AstrBotConfig 官方落盘 API。"""
    cfg = plugin.config
    save_async = getattr(cfg, "save_config_async", None)
    if callable(save_async):
        result = save_async()
        if asyncio.iscoroutine(result) or asyncio.isfuture(result):
            await result
        return
    save = getattr(cfg, "save_config", None)
    if not callable(save):
        raise RuntimeError("AstrBotConfig 无 save_config / save_config_async，无法持久化")
    result = save()
    if asyncio.iscoroutine(result) or asyncio.isfuture(result):
        await result


def validate_config_patch(patch: dict) -> dict[str, Any]:
    """返回清洗后的变更字典；空敏感字段跳过。"""
    if not isinstance(patch, dict):
        raise ConfigValidationError("请求体必须是对象")

    cleaned: dict[str, Any] = {}
    for raw_key, raw_val in patch.items():
        key = str(raw_key)
        if key not in CONFIG_KEYS:
            # 忽略前端附带的 *_configured 等只读字段
            if key.endswith("_configured") or key in (
                "access_token_namespace",
                "cf_access_enabled",
            ):
                continue
            raise ConfigValidationError(f"未知配置项: {key}")

        if key in SENSITIVE_KEYS:
            if raw_val is None:
                continue
            s = str(raw_val).strip()
            if not s:
                continue
            cleaned[key] = s
            continue

        if key in BOOL_KEYS:
            cleaned[key] = _as_bool(raw_val, key)
            continue

        if key in INT_KEYS:
            cleaned[key] = _as_int(raw_val, key)
            continue

        if key == "output_level":
            val = str(raw_val or "").strip()
            if val not in OUTPUT_LEVELS:
                raise ConfigValidationError(
                    f"output_level 必须是 {'/'.join(OUTPUT_LEVELS)}"
                )
            cleaned[key] = val
            continue

        if key in ("auto_approve_start", "auto_approve_end"):
            cleaned[key] = _as_hhmm(raw_val, key)
            continue

        if key == "quick_prefix":
            s = str(raw_val if raw_val is not None else "")
            if not s.strip():
                raise ConfigValidationError("quick_prefix 不能为空")
            if len(s) > 16:
                raise ConfigValidationError("quick_prefix 过长")
            cleaned[key] = s
            continue

        # 字符串类
        cleaned[key] = "" if raw_val is None else str(raw_val)

    if "jwt_lifetime" in cleaned and "refresh_before_expiry" in cleaned:
        if cleaned["refresh_before_expiry"] >= cleaned["jwt_lifetime"]:
            raise ConfigValidationError("refresh_before_expiry 必须小于 jwt_lifetime")
    if "summary_msg_count" in cleaned:
        n = cleaned["summary_msg_count"]
        if n < 1 or n > 50:
            raise ConfigValidationError("summary_msg_count 范围 1–50")
    if "remind_interval" in cleaned and cleaned["remind_interval"] < 30:
        raise ConfigValidationError("remind_interval 至少 30 秒")

    return cleaned


def apply_runtime_config(plugin, patch: dict) -> None:
    """把已落盘的配置同步到运行时对象（不写盘）。"""
    sse = plugin.sse_listener

    if "output_level" in patch:
        sse.output_level = patch["output_level"]
    if "summary_msg_count" in patch:
        plugin._summary_msg_count = patch["summary_msg_count"]
        sse._summary_msg_count = patch["summary_msg_count"]
    if "quick_prefix" in patch:
        plugin._quick_prefix = patch["quick_prefix"]
    if "poke_approve" in patch:
        plugin._poke_approve = patch["poke_approve"]
    if "remind_pending" in patch:
        sse._remind_enabled = patch["remind_pending"]
    if "remind_interval" in patch:
        sse._remind_interval = patch["remind_interval"]
    if "auto_approve_enabled" in patch:
        sse._auto_approve_enabled = patch["auto_approve_enabled"]
    if "auto_approve_start" in patch:
        sse._auto_approve_start = patch["auto_approve_start"]
    if "auto_approve_end" in patch:
        sse._auto_approve_end = patch["auto_approve_end"]
    if "max_reconnect_attempts" in patch:
        sse._max_reconnect = patch["max_reconnect_attempts"]


def _as_bool(val: Any, key: str) -> bool:
    if isinstance(val, bool):
        return val
    if isinstance(val, (int, float)):
        return bool(val)
    if isinstance(val, str):
        low = val.strip().lower()
        if low in ("true", "1", "yes", "on", "开启"):
            return True
        if low in ("false", "0", "no", "off", "关闭"):
            return False
    raise ConfigValidationError(f"{key} 必须是布尔值")


def _as_int(val: Any, key: str) -> int:
    try:
        n = int(val)
    except (TypeError, ValueError) as e:
        raise ConfigValidationError(f"{key} 必须是整数") from e
    if n < 0:
        raise ConfigValidationError(f"{key} 不能为负")
    return n


def _as_hhmm(val: Any, key: str) -> str:
    s = str(val or "").strip()
    parts = s.split(":")
    if len(parts) != 2:
        raise ConfigValidationError(f"{key} 格式应为 HH:MM")
    try:
        h, m = int(parts[0]), int(parts[1])
    except ValueError as e:
        raise ConfigValidationError(f"{key} 格式应为 HH:MM") from e
    if not (0 <= h <= 23 and 0 <= m <= 59):
        raise ConfigValidationError(f"{key} 时间非法")
    return f"{h:02d}:{m:02d}"


def _mask_if_sensitive(key: str, val: Any) -> Any:
    if key in SENSITIVE_KEYS:
        return "***" if val else ""
    return val


def _plugin_version(plugin) -> str:
    # metadata / register 第四参；fallback 读 metadata 不强制
    ver = getattr(plugin, "version", None) or plugin.config.get("_version")
    if ver:
        return str(ver)
    return "2.2.0"


# ──── snapshot / routing ────


# 全量拉 HAPI sessions 的最小间隔（秒）。WebUI 轮询走缓存，不频繁打 Hub。
SESSIONS_REFRESH_TTL = 20.0


def _query_truthy(request, key: str) -> bool:
    raw = request.query.get(key)
    if raw is None:
        return False
    return str(raw).strip().lower() in ("1", "true", "yes", "on")


async def soft_refresh_sessions(plugin, *, force: bool = False) -> bool:
    """按需刷新 sessions_cache。

    - force=False：仅当缓存超过 TTL 才打 HAPI
    - 绝不调用 wake_up / 不碰 SSE 休眠状态
    返回是否实际发起了 fetch。
    """
    import time

    if not force:
        ts = float(getattr(plugin, "_sessions_cache_ts", 0) or 0)
        if ts and (time.monotonic() - ts) < SESSIONS_REFRESH_TTL:
            return False
        # 从未成功刷新过且 cache 非空：仍允许 TTL 节流；空 cache 则尝试一次
        if ts == 0 and plugin.sessions_cache:
            # 启动后 SSE 可能已增量更新 cache，不必立刻全量拉取
            plugin._sessions_cache_ts = time.monotonic()
            return False
    try:
        await plugin._refresh_sessions()
        return True
    except Exception as e:
        logger.warning("soft_refresh_sessions failed: %s", e)
        return False


def build_sessions_snapshot(plugin) -> dict:
    """与 demo store.snap() 对齐的全局快照。只读内存，不触发网络。"""
    import time

    sessions_raw = list(plugin.sessions_cache or [])
    owners = dict(plugin.binding_mgr._session_owners)
    # 只计数，不拷贝 pending 详情
    counts_fn = getattr(plugin.sse_listener, "pending_counts", None)
    pending_counts = counts_fn() if callable(counts_fn) else {
        sid: len(reqs) for sid, reqs in plugin.sse_listener.pending.items() if reqs
    }
    defaults = aggregate_route_defaults(plugin)
    conn = connection_view(plugin)
    cache_ts = float(getattr(plugin, "_sessions_cache_ts", 0) or 0)
    cache_age = (time.monotonic() - cache_ts) if cache_ts else None

    sessions = []
    for s in sessions_raw:
        sid = s.get("id")
        if not sid:
            continue
        meta = s.get("metadata") or {}
        flavor = str(meta.get("flavor") or "").strip().lower() or "unknown"
        title = formatters.get_session_title(s) if hasattr(formatters, "get_session_title") else (
            meta.get("name") or meta.get("title") or sid[:8]
        )
        path = meta.get("path") or meta.get("cwd") or meta.get("workingDirectory") or ""
        bound = owners.get(sid)
        eff_umo, layer = resolve_route_layer(sid, flavor, owners, defaults)
        pending_n = int(pending_counts.get(sid) or 0)
        sessions.append({
            "id": sid,
            "id_short": sid[:8],
            "title": title,
            "flavor": flavor,
            "path": path,
            "active": bool(s.get("active")),
            "thinking": bool(s.get("thinking")),
            "pending": pending_n,
            "permissionMode": meta.get("permissionMode") or meta.get("permission_mode") or "default",
            "modelMode": meta.get("model") or meta.get("modelMode") or "default",
            "bound_umo": bound,
            "effective_umo": eff_umo,
            "layer": layer,
        })

    columns = build_columns(sessions, defaults)
    window_options = build_window_options(owners, defaults, plugin)

    return {
        "connection": conn,
        "metrics": {
            "active": sum(1 for x in sessions if x["active"]),
            "thinking": sum(1 for x in sessions if x["thinking"]),
            "pending": sum(x["pending"] for x in sessions),
            "unrouted": sum(1 for x in sessions if x["layer"] == "none"),
            "total": len(sessions),
        },
        "sessions": sessions,
        "columns": columns,
        "defaults": defaults,
        "window_options": window_options,
        "config": public_config(plugin),
        "plugin_version": _plugin_version(plugin),
        "cache": {
            "sessions_age_sec": None if cache_age is None else round(cache_age, 1),
            "refresh_ttl_sec": SESSIONS_REFRESH_TTL,
            "from_memory": True,
        },
    }


def connection_view(plugin) -> dict:
    status = plugin.sse_listener.get_connection_status()
    endpoint = str(plugin.config.get("hapi_endpoint") or "").strip()
    host = _endpoint_host(endpoint)
    return {
        "sse_status": status["sse_status"],
        "endpoint_host": host,
        "endpoint": endpoint,
        "conn_fail_count": status["conn_fail_count"],
        "conn_error": status["conn_error"],
        "hibernated": status["hibernated"],
        "task_running": status["task_running"],
    }


def _endpoint_host(endpoint: str) -> str:
    if not endpoint:
        return "—"
    try:
        u = urlparse(endpoint)
        if u.netloc:
            return u.netloc
    except Exception:
        pass
    return endpoint[:40]


def aggregate_route_defaults(plugin) -> dict:
    """聚合 known users 的 primary / flavor 路由。

    writable: 仅当 known_users 恰有 1 个时可写（首版策略）。
    """
    states = getattr(plugin.state_mgr, "_user_states_cache", {}) or {}
    known = list(states.keys())
    primary = None
    flavor: dict[str, str] = {}
    for st in states.values():
        p = st.get("primary_umo")
        if p and not primary:
            primary = str(p)
        for fk, umo in plugin.state_mgr.normalized_flavor_primary_umos(st).items():
            flavor.setdefault(fk, umo)

    writable = len(known) == 1
    reason = ""
    if len(known) == 0:
        reason = "尚无已知用户路由；请先在聊天中使用 /hapi bind"
        writable = False
    elif len(known) > 1:
        reason = f"存在 {len(known)} 个用户路由，Web 端暂不支持改默认推送；请用聊天 /hapi bind"
        writable = False

    return {
        "primary": primary,
        "flavor": flavor,
        "writable": writable,
        "writable_reason": reason,
        "known_user_count": len(known),
    }


def resolve_route_layer(
    session_id: str,
    flavor: str,
    owners: dict[str, str],
    defaults: dict,
) -> tuple[str | None, str]:
    """返回 (effective_umo, layer)。"""
    if session_id in owners:
        return owners[session_id], "session_bind"
    fumo = (defaults.get("flavor") or {}).get(flavor)
    if fumo:
        return fumo, "flavor_default"
    primary = defaults.get("primary")
    if primary:
        return primary, "primary"
    return None, "none"


def build_columns(sessions: list[dict], defaults: dict) -> list[dict]:
    map_: dict[str, dict] = {}

    def ensure(umo: str | None) -> dict:
        key = umo or "__none__"
        if key not in map_:
            map_[key] = {
                "umo": umo,
                "title": window_display_title(umo) if umo else "未投递",
                "is_primary": bool(umo and umo == defaults.get("primary")),
                "flavors": [
                    f for f, u in (defaults.get("flavor") or {}).items() if u == umo
                ],
                "sessions": [],
            }
        return map_[key]

    if defaults.get("primary"):
        ensure(defaults["primary"])
    for u in (defaults.get("flavor") or {}).values():
        ensure(u)
    for s in sessions:
        ensure(s.get("effective_umo")).sessions.append(s)

    cols = list(map_.values())
    cols.sort(key=lambda c: (0 if c["umo"] else 1, -len(c["sessions"])))
    return cols


def build_window_options(owners: dict, defaults: dict, plugin) -> list[dict]:
    umos: set[str] = set()
    if defaults.get("primary"):
        umos.add(defaults["primary"])
    umos.update((defaults.get("flavor") or {}).values())
    umos.update(owners.values())
    # window states
    for umo in getattr(plugin.binding_mgr, "_window_states", {}) or {}:
        if umo:
            umos.add(umo)
    return [{"umo": u, "title": window_display_title(u)} for u in sorted(umos)]


def window_display_title(umo: str | None) -> str:
    if not umo:
        return "—"
    if "FriendMessage" in umo or ":Private" in umo or "private" in umo.lower():
        tail = umo.rsplit(":", 1)[-1]
        return f"私聊 · {tail}" if tail and tail != umo else "私聊"
    if "GroupMessage" in umo or "group" in umo.lower():
        tail = umo.rsplit(":", 1)[-1]
        return f"群 · {tail}" if tail and tail != umo else "群聊"
    if len(umo) > 36:
        return umo[:18] + "…" + umo[-12:]
    return umo
