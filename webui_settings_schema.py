"""WebUI 设置页 schema：结构认 _conf_schema.json，详细文案/分组只在 overlay。

前端不再维护整份 SETTINGS 字段表；meta.config_schema 为唯一 UI 结构来源。
本地 mock 使用 pages/console/settings_schema_fallback.js（由本模块生成内容对齐）。
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

_ROOT = Path(__file__).resolve().parent
_CONF_SCHEMA_PATH = _ROOT / "_conf_schema.json"

# access_token 在 WebUI 明文编辑（与 public_config 策略一致）；CF secret 仍敏感
SENSITIVE_UI_KEYS = frozenset({"cf_access_client_secret"})

# ── 仅 WebUI 多出来的：分组、长文案、控件形态、条件显示 ─────────────────────
# key 必须存在于 _conf_schema.json；未写的字段若被 groups 引用，会用 schema 的 description/hint。

GROUPS: list[dict[str, Any]] = [
    {
        "id": "connection",
        "title": "连接 HAPI",
        "nav": "连接",
        "desc": "插件要先连上 HAPI，才能列 session、收通知、发指令。连接类改完后可能自动重连 SSE。",
        "fields": ["hapi_endpoint", "access_token", "proxy_url"],
        "advanced": {
            "title": "高级：Cloudflare Access / 重连 / JWT",
            "note": "自建直连多数不用改。HAPI 挂在 CF Access 后面，或 SSE 总断线，再展开。",
            "fields": [
                "cf_access_client_id",
                "cf_access_client_secret",
                "max_reconnect_attempts",
                "jwt_lifetime",
                "refresh_before_expiry",
            ],
        },
    },
    {
        "id": "push",
        "title": "推送通知",
        "nav": "推送",
        "desc": "AI 干活时聊天里推多少内容。快捷前缀与戳一戳、卡片细调见「交互优化」页。",
        "fields": [
            "output_level",
            "summary_msg_count",
            "render_mode",
            "render_kinds",
        ],
    },
    {
        "id": "approve",
        "title": "权限审批与托管",
        "nav": "审批",
        "desc": "权限申请可手动批准，也可设提醒或忙时自动放行。",
        "fields": [
            "remind_pending",
            "remind_interval",
            "auto_approve_enabled",
            "auto_approve_start",
            "auto_approve_end",
        ],
    },
]

# 字段级覆盖：只写与 schema 不同或 WebUI 专属的部分
FIELD_OVERLAY: dict[str, dict[str, Any]] = {
    "hapi_endpoint": {
        "label": "HAPI 服务地址",
        "help": "HAPI Hub 的访问地址。本机一般是 http://127.0.0.1:3006；装在别的机器就写那台的地址和端口。",
        "need": True,
        "placeholder": "http://127.0.0.1:3006",
        "control": "text",
    },
    "access_token": {
        "label": "Access Token",
        "help": "HAPI 访问口令，支持 token:namespace。面板内明文显示。",
        "need": True,
        "control": "text",
    },
    "proxy_url": {
        "label": "代理（可选）",
        "help": "仅当 AstrBot 访问 HAPI 必须走代理时填写。支持 http:// 与 socks5h://。能直连请留空。",
        "placeholder": "socks5h://127.0.0.1:1080",
        "control": "text",
    },
    "cf_access_client_id": {
        "label": "CF Access Client ID",
        "help": "Cloudflare Zero Trust Service Token 的 Client ID。未使用请留空。",
        "control": "text",
    },
    "cf_access_client_secret": {
        "label": "CF Access Client Secret",
        "help": "与 Client ID 配对。不想改已有密钥就留空。",
        "control": "password",
        "sensitive": True,
    },
    "max_reconnect_attempts": {
        "label": "SSE 最大重连次数",
        "help": "断线自动重连次数；达到后休眠。0 表示一直重试。可点唤醒或发 /hapi list。",
        "control": "number",
    },
    "jwt_lifetime": {
        "label": "JWT 有效期（秒）",
        "help": "用 Access Token 换来的短期凭证寿命。默认 900。",
        "control": "number",
    },
    "refresh_before_expiry": {
        "label": "JWT 提前刷新（秒）",
        "help": "过期前多久换新。应小于 JWT 有效期。",
        "control": "number",
    },
    "output_level": {
        "label": "消息推送详细程度",
        "help": "有新输出时推到绑定窗口。越详细越容易刷屏；拿不准选「简洁」。",
        "need": True,
        "control": "enum_cards",
        "option_meta": {
            "silence": {"title": "静默", "desc": "几乎不推正文，主要保留权限请求等关键提醒。"},
            "simple": {"title": "简洁（推荐）", "desc": "推送 AI 纯文本与系统事件，过滤工具调用细节。"},
            "summary": {"title": "摘要", "desc": "任务收尾时，推送 LLM 最后几条消息（条数见下一项）。"},
            "detail": {"title": "详细", "desc": "尽量实时全推，群里可能很吵。"},
        },
    },
    "summary_msg_count": {
        "label": "摘要条数",
        "help": "推送级别为「摘要」时，收尾推送 LLM 最后几条消息的条数。",
        "control": "number",
        "show_if": {"key": "output_level", "eq": "summary"},
    },
    "render_mode": {
        "label": "推送渲染模式",
        "help": "纯文本=原样文字；图片=下方类型渲成图片（需 Pillow）。保存后持久生效。卡片细调见「交互优化」。",
        "need": True,
        "control": "enum_cards",
        "option_meta": {
            "text": {"title": "纯文本", "desc": "全部文字推送。"},
            "card": {"title": "图片", "desc": "勾选类型渲成图片；含 Agent 对话。"},
        },
    },
    "render_kinds": {
        "label": "以下类型渲成图片",
        "help": "",
        "control": "kind_checks",
        "show_if": {"key": "render_mode", "eq": "card"},
    },
    "remind_pending": {
        "label": "待审批超时提醒",
        "help": "防止缓存失效",
        "control": "bool",
        "bool_labels": ["关闭", "开启"],
    },
    "remind_interval": {
        "label": "提醒间隔（秒）",
        "help": "两次提醒之间的秒数。间隔内处理完则不再提醒。",
        "control": "number",
        "show_if": {"key": "remind_pending", "eq": True},
    },
    "auto_approve_enabled": {
        "label": "忙时自动批准（托管）",
        "help": "指定时段内权限请求自动通过。有安全风险。",
        "control": "bool",
        "warn": "开启后，时间窗内全部权限将自动批准。",
        "bool_labels": ["关闭（更安全）", "开启托管"],
    },
    "auto_approve_start": {
        "label": "托管开始时间",
        "help": "24 小时制。",
        "control": "time",
        "show_if": {"key": "auto_approve_enabled", "eq": True},
    },
    "auto_approve_end": {
        "label": "托管结束时间",
        "help": "可跨午夜，如 23:00–07:00。",
        "control": "time",
        "show_if": {"key": "auto_approve_enabled", "eq": True},
    },
}


def load_conf_schema() -> dict[str, Any]:
    raw = json.loads(_CONF_SCHEMA_PATH.read_text(encoding="utf-8"))
    if not isinstance(raw, dict):
        raise ValueError("_conf_schema.json 必须是对象")
    return raw


def schema_defaults() -> dict[str, Any]:
    """全部配置键的 default（给 mock / public_config 兜底）。"""
    out: dict[str, Any] = {}
    for key, spec in load_conf_schema().items():
        if isinstance(spec, dict) and "default" in spec:
            out[key] = spec["default"]
    return out


def _map_control(schema_type: str, overlay: dict[str, Any], has_options: bool) -> str:
    if overlay.get("control"):
        return str(overlay["control"])
    if schema_type == "bool":
        return "bool"
    if schema_type == "int":
        return "number"
    if has_options:
        return "enum"
    return "text"


def _resolve_field(key: str, conf: dict[str, Any]) -> dict[str, Any] | None:
    spec = conf.get(key)
    if not isinstance(spec, dict):
        return None
    ov = FIELD_OVERLAY.get(key) or {}
    schema_type = str(spec.get("type") or "string")
    options_raw = spec.get("options")
    has_options = isinstance(options_raw, list) and bool(options_raw)
    control = _map_control(schema_type, ov, has_options)

    label = ov.get("label") or spec.get("description") or key
    help_text = ov.get("help")
    if help_text is None:
        help_text = spec.get("hint") or spec.get("description") or ""

    field: dict[str, Any] = {
        "key": key,
        "label": label,
        "type": control,
        "help": help_text,
        "default": spec.get("default"),
        "schema_type": schema_type,
    }
    if ov.get("need"):
        field["need"] = True
    if ov.get("placeholder"):
        field["placeholder"] = ov["placeholder"]
    if ov.get("warn"):
        field["warn"] = ov["warn"]
    if ov.get("bool_labels"):
        field["boolLabels"] = list(ov["bool_labels"])
    sensitive = bool(ov.get("sensitive")) or key in SENSITIVE_UI_KEYS
    if sensitive:
        field["sensitive"] = True
        if control == "text":
            field["type"] = "password"

    show_if = ov.get("show_if")
    if isinstance(show_if, dict) and show_if.get("key") is not None:
        field["showIf"] = {"key": show_if["key"], "eq": show_if.get("eq")}

    option_meta = ov.get("option_meta") or {}
    if has_options:
        opts = []
        for val in options_raw:
            v = str(val)
            meta = option_meta.get(v) or {}
            opts.append(
                {
                    "value": v,
                    "title": meta.get("title") or v,
                    "desc": meta.get("desc") or "",
                }
            )
        field["options"] = opts

    return field


def export_config_schema() -> dict[str, Any]:
    """供 meta.config_schema：分组 + 已解析字段（前端可直接画表单）。"""
    conf = load_conf_schema()
    groups_out: list[dict[str, Any]] = []
    all_fields: list[dict[str, Any]] = []

    for g in GROUPS:
        fields = []
        for key in g.get("fields") or []:
            f = _resolve_field(str(key), conf)
            if f:
                fields.append(f)
                all_fields.append(f)
        advanced = None
        adv_in = g.get("advanced")
        if isinstance(adv_in, dict):
            adv_fields = []
            for key in adv_in.get("fields") or []:
                f = _resolve_field(str(key), conf)
                if f:
                    adv_fields.append(f)
                    all_fields.append(f)
            advanced = {
                "title": adv_in.get("title") or "高级",
                "note": adv_in.get("note") or "",
                "fields": adv_fields,
            }
        groups_out.append(
            {
                "id": g["id"],
                "title": g.get("title") or g["id"],
                "nav": g.get("nav") or g.get("title") or g["id"],
                "desc": g.get("desc") or "",
                "fields": fields,
                "advanced": advanced,
            }
        )

    return {
        "groups": groups_out,
        "defaults": schema_defaults(),
        # 扁平列表，供 save 时枚举 key（含 advanced）
        "field_keys": [f["key"] for f in all_fields],
    }


def export_config_schema_js_module() -> str:
    """生成前端 fallback 模块源码（本地无 bridge 时用）。"""
    data = export_config_schema()
    body = json.dumps(data, ensure_ascii=False, indent=2)
    return (
        "/**\n"
        " * 由 webui_settings_schema.export_config_schema 生成 — 勿手改结构。\n"
        " * 重新生成: python -c \"from webui_settings_schema import export_config_schema_js_module; "
        "open('pages/console/settings_schema_fallback.js','w').write(export_config_schema_js_module())\"\n"
        " */\n"
        f"export const CONFIG_SCHEMA_FALLBACK = {body};\n"
    )
