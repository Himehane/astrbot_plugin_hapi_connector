/**
 * 由 webui_settings_schema.export_config_schema 生成 — 勿手改结构。
 * 重新生成: python -c "from webui_settings_schema import export_config_schema_js_module; open('pages/console/settings_schema_fallback.js','w').write(export_config_schema_js_module())"
 */
export const CONFIG_SCHEMA_FALLBACK = {
  "groups": [
    {
      "id": "connection",
      "title": "连接 HAPI",
      "nav": "连接",
      "desc": "插件要先连上 HAPI，才能列 session、收通知、发指令。连接类改完后可能自动重连 SSE。",
      "fields": [
        {
          "key": "hapi_endpoint",
          "label": "HAPI 服务地址",
          "type": "text",
          "help": "HAPI Hub 的访问地址。本机一般是 http://127.0.0.1:3006；装在别的机器就写那台的地址和端口。",
          "default": "",
          "schema_type": "string",
          "need": true,
          "placeholder": "http://127.0.0.1:3006"
        },
        {
          "key": "access_token",
          "label": "Access Token",
          "type": "text",
          "help": "HAPI 访问口令，支持 token:namespace。面板内明文显示。",
          "default": "",
          "schema_type": "string",
          "need": true
        },
        {
          "key": "proxy_url",
          "label": "代理（可选）",
          "type": "text",
          "help": "仅当 AstrBot 访问 HAPI 必须走代理时填写。支持 http:// 与 socks5h://。能直连请留空。",
          "default": "",
          "schema_type": "string",
          "placeholder": "socks5h://127.0.0.1:1080"
        }
      ],
      "advanced": {
        "title": "高级：Cloudflare Access / 重连 / JWT",
        "note": "自建直连多数不用改。HAPI 挂在 CF Access 后面，或 SSE 总断线，再展开。",
        "fields": [
          {
            "key": "cf_access_client_id",
            "label": "CF Access Client ID",
            "type": "text",
            "help": "Cloudflare Zero Trust Service Token 的 Client ID。未使用请留空。",
            "default": "",
            "schema_type": "string"
          },
          {
            "key": "cf_access_client_secret",
            "label": "CF Access Client Secret",
            "type": "password",
            "help": "与 Client ID 配对。不想改已有密钥就留空。",
            "default": "",
            "schema_type": "string",
            "sensitive": true
          },
          {
            "key": "max_reconnect_attempts",
            "label": "SSE 最大重连次数",
            "type": "number",
            "help": "断线自动重连次数；达到后休眠。0 表示一直重试。可点唤醒或发 /hapi list。",
            "default": 10,
            "schema_type": "int"
          },
          {
            "key": "jwt_lifetime",
            "label": "JWT 有效期（秒）",
            "type": "number",
            "help": "用 Access Token 换来的短期凭证寿命。默认 900。",
            "default": 900,
            "schema_type": "int"
          },
          {
            "key": "refresh_before_expiry",
            "label": "JWT 提前刷新（秒）",
            "type": "number",
            "help": "过期前多久换新。应小于 JWT 有效期。",
            "default": 180,
            "schema_type": "int"
          }
        ]
      }
    },
    {
      "id": "push",
      "title": "推送通知",
      "nav": "推送",
      "desc": "AI 干活时聊天里推多少内容。快捷前缀与戳一戳、卡片细调见「交互优化」页。",
      "fields": [
        {
          "key": "output_level",
          "label": "消息推送详细程度",
          "type": "enum_cards",
          "help": "有新输出时推到绑定窗口。越详细越容易刷屏；拿不准选「简洁」。",
          "default": "simple",
          "schema_type": "string",
          "need": true,
          "options": [
            {
              "value": "silence",
              "title": "静默",
              "desc": "几乎不推正文，主要保留权限请求等关键提醒。"
            },
            {
              "value": "simple",
              "title": "简洁（推荐）",
              "desc": "推送 AI 纯文本与系统事件，过滤工具调用细节。"
            },
            {
              "value": "summary",
              "title": "摘要",
              "desc": "任务收尾时，推送 LLM 最后几条消息（条数见下一项）。"
            },
            {
              "value": "detail",
              "title": "详细",
              "desc": "尽量实时全推，群里可能很吵。"
            }
          ]
        },
        {
          "key": "summary_msg_count",
          "label": "摘要条数",
          "type": "number",
          "help": "推送级别为「摘要」时，收尾推送 LLM 最后几条消息的条数。",
          "default": 5,
          "schema_type": "int",
          "showIf": {
            "key": "output_level",
            "eq": "summary"
          }
        },
        {
          "key": "render_mode",
          "label": "推送渲染模式",
          "type": "enum_cards",
          "help": "纯文本=原样文字；图片=下方类型渲成图片（需 Pillow）。保存后持久生效。卡片细调见「交互优化」。",
          "default": "text",
          "schema_type": "string",
          "need": true,
          "options": [
            {
              "value": "text",
              "title": "纯文本",
              "desc": "全部文字推送。"
            },
            {
              "value": "card",
              "title": "图片",
              "desc": "勾选类型渲成图片；含 Agent 对话。"
            }
          ]
        },
        {
          "key": "render_kinds",
          "label": "以下类型渲成图片",
          "type": "kind_checks",
          "help": "",
          "default": "session_list,pending,status,permission,routes,message",
          "schema_type": "string",
          "showIf": {
            "key": "render_mode",
            "eq": "card"
          }
        }
      ],
      "advanced": null
    },
    {
      "id": "approve",
      "title": "权限审批与托管",
      "nav": "审批",
      "desc": "权限申请可手动批准，也可设提醒或忙时自动放行。",
      "fields": [
        {
          "key": "remind_pending",
          "label": "待审批超时提醒",
          "type": "bool",
          "help": "防止缓存失效",
          "default": true,
          "schema_type": "bool",
          "boolLabels": [
            "关闭",
            "开启"
          ]
        },
        {
          "key": "remind_interval",
          "label": "提醒间隔（秒）",
          "type": "number",
          "help": "两次提醒之间的秒数。间隔内处理完则不再提醒。",
          "default": 180,
          "schema_type": "int",
          "showIf": {
            "key": "remind_pending",
            "eq": true
          }
        },
        {
          "key": "auto_approve_enabled",
          "label": "忙时自动批准（托管）",
          "type": "bool",
          "help": "指定时段内权限请求自动通过。有安全风险。",
          "default": false,
          "schema_type": "bool",
          "warn": "开启后，时间窗内全部权限将自动批准。",
          "boolLabels": [
            "关闭（更安全）",
            "开启托管"
          ]
        },
        {
          "key": "auto_approve_start",
          "label": "托管开始时间",
          "type": "time",
          "help": "24 小时制。",
          "default": "23:00",
          "schema_type": "string",
          "showIf": {
            "key": "auto_approve_enabled",
            "eq": true
          }
        },
        {
          "key": "auto_approve_end",
          "label": "托管结束时间",
          "type": "time",
          "help": "可跨午夜，如 23:00–07:00。",
          "default": "07:00",
          "schema_type": "string",
          "showIf": {
            "key": "auto_approve_enabled",
            "eq": true
          }
        }
      ],
      "advanced": null
    }
  ],
  "defaults": {
    "hapi_endpoint": "",
    "access_token": "",
    "proxy_url": "",
    "cf_access_client_id": "",
    "cf_access_client_secret": "",
    "max_reconnect_attempts": 10,
    "jwt_lifetime": 900,
    "refresh_before_expiry": 180,
    "output_level": "simple",
    "summary_msg_count": 5,
    "quick_prefix": ">",
    "poke_approve": true,
    "poke_action": "approve",
    "cmd_keyword_maps": "[{\"keywords\":[\"stop\",\"停\"],\"command\":\"stop\"},{\"keywords\":[\"sw\"],\"command\":\"sw\"},{\"keywords\":[\"cl\"],\"command\":\"to\",\"args\":\"1 clear\"},{\"keywords\":[\"继续\"],\"command\":\"to\",\"args\":\"1 继续\"}]",
    "remind_pending": true,
    "remind_interval": 180,
    "auto_approve_enabled": false,
    "auto_approve_start": "23:00",
    "auto_approve_end": "07:00",
    "default_notification_window": "",
    "render_mode": "text",
    "formula_mode": "off",
    "render_kinds": "session_list,pending,status,permission,routes,message",
    "card_style_preset": "terminal_light",
    "card_width": 720,
    "card_accent": "#0f6b3c",
    "card_bg": "#f7f4ea",
    "card_fg": "#14120f",
    "card_font_scale": 112,
    "card_density": "comfortable",
    "card_show_brand": false,
    "card_mono": false,
    "card_custom_css": "",
    "card_font_path": ""
  },
  "field_keys": [
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
    "render_mode",
    "render_kinds",
    "remind_pending",
    "remind_interval",
    "auto_approve_enabled",
    "auto_approve_start",
    "auto_approve_end"
  ]
};
