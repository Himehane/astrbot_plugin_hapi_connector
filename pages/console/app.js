/**
 * HAPI Connector WebUI · pages/console
 * - AstrBot iframe：window.AstrBotPluginPage bridge
 * - 本地预览（无 bridge）：内置 mock
 * 规范见 dev-docs/plugin-pages.md
 *
 * 页面：概览 / 会话 / 交互 / 命令帮助 / 设置
 */

import { hasBridge, initBridge, createApi } from "./api.js?v=3.1.35";

/* ---------- constants ---------- */

const PERM = {
  claude: ["default", "acceptEdits", "bypassPermissions", "plan"],
  codex: ["default", "read-only", "safe-yolo", "yolo"],
  gemini: ["default", "read-only", "safe-yolo", "yolo"],
  grok: ["default", "yolo"],
  kimi: ["default", "yolo"],
  opencode: ["default", "yolo"],
  pi: ["default", "yolo"],
  cursor: ["default", "yolo"],
};

const LAYER = {
  session_bind: { text: "会话绑定", cls: "tag-layer-session_bind" },
  flavor_default: { text: "Agent 推送窗口", cls: "tag-layer-flavor_default" },
  primary: { text: "默认推送窗口", cls: "tag-layer-primary" },
  none: { text: "未投递", cls: "tag-layer-none" },
};

const UMO = {
  private: "aiocqhttp:FriendMessage:10001",
  groupA: "aiocqhttp:GroupMessage:20001",
  groupB: "aiocqhttp:GroupMessage:20002",
};

const PAGE_META = {
  overview: { title: "概览", desc: "连接状态与常用设置" },
  sessions: { title: "会话管理", desc: "Session 管理、通知投递与推送窗口设置" },
  interact: { title: "交互优化", desc: "戳一戳、快捷前缀与推送呈现（图片样式 / 预览）" },
  help: { title: "命令帮助", desc: "按功能分类的 /hapi 指令说明" },
  settings: { title: "设置", desc: "对应插件 _conf_schema.json 全部配置项" },
};

const SETTINGS = [
  {
    id: "connection",
    title: "连接 HAPI",
    nav: "连接",
    desc: "插件要先连上 HAPI，才能列 session、收通知、发指令。连接类改完后，实际接入时可能需重载插件。",
    fields: [
      {
        key: "hapi_endpoint",
        label: "HAPI 服务地址",
        type: "text",
        need: true,
        help: "HAPI Hub 的访问地址。本机一般是 http://127.0.0.1:3006；装在别的机器就写那台的地址和端口。",
        placeholder: "http://127.0.0.1:3006",
      },
      {
        key: "access_token",
        label: "Access Token",
        type: "text",
        need: true,
        help: "HAPI 访问口令，支持 token:namespace。面板内明文显示。",
      },
      {
        key: "proxy_url",
        label: "代理（可选）",
        type: "text",
        help: "仅当 AstrBot 访问 HAPI 必须走代理时填写。支持 http:// 与 socks5h://。能直连请留空。",
        placeholder: "socks5h://127.0.0.1:1080",
      },
    ],
    advanced: {
      title: "高级：Cloudflare Access / 重连 / JWT",
      note: "自建直连多数不用改。HAPI 挂在 CF Access 后面，或 SSE 总断线，再展开。",
      fields: [
        {
          key: "cf_access_client_id",
          label: "CF Access Client ID",
          type: "text",
          help: "Cloudflare Zero Trust Service Token 的 Client ID。未使用请留空。",
        },
        {
          key: "cf_access_client_secret",
          label: "CF Access Client Secret",
          type: "password",
          sensitive: true,
          help: "与 Client ID 配对。不想改已有密钥就留空。",
        },
        {
          key: "max_reconnect_attempts",
          label: "SSE 最大重连次数",
          type: "number",
          help: "断线自动重连次数；达到后休眠。0 表示一直重试。可点唤醒或发 /hapi list。",
        },
        {
          key: "jwt_lifetime",
          label: "JWT 有效期（秒）",
          type: "number",
          help: "用 Access Token 换来的短期凭证寿命。默认 900。",
        },
        {
          key: "refresh_before_expiry",
          label: "JWT 提前刷新（秒）",
          type: "number",
          help: "过期前多久换新。应小于 JWT 有效期。",
        },
      ],
    },
  },
  {
    id: "push",
    title: "推送通知",
    nav: "推送",
    desc: "AI 干活时聊天里推多少内容。快捷前缀与戳一戳见「交互」页。",
    fields: [
      {
        key: "output_level",
        label: "消息推送详细程度",
        type: "enum_cards",
        need: true,
        help: "有新输出时推到绑定窗口。越详细越容易刷屏；拿不准选「简洁」。",
        options: [
          { value: "silence", title: "静默", desc: "几乎不推正文，主要保留权限请求等关键提醒。" },
          { value: "simple", title: "简洁（推荐）", desc: "推送 AI 纯文本与系统事件，过滤工具调用细节。" },
          { value: "summary", title: "摘要", desc: "任务收尾时，推送 LLM 最后几条消息（条数见下一项）。" },
          { value: "detail", title: "详细", desc: "尽量实时全推，群里可能很吵。" },
        ],
      },
      {
        key: "summary_msg_count",
        label: "摘要条数",
        type: "number",
        help: "推送级别为「摘要」时，收尾推送 LLM 最后几条消息的条数。",
        showIf: { key: "output_level", eq: "summary" },
      },
      {
        key: "render_mode",
        label: "推送渲染模式",
        type: "enum_cards",
        need: true,
        help: "纯文本=原样文字；图片=下方类型渲成图片（需 Pillow）。保存后持久生效。",
        options: [
          { value: "text", title: "纯文本", desc: "全部文字推送。" },
          { value: "card", title: "图片", desc: "勾选类型渲成图片；含 Agent 对话。" },
        ],
      },
      {
        key: "render_kinds",
        label: "以下类型渲成图片",
        type: "kind_checks",
        help: "",
        showIf: { key: "render_mode", eq: "card" },
      },
    ],
  },
  {
    id: "approve",
    title: "权限审批与托管",
    nav: "审批",
    desc: "权限申请可手动批准，也可设提醒或忙时自动放行。",
    fields: [
      {
        key: "remind_pending",
        label: "待审批超时提醒",
        type: "bool",
        help: "防止缓存失效",
        boolLabels: ["关闭", "开启"],
      },
      {
        key: "remind_interval",
        label: "提醒间隔（秒）",
        type: "number",
        help: "两次提醒之间的秒数。间隔内处理完则不再提醒。",
        showIf: { key: "remind_pending", eq: true },
      },
      {
        key: "auto_approve_enabled",
        label: "忙时自动批准（托管）",
        type: "bool",
        help: "指定时段内权限请求自动通过。有安全风险。",
        warn: "开启后，时间窗内全部权限将自动批准。",
        boolLabels: ["关闭（更安全）", "开启托管"],
      },
      {
        key: "auto_approve_start",
        label: "托管开始时间",
        type: "time",
        help: "24 小时制。",
        showIf: { key: "auto_approve_enabled", eq: true },
      },
      {
        key: "auto_approve_end",
        label: "托管结束时间",
        type: "time",
        help: "可跨午夜，如 23:00–07:00。",
        showIf: { key: "auto_approve_enabled", eq: true },
      },
    ],
  },
];

const FLAVOR_ROUTE_KEYS = ["claude", "codex", "cursor", "gemini", "grok", "kimi", "opencode", "pi"];

const OUTPUT_LEVELS = [
  { value: "silence", title: "静默" },
  { value: "simple", title: "简洁" },
  { value: "summary", title: "摘要" },
  { value: "detail", title: "详细" },
];

/* 与 formatters.HELP_COMMANDS / HELP_TOPICS 对齐 */
const HELP_TOPICS = [
  { id: "session", name: "会话", desc: "Session 管理" },
  { id: "chat", name: "对话", desc: "对话与消息" },
  { id: "approve", name: "审批", desc: "审批与回答" },
  { id: "push", name: "通知", desc: "多会话通知管理" },
  { id: "files", name: "文件", desc: "文件操作" },
  { id: "config", name: "配置", desc: "模式与配置" },
];

const HELP_COMMANDS = [
  { topic: "session", usage: "/hapi list [all]", summary: "查看当前窗口会接收通知的 session", example: null, home: true },
  { topic: "session", usage: "/hapi list all", summary: "查看所有 session 和全局绑定状态", example: null, home: false },
  { topic: "session", usage: "/hapi sw <序号|ID前缀>", summary: "切换当前 session", example: "/hapi sw 2", home: true },
  { topic: "session", usage: "/hapi create", summary: "创建新 session", example: null, home: true },
  { topic: "session", usage: "/hapi s", summary: "查看当前 session 状态（未绑定时回退默认窗口）", example: null, home: false },
  { topic: "session", usage: "/hapi abort [序号|ID前缀]", summary: "中断 session（默认当前，别名: /hapi stop）", example: "/hapi abort 1", home: true },
  { topic: "session", usage: "/hapi archive", summary: "归档当前 session", example: null, home: false },
  { topic: "session", usage: "/hapi resume [序号|ID前缀]", summary: "恢复被 archive 的 inactive session", example: "/hapi resume 1", home: true },
  { topic: "session", usage: "/hapi rename", summary: "重命名当前 session", example: null, home: false },
  { topic: "session", usage: "/hapi delete", summary: "删除当前 session", example: null, home: false },
  { topic: "session", usage: "/hapi clean [路径前缀]", summary: "批量清理 inactive sessions", example: "/hapi clean C:/work/project", home: false },
  { topic: "chat", usage: "> 内容", summary: "快速发送到当前 session", example: "> 帮我排查这个报错", home: true },
  { topic: "chat", usage: ">N 内容", summary: "快速发送到第 N 个 session", example: ">2 继续上一个任务", home: true },
  { topic: "chat", usage: "/hapi to <序号> <内容>", summary: "发送到指定 session", example: "/hapi to 2 继续上一个任务", home: false },
  { topic: "chat", usage: "/hapi msg [轮数]", summary: "查看最近几轮消息（未绑定时回退默认窗口）", example: "/hapi msg 2", home: true },
  { topic: "approve", usage: "/hapi pending", summary: "查看当前窗口可见的待处理请求", example: null, home: true },
  { topic: "approve", usage: "/hapi a", summary: "批准全部非 question 请求，并继续回答 question", example: null, home: true },
  { topic: "approve", usage: "/hapi allow [序号]", summary: "批准全部或单个非 question 请求", example: "/hapi allow 2", home: false },
  { topic: "approve", usage: "/hapi answer [序号]", summary: "回答 question 请求", example: "/hapi answer 1", home: true },
  { topic: "approve", usage: "/hapi deny [序号]", summary: "拒绝请求", example: "/hapi deny 3", home: true },
  { topic: "approve", usage: "戳一戳机器人", summary: "执行 WebUI 配置的快捷动作（默认批准待审；可改为 list/stop 等，仅 QQ NapCat）", example: null, home: false },
  { topic: "push", usage: "/hapi bind [<flavor>]", summary: "设置当前聊天为默认推送窗口；带 flavor（如 claude/codex）时只对对应 agent 生效", example: "/hapi bind claude", home: false },
  { topic: "push", usage: "/hapi bind status", summary: "查看默认推送窗口、flavor 推送窗口和 session 绑定状态", example: null, home: false },
  { topic: "push", usage: "/hapi routes", summary: "查看当前生效的会话推送路由", example: null, home: false },
  { topic: "push", usage: "/hapi alias [过滤词]", summary: "查看指令关键词映射（匹配规则与当前条目；可按关键词/命令过滤）", example: "/hapi alias to", home: true },
  { topic: "push", usage: "/hapi bind reset", summary: "清空会话路由和窗口状态，保留默认推送窗口和 flavor 推送窗口", example: null, home: false },
  { topic: "files", usage: "/hapi files [路径]", summary: "浏览远端目录", example: "/hapi files src", home: false },
  { topic: "files", usage: "/hapi files -l [路径]", summary: "浏览目录并显示文件大小", example: "/hapi files -l .", home: false },
  { topic: "files", usage: "/hapi find <关键词>", summary: "搜索远端文件", example: "/hapi find config", home: false },
  { topic: "files", usage: "/hapi download <路径>", summary: "下载远端文件到聊天（别名: /hapi dl）", example: "/hapi dl logs/app.log", home: false },
  { topic: "files", usage: "/hapi upload [cancel]", summary: "上传文件到当前 session，支持快捷前缀附件", example: "/hapi upload", home: false },
  { topic: "config", usage: "/hapi perm [模式]", summary: "查看或切换权限模式", example: null, home: false },
  { topic: "config", usage: "/hapi plan", summary: "切换 Plan 模式（toggle）。Claude 切换 permissionMode，Codex 切换 collaborationMode", example: null, home: false },
  { topic: "config", usage: "/hapi model [模式]", summary: "查看或切换当前使用的模型（Claude / Gemini）", example: null, home: false },
  { topic: "config", usage: "/hapi effort [值]", summary: "查看或切换推理强度。Claude：auto/medium/high/max；Codex：none/minimal/low/medium/high/xhigh", example: "/hapi effort high", home: false },
  { topic: "config", usage: "/hapi output [级别]", summary: "查看或切换推送级别 silence/simple/summary/detail", example: "/hapi output summary", home: false },
  { topic: "config", usage: "/hapi remote", summary: "切换当前 session 到 remote 托管模式", example: null, home: false },
  { topic: "config", usage: "/hapi help [主题]", summary: "查看帮助，可选主题：会话/对话/审批/通知/文件/配置/全部", example: "/hapi help 文件", home: false },
];

/* ---------- utils ---------- */

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const esc = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const attr = (s) => esc(s).replace(/'/g, "&#39;");

function parseUmo(u) {
  const raw = String(u || "").trim();
  if (!raw) return { platform: "", kindLabel: "窗口", sid: "" };
  const parts = raw.split(":");
  const platform = parts[0] || "bot";
  const msgType = parts[1] || "";
  const sid = parts.length >= 3 ? parts.slice(2).join(":") : parts[1] || raw;
  const mt = msgType.toLowerCase();
  let kindLabel = "窗口";
  if (mt.includes("group") || msgType === "GroupMessage") kindLabel = "群聊";
  else if (mt.includes("friend") || mt.includes("private") || msgType === "FriendMessage")
    kindLabel = "私聊";
  else if (mt.includes("channel") || mt.includes("guild")) kindLabel = "频道";
  else if (msgType) kindLabel = msgType;
  return { platform, kindLabel, sid };
}

function wTitle(u) {
  if (!u) return "—";
  const opt = (state.data?.window_options || []).find((w) => w.umo === u);
  // 后端已生成 Bot:平台-群聊/私聊-名称|ID
  if (opt?.title) return opt.title;
  const { platform, kindLabel, sid } = parseUmo(u);
  const name = opt?.name || "";
  const tail = name || sid || u;
  return `Bot:${platform || "bot"}-${kindLabel}-${tail}`;
}

function resolve(s, owners, defaults) {
  if (s.forceNone) return { umo: null, layer: "none" };
  if (owners[s.id]) return { umo: owners[s.id], layer: "session_bind" };
  const f = defaults.flavor[s.flavor];
  if (f) return { umo: f, layer: "flavor_default" };
  if (defaults.primary) return { umo: defaults.primary, layer: "primary" };
  return { umo: null, layer: "none" };
}

function statusLabel(s) {
  if (s.thinking) return "思考中";
  if (s.active) return "运行中";
  return "已归档";
}

function pill(s) {
  if (s.thinking) return `<span class="tag tag-warn">思考中</span>`;
  if (s.active) return `<span class="tag tag-ok">运行中</span>`;
  return `<span class="tag tag-muted">已归档</span>`;
}

function layerTag(layer) {
  const L = LAYER[layer] || LAYER.none;
  return `<span class="tag ${L.cls}">${esc(L.text)}</span>`;
}

/* ---------- mock store ---------- */

function createStore() {
  const sessions = [
    {
      id: "a1b2c3d4e5f67890",
      title: "重构鉴权中间件",
      flavor: "claude",
      path: "/home/dev/proj-auth",
      active: true,
      thinking: true,
      pending: 2,
      permissionMode: "default",
      modelMode: "opus",
    },
    {
      id: "b2c3d4e5f6789012",
      title: "补 session 列表单测",
      flavor: "claude",
      path: "/home/dev/proj-auth",
      active: true,
      thinking: false,
      pending: 0,
      permissionMode: "acceptEdits",
      modelMode: "sonnet",
    },
    {
      id: "c3d4e5f678901234",
      title: "API 文档生成",
      flavor: "codex",
      path: "/home/dev/docs-site",
      active: true,
      thinking: false,
      pending: 1,
      permissionMode: "default",
      modelMode: "default",
    },
    {
      id: "d4e5f67890123456",
      title: "scratch 实验",
      flavor: "claude",
      path: "/tmp/scratch",
      active: false,
      thinking: false,
      pending: 0,
      permissionMode: "default",
      modelMode: "default",
    },
    {
      id: "e5f6789012345678",
      title: "杂项脚本",
      flavor: "opencode",
      path: "/home/dev/misc",
      active: true,
      thinking: false,
      pending: 0,
      permissionMode: "default",
      modelMode: "default",
    },
    {
      id: "f678901234567890",
      title: "Gemini 旧任务",
      flavor: "gemini",
      path: "/orphan",
      active: false,
      thinking: false,
      pending: 0,
      permissionMode: "default",
      modelMode: "default",
      forceNone: true,
    },
  ];
  const owners = {
    a1b2c3d4e5f67890: UMO.groupA,
    b2c3d4e5f6789012: UMO.groupA,
    c3d4e5f678901234: UMO.groupB,
  };
  const defaults = {
    primary: UMO.private,
    flavor: { claude: UMO.private, codex: UMO.groupB },
  };
  const config = {
    hapi_endpoint: "http://127.0.0.1:3006",
    access_token: "demo-token:default",
    access_token_configured: true,
    access_token_namespace: "default",
    hapi_web_url: "http://127.0.0.1:3006/?hub=http%3A%2F%2F127.0.0.1%3A3006&token=demo-token%3Adefault",
    hapi_web_url_safe: "http://127.0.0.1:3006/",
    proxy_url: "",
    cf_access_client_id: "",
    cf_access_enabled: false,
    cf_access_client_secret_configured: false,
    max_reconnect_attempts: 10,
    jwt_lifetime: 900,
    refresh_before_expiry: 180,
    output_level: "simple",
    summary_msg_count: 5,
    quick_prefix: ">",
    poke_approve: true,
    poke_action: "approve",
    poke_actions: [
      { id: "approve", label: "批准待审", desc: "批准当前窗口可见的非 question 权限请求", cmd: "/hapi a", emoji: "✅" },
      { id: "pending", label: "查看待审", desc: "列出当前窗口待审批请求", cmd: "/hapi pending", emoji: "📋" },
      { id: "list", label: "会话列表", desc: "列出当前窗口可见的 session", cmd: "/hapi list", emoji: "☰" },
      { id: "status", label: "当前状态", desc: "查看当前绑定 session 状态", cmd: "/hapi s", emoji: "◎" },
      { id: "stop", label: "中止当前", desc: "中止当前窗口生效中的 session", cmd: "/hapi abort", emoji: "⏹" },
      { id: "output_cycle", label: "切换推送级别", desc: "在 silence → simple → summary → detail 间循环", emoji: "📢" },
      { id: "none", label: "仅确认（无业务）", desc: "提示已收到戳一戳，不执行业务动作", emoji: "👋" },
    ],
    cmd_keyword_maps: JSON.stringify([
      { keywords: ["stop", "停"], command: "stop" },
      { keywords: ["sw"], command: "sw" },
      { keywords: ["cl"], command: "to", args: "1 clear" },
      { keywords: ["继续"], command: "to", args: "1 继续" },
    ]),
    cmd_keyword_maps_list: [
      { keywords: ["stop", "停"], command: "stop", args: "" },
      { keywords: ["sw"], command: "sw", args: "" },
      { keywords: ["cl"], command: "to", args: "1 clear" },
      { keywords: ["继续"], command: "to", args: "1 继续" },
    ],
    remind_pending: true,
    remind_interval: 180,
    auto_approve_enabled: false,
    auto_approve_start: "23:00",
    auto_approve_end: "07:00",
    default_notification_window: "",
    render_mode: "text",
    formula_mode: "off",
    render_kinds: "session_list,pending,status,permission,routes,message",
    render_kinds_list: ["session_list", "pending", "status", "permission", "routes", "message"],
    card_style_preset: "terminal_light",
    card_width: 720,
    card_accent: "#0f6b3c",
    card_bg: "#f7f4ea",
    card_fg: "#14120f",
    card_font_scale: 112,
    card_density: "comfortable",
    card_show_brand: false,
    card_mono: false,
    card_custom_css: "",
    card_font_path: "",
    render_engine: {
      pillow: false,
      install_hint: "pip install Pillow",
      installable: [
        { id: "font_noto_sc", group: "font", label: "中文字体 Noto Sans SC", desc: "下载到插件 assets/fonts/", installed: false },
        { id: "dep_pillow", group: "dep", label: "Pillow（出图引擎）", desc: "pip install Pillow", installed: false },
      ],
    },
    card_style: {
      preset: "terminal_light",
      width: 720,
      bg: "#f7f4ea",
      fg: "#14120f",
      accent: "#0f6b3c",
      density: "comfortable",
      show_brand: false,
      mono: false,
      font_scale: 1.12,
    },
  };
  const conn = { sse_status: "connected", conn_fail_count: 0, conn_error: null };

  function list() {
    return sessions.map((s) => {
      const r = resolve(s, owners, defaults);
      return {
        ...s,
        id_short: s.id.slice(0, 8),
        bound_umo: owners[s.id] || null,
        effective_umo: r.umo,
        layer: r.layer,
      };
    });
  }

  function columns() {
    const rows = list();
    const map = new Map();
    const ensure = (umo) => {
      const k = umo || "__none__";
      if (!map.has(k)) {
        map.set(k, {
          umo,
          title: umo ? wTitle(umo) : "未投递",
          is_primary: umo === defaults.primary,
          flavors: Object.entries(defaults.flavor)
            .filter(([, v]) => v === umo)
            .map(([f]) => f),
          sessions: [],
        });
      }
      return map.get(k);
    };
    ensure(defaults.primary);
    for (const u of Object.values(defaults.flavor)) ensure(u);
    for (const u of Object.values(owners)) ensure(u);
    for (const s of rows) ensure(s.effective_umo).sessions.push(s);
    return [...map.values()].sort((a, b) => {
      if (!a.umo) return 1;
      if (!b.umo) return -1;
      return b.sessions.length - a.sessions.length;
    });
  }

  function umos() {
    return [...new Set([defaults.primary, ...Object.values(defaults.flavor), ...Object.values(owners)])]
      .filter(Boolean)
      .map((u) => ({ umo: u, title: wTitle(u) }));
  }

  return {
    snap() {
      const rows = list();
      return {
        connection: { ...conn, endpoint_host: "127.0.0.1:3006" },
        metrics: {
          active: rows.filter((s) => s.active).length,
          thinking: rows.filter((s) => s.thinking).length,
          pending: rows.reduce((n, s) => n + s.pending, 0),
          unrouted: rows.filter((s) => s.layer === "none").length,
          total: rows.length,
        },
        sessions: rows,
        columns: columns(),
        defaults: { primary: defaults.primary, flavor: { ...defaults.flavor } },
        window_options: umos(),
        config: { ...config },
      };
    },
    bind(sid, umo) {
      if (!umo) delete owners[sid];
      else {
        owners[sid] = umo;
        const s = sessions.find((x) => x.id === sid);
        if (s) s.forceNone = false;
      }
    },
    setPermission(sid, mode) {
      const s = sessions.find((x) => x.id === sid);
      if (s) s.permissionMode = mode;
    },
    setDefault(kind, umo) {
      if (kind === "primary") defaults.primary = umo || null;
      else if (umo) defaults.flavor[kind] = umo;
      else delete defaults.flavor[kind];
    },
    lifecycle(sid, action) {
      const idx = sessions.findIndex((x) => x.id === sid);
      if (idx < 0) return {};
      const s = sessions[idx];
      if (action === "resume") {
        const newId = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
        const bound = owners[sid] || null;
        sessions[idx] = { ...s, id: newId, active: true, thinking: false, forceNone: false };
        delete owners[sid];
        if (bound) owners[newId] = bound;
        return { new_id: newId };
      }
      if (action === "archive") {
        s.active = false;
        s.thinking = false;
      }
      if (action === "delete") {
        sessions.splice(idx, 1);
        delete owners[sid];
      }
      return {};
    },
    saveConfig(patch) {
      for (const [k, v] of Object.entries(patch)) {
        if ((k === "access_token" || k === "cf_access_client_secret") && !v) continue;
        if (k === "access_token") {
          config.access_token_configured = true;
          if (String(v).includes(":")) config.access_token_namespace = String(v).split(":")[1];
          continue;
        }
        if (k === "cf_access_client_secret") {
          config.cf_access_client_secret_configured = true;
          continue;
        }
        if (k === "cf_access_client_id") {
          config.cf_access_client_id = v;
          config.cf_access_enabled = Boolean(String(v || "").trim());
          continue;
        }
        if (k === "cmd_keyword_maps" || k === "cmd_keyword_maps_list") {
          const maps = (Array.isArray(v)
            ? v
            : typeof v === "string"
              ? (() => {
                  try {
                    return JSON.parse(v || "[]");
                  } catch (_) {
                    return [];
                  }
                })()
              : []
          ).map((m) => {
            const entry = {
              keywords: [...(m.keywords || [])],
              command: m.command || "",
            };
            if (m.args) entry.args = m.args;
            return entry;
          });
          config.cmd_keyword_maps_list = maps;
          config.cmd_keyword_maps = JSON.stringify(maps);
          continue;
        }
        config[k] = v;
      }
    },
    wake() {
      conn.sse_status = "connected";
      conn.conn_fail_count = 0;
      conn.conn_error = null;
    },
    hibernate() {
      conn.sse_status = "hibernated";
      conn.conn_fail_count = 10;
      conn.conn_error = "达到重连上限";
    },
  };
}

/* ---------- state ---------- */

const store = createStore();
const state = {
  page: "overview",
  focusWindow: null,
  selected: new Set(),
  draft: null,
  settingsSection: "connection",
  helpTopic: "session",
  helpQuery: "",
  data: null,
};

function ruleText() {
  return "";
}

/* ---------- 会话页：可见推送窗口（本页列表/下拉，localStorage） ---------- */

const WIN_VIS_KEY = "hapi_console_hidden_windows";

function loadHiddenWindows() {
  try {
    const raw = localStorage.getItem(WIN_VIS_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return new Set();
    return new Set(arr.map((x) => String(x || "").trim()).filter(Boolean));
  } catch (_) {
    return new Set();
  }
}

function saveHiddenWindows(hiddenSet) {
  try {
    localStorage.setItem(WIN_VIS_KEY, JSON.stringify([...hiddenSet]));
  } catch (_) {
    /* ignore quota */
  }
}

/** 本页下拉/左侧是否显示该窗口。keep 里的 umo 始终保留（当前已选值）。 */
function isWindowShown(umo, keep = null) {
  if (!umo) return true;
  const u = String(umo);
  if (keep && (keep === u || (keep instanceof Set && keep.has(u)))) return true;
  return !loadHiddenWindows().has(u);
}

/** 合并 window_options + columns，去重，供管理弹窗 / 下拉用 */
function allKnownWindows() {
  const map = new Map();
  for (const w of state.data?.window_options || []) {
    if (w?.umo) map.set(String(w.umo), { umo: String(w.umo), title: w.title || wTitle(w.umo) });
  }
  for (const col of state.data?.columns || []) {
    if (!col?.umo) continue;
    const u = String(col.umo);
    if (!map.has(u)) map.set(u, { umo: u, title: col.title || wTitle(u) });
  }
  return [...map.values()].sort((a, b) => String(a.title).localeCompare(String(b.title), "zh"));
}

/** 本页下拉选项（隐藏的不出现；keep 里的已选值强制保留） */
function visibleWindowOptions(keepUmos = []) {
  const keep = new Set((keepUmos || []).filter(Boolean).map(String));
  return allKnownWindows().filter((w) => isWindowShown(w.umo, keep));
}

function groupWindowsByBot(wins) {
  const groups = new Map();
  for (const w of wins) {
    const { platform } = parseUmo(w.umo);
    const bot = platform || "其它";
    if (!groups.has(bot)) groups.set(bot, []);
    groups.get(bot).push(w);
  }
  return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0], "zh"));
}

function bindSelect(s) {
  const opts = visibleWindowOptions([s.bound_umo])
    .map(
      (w) =>
        `<option value="${attr(w.umo)}" ${s.bound_umo === w.umo ? "selected" : ""}>${esc(w.title)}</option>`,
    )
    .join("");
  return `<option value="" ${s.bound_umo ? "" : "selected"}>按推送设置</option>${opts}`;
}

/* ---------- shell render ---------- */

/** 连接状态文案：插件 SSE，不是浏览器直连 HAPI */
function connLabel(c) {
  const st = c?.sse_status || "disconnected";
  if (st === "connected") return "已连接";
  if (st === "hibernated") return "已休眠";
  if (st === "reconnecting") return "重连中";
  if (st === "disconnected") return "未连接";
  return st;
}

function connIsOk(c) {
  return c?.sse_status === "connected";
}

function renderTopConn() {
  const c = state.data?.connection || {};
  const ok = connIsOk(c);
  const label = connLabel(c);
  const host = c.endpoint_host || "—";

  $("#top-conn").className = `conn-chip ${ok ? "ok" : "bad"}`;
  $("#top-conn").innerHTML = `<span class="dot"></span>${esc(label)} · ${esc(host)}`;

  const foot = $("#sidebar-conn");
  foot.className = `sidebar-footer ${ok ? "ok" : "bad"}`;
  $("#sidebar-conn-text").textContent = label;
}

function renderAlert() {
  const c = state.data?.connection || {};
  const el = $("#alert");
  if (c.sse_status === "hibernated") {
    el.hidden = false;
    el.innerHTML = `<div class="alert alert-danger">
      <span>插件 SSE 已休眠（失败 ${c.conn_fail_count || 0} 次）${c.conn_error ? " · " + esc(c.conn_error) : ""}。这是插件↔HAPI 的连接，不是网页本身。</span>
      <button type="button" class="btn btn-sm" id="btn-wake">唤醒</button>
    </div>`;
    $("#btn-wake").onclick = async () => {
      try {
        if (liveMode && api) await api.wake();
        else store.wake();
        await refresh();
      } catch (e) {
        toast("唤醒失败: " + (e.message || e));
      }
    };
  } else if (c.sse_status === "reconnecting" && c.conn_error) {
    el.hidden = false;
    el.innerHTML = `<div class="alert alert-danger">
      <span>插件 SSE 重连中（失败 ${c.conn_fail_count || 0} 次）· ${esc(c.conn_error)}</span>
    </div>`;
  } else if (c.sse_status === "disconnected") {
    el.hidden = false;
    el.innerHTML = `<div class="alert alert-danger">
      <span>插件 SSE 未启动${c.conn_error ? " · " + esc(c.conn_error) : "（插件可能未完成 initialize，或配置未连上 HAPI）"}。可点「按配置重连 HAPI」或重载插件。</span>
    </div>`;
  } else if (state.data?.error) {
    el.hidden = false;
    el.innerHTML = `<div class="alert alert-danger"><span>部分数据加载异常: ${esc(state.data.error)}</span></div>`;
  } else {
    el.hidden = true;
    el.innerHTML = "";
  }
}

function setPageChrome(page) {
  const meta = PAGE_META[page] || PAGE_META.overview;
  $("#page-title").textContent = meta.title;
  $("#page-desc").textContent = meta.desc;
  $$("#nav .side-link").forEach((b) => {
    b.classList.toggle("is-active", b.dataset.page === page);
  });
  $$(".view").forEach((v) => {
    v.hidden = v.dataset.view !== page;
  });
}

function closeSidebar() {
  $("#app")?.classList.remove("sidebar-open");
  const scrim = $("#scrim");
  if (scrim) scrim.hidden = true;
}

function go(page) {
  // 旧书签 #hub 等：回落到概览
  if (page === "hub") page = "overview";
  state.page = page;
  setPageChrome(page);
  closeSidebar();
  if (page === "overview") renderOverview();
  else if (page === "sessions") renderSessions();
  else if (page === "interact") renderInteract();
  else if (page === "help") renderHelp();
  else if (page === "settings") renderSettings();
  else renderOverview();
}

/* refresh() defined later as async in data layer */

/* ---------- overview ---------- */

function renderOverview() {
  if (!state.data) return;
  renderTopConn();
  renderAlert();
  ensureFxLayer();

  const c = state.data.connection || {};
  const m = state.data.metrics || {};
  const cfg = state.data.config || {};
  const def = state.data.defaults || { primary: null, flavor: {}, writable: false };
  const winOptsList = Array.isArray(state.data.window_options) ? state.data.window_options : [];
  const ok = connIsOk(c);
  const label = connLabel(c);
  const primaryTitle = def.primary ? wTitle(def.primary) : "未设置";
  const routeWritable = def.writable !== false;

  const levelOpts = OUTPUT_LEVELS.map(
    (o) =>
      `<option value="${o.value}" ${cfg.output_level === o.value ? "selected" : ""}>${esc(o.title)}</option>`,
  ).join("");

  const primarySelectOpts =
    `<option value="">未设置</option>` +
    winOptsList
      .map(
        (w) =>
          `<option value="${attr(w.umo)}" ${def.primary === w.umo ? "selected" : ""}>${esc(w.title || wTitle(w.umo))}</option>`,
      )
      .join("");

  $("#view-overview").innerHTML = `
    <div class="metric-grid">
      <div class="metric ${ok ? "ok" : "danger"}">
        <div class="label">连接</div>
        <div class="value" style="font-size:1.1rem">${esc(label)}</div>
      </div>
      <div class="metric">
        <div class="label">运行中</div>
        <div class="value">${m.active}</div>
      </div>
      <div class="metric">
        <div class="label">思考中</div>
        <div class="value">${m.thinking}</div>
      </div>
      <div class="metric ${m.pending ? "warn" : ""}">
        <div class="label">待审批</div>
        <div class="value">${m.pending}</div>
      </div>
      <div class="metric ${m.unrouted ? "danger" : ""}">
        <div class="label">未投递</div>
        <div class="value">${m.unrouted}</div>
      </div>
      <div class="metric">
        <div class="label">Session</div>
        <div class="value">${m.total}</div>
      </div>
    </div>

    <div class="card card-fx">
      <div class="card-head">
        <div>
          <h2>常用设置</h2>
          <p class="sub">改完立即写入插件配置；完整项在「设置」</p>
        </div>
        <button type="button" class="linkish" data-go="settings">全部设置 →</button>
      </div>
      <div class="quick-settings">
        <label class="qs-field">
          <span class="qs-label">推送详细程度</span>
          <select id="qs-level" class="ctrl">${levelOpts}</select>
        </label>
        ${
          cfg.output_level === "summary"
            ? `<label class="qs-field">
          <span class="qs-label">摘要条数</span>
          <input id="qs-summary" class="ctrl" type="number" min="1" max="50" value="${attr(cfg.summary_msg_count)}" />
        </label>`
            : ""
        }
        <div class="qs-field qs-bool">
          <span class="qs-label">戳一戳快捷</span>
          <label class="switch">
            <input id="qs-poke" type="checkbox" ${cfg.poke_approve ? "checked" : ""} />
            <span class="switch-track" aria-hidden="true"></span>
            <span class="switch-text">${cfg.poke_approve ? "开启" : "关闭"}</span>
          </label>
        </div>
        <div class="qs-field qs-bool">
          <span class="qs-label">忙时托管审批</span>
          <label class="switch">
            <input id="qs-auto" type="checkbox" ${cfg.auto_approve_enabled ? "checked" : ""} />
            <span class="switch-track" aria-hidden="true"></span>
            <span class="switch-text">${cfg.auto_approve_enabled ? "开启托管" : "关闭"}</span>
          </label>
        </div>
        <label class="qs-field">
          <span class="qs-label">托管开始</span>
          <input id="qs-auto-start" class="ctrl" type="time" value="${attr(cfg.auto_approve_start || "23:00")}" />
        </label>
        <label class="qs-field">
          <span class="qs-label">托管结束</span>
          <input id="qs-auto-end" class="ctrl" type="time" value="${attr(cfg.auto_approve_end || "07:00")}" />
        </label>
        <div class="qs-field qs-note">
          <span class="qs-label">说明</span>
          <span class="qs-note-text">${
            cfg.auto_approve_enabled
              ? "时段内权限请求将自动批准，可跨午夜（如 23:00–07:00）"
              : "时间始终可改；开启托管后，该时段内权限请求将自动批准"
          }</span>
        </div>
      </div>
    </div>

    <div class="card card-fx">
      <div class="card-head">
        <div>
          <h2>连接信息</h2>
          <p class="sub">插件当前配置与 SSE 状态</p>
        </div>
        <div class="card-head-actions">
          <button type="button" class="btn btn-sm" id="btn-reconnect">重连</button>
          <button type="button" class="linkish" data-go="settings">改连接 →</button>
        </div>
      </div>
      <dl class="kv">
        <dt>Endpoint</dt><dd>${esc(cfg.hapi_endpoint || c.endpoint || c.endpoint_host || "—")}</dd>
        <dt>Token</dt><dd class="mono break">${esc(cfg.access_token || "—")}</dd>
        <dt>HAPI 网页</dt>
        <dd>${
          cfg.hapi_web_url
            ? `<a class="ext-link mono break" href="${attr(cfg.hapi_web_url)}" target="_blank" rel="noopener noreferrer">${esc(cfg.hapi_web_url)}</a>`
            : `<span class="muted">未配置地址</span>`
        }</dd>
        <dt>插件 SSE</dt><dd>${esc(label)}${c.stream_live ? " · 流活跃" : ""}${c.task_running === false ? " · 任务未运行" : ""}</dd>
        <dt>推送级别</dt><dd>${esc(cfg.output_level || "—")}</dd>
        <dt>默认推送窗口</dt>
        <dd class="kv-stack">
          <div class="primary-now mono break">${esc(primaryTitle)}</div>
          <select id="qs-primary" class="ctrl ctrl-sm" ${routeWritable ? "" : "disabled"} title="${attr(def.writable_reason || "")}">${primarySelectOpts}</select>
          ${
            !winOptsList.length
              ? `<span class="muted xs">尚无聊天窗口记录，请先在聊天里 /hapi bind</span>`
              : !routeWritable
                ? `<span class="muted xs">${esc(def.writable_reason || "当前不可改")}</span>`
                : `<span class="muted xs">与「会话管理」中的默认推送窗口同步</span>`
          }
        </dd>
        ${c.conn_error ? `<dt>最近错误</dt><dd>${esc(c.conn_error)}</dd>` : ""}
      </dl>
    </div>
  `;

  const applyQuick = async (patch) => {
    try {
      if (liveMode && api) {
        const res = await api.saveConfig(patch);
        if (res?.message) toast(res.message);
      } else {
        store.saveConfig(patch);
      }
      if (state.draft) Object.assign(state.draft, patch);
      await refresh({ silent: true, repaint: true });
    } catch (e) {
      toast("保存失败: " + (e.message || e));
    }
  };

  $("#qs-level").onchange = () => applyQuick({ output_level: $("#qs-level").value });
  $("#qs-summary") && ($("#qs-summary").onchange = () => applyQuick({ summary_msg_count: Number($("#qs-summary").value) || 5 }));
  $("#qs-poke") &&
    ($("#qs-poke").onchange = () => {
      const on = $("#qs-poke").checked;
      const txt = $("#qs-poke").closest(".switch")?.querySelector(".switch-text");
      if (txt) txt.textContent = on ? "开启" : "关闭";
      applyQuick({ poke_approve: on });
    });
  $("#qs-auto") &&
    ($("#qs-auto").onchange = () => {
      const on = $("#qs-auto").checked;
      const txt = $("#qs-auto").closest(".switch")?.querySelector(".switch-text");
      if (txt) txt.textContent = on ? "开启托管" : "关闭";
      applyQuick({ auto_approve_enabled: on });
    });
  $("#qs-auto-start") &&
    ($("#qs-auto-start").onchange = () => applyQuick({ auto_approve_start: $("#qs-auto-start").value || "23:00" }));
  $("#qs-auto-end") &&
    ($("#qs-auto-end").onchange = () => applyQuick({ auto_approve_end: $("#qs-auto-end").value || "07:00" }));

  $("#qs-primary") &&
    ($("#qs-primary").onchange = async () => {
      const umo = $("#qs-primary").value || null;
      try {
        if (liveMode && api) {
          const res = await api.setPrimaryRoute(umo);
          toast(res?.message || "已更新默认推送窗口");
        } else {
          store.setDefault("primary", umo);
          toast("已更新默认推送窗口");
        }
        await refresh({ silent: true, repaint: true });
      } catch (e) {
        toast("更新失败: " + (e.message || e));
      }
    });

  $$("#view-overview [data-go]").forEach((b) => {
    b.onclick = () => go(b.dataset.go);
  });
  $("#btn-reconnect")?.addEventListener("click", async () => {
    if (!confirm("按当前已保存配置重建连接并重启 SSE？")) return;
    try {
      if (liveMode && api) {
        const res = await api.reconnect();
        toast(res.message || "已重连");
        await refresh();
      } else {
        store.wake();
        toast("已模拟重连");
        await refresh();
      }
    } catch (e) {
      toast("重连失败: " + (e.message || e));
    }
  });
}

/** 全局终端粒子 / CRT 层：只挂一次，不挡点击 */
function ensureFxLayer() {
  if (document.getElementById("fx-layer")) return;
  const layer = document.createElement("div");
  layer.id = "fx-layer";
  layer.className = "fx-layer";
  layer.setAttribute("aria-hidden", "true");
  const dots = Array.from({ length: 48 }, (_, i) => {
    const left = ((i * 41 + (i % 7) * 3) % 100) + (i % 5) * 0.25;
    const delay = ((i * 0.37) % 10).toFixed(2);
    const dur = (8 + (i % 9) * 1.35).toFixed(1);
    const size = 1 + (i % 4);
    const dx = ((i % 9) - 4) * 6;
    return `<span class="fx-dot" style="--x:${left.toFixed(1)}%;--d:${delay}s;--t:${dur}s;--s:${size}px;--dx:${dx}px"></span>`;
  }).join("");
  const blobs = Array.from({ length: 5 }, (_, i) => {
    const x = 8 + ((i * 23) % 80);
    const y = 10 + ((i * 31) % 70);
    const s = 90 + (i % 4) * 36;
    const d = (i * 1.7).toFixed(1);
    const t = (14 + i * 2.4).toFixed(1);
    const dx = (i % 2 === 0 ? 1 : -1) * (30 + i * 12);
    const dy = (i % 2 === 0 ? -1 : 1) * (18 + i * 8);
    return `<span class="fx-blob" style="--x:${x}%;--y:${y}%;--s:${s}px;--d:${d}s;--t:${t}s;--dx:${dx}px;--dy:${dy}px"></span>`;
  }).join("");
  layer.innerHTML = `
    <div class="fx-scan"></div>
    <div class="fx-beam"></div>
    <div class="fx-vignette"></div>
    <div class="fx-noise"></div>
    <div class="fx-particles">${blobs}${dots}</div>
  `;
  document.body.prepend(layer);
  document.body.classList.add("has-fx");
}

/* ---------- sessions (+ 推送路由) ---------- */
function renderRoutePanel() {
  const def = state.data?.defaults || { primary: null, flavor: {}, writable: false };
  const flavorMap = def.flavor && typeof def.flavor === "object" ? def.flavor : {};
  const allOpts = allKnownWindows();
  const winOpts = (selected) => {
    const list = visibleWindowOptions([selected]);
    return (
      `<option value="">未设置</option>` +
      list
        .map(
          (w) =>
            `<option value="${attr(w.umo)}" ${selected === w.umo ? "selected" : ""}>${esc(w.title)}</option>`,
        )
        .join("")
    );
  };

  const flavorCells = FLAVOR_ROUTE_KEYS.map(
    (f) => `<label class="route-cell">
      <span class="route-cell-label">${esc(f)} 推送窗口</span>
      <select class="ctrl-sm js-route-flavor" data-flavor="${f}">${winOpts(flavorMap[f] || "")}</select>
    </label>`,
  ).join("");

  const routeWritable = def.writable !== false;
  const routeHint =
    def.writable_reason || (allOpts.length ? "" : "尚无聊天窗口记录，请先在聊天里 /hapi bind");
  const subExtra = routeWritable
    ? ""
    : routeHint
      ? ` · ${esc(routeHint)}`
      : " · 当前只读";

  $("#route-panel").innerHTML = `
    <div class="route-panel-inner">
      <div class="route-panel-head">
        <div>
          <div class="route-panel-title">推送设置</div>
          <p class="route-panel-sub">优先按 Agent 类型推送消息；未设置则推送到默认推送窗口${subExtra}</p>
        </div>
      </div>
      <div class="route-row">
        <label class="route-cell route-cell-primary">
          <span class="route-cell-label">默认推送窗口</span>
          <select id="route-primary" class="ctrl-sm" ${routeWritable ? "" : "disabled"}>${winOpts(def.primary || "")}</select>
        </label>
        <div class="route-flavor-grid">${flavorCells}</div>
      </div>
    </div>`;

  if (!routeWritable) {
    $$(".js-route-flavor").forEach((sel) => sel.setAttribute("disabled", "disabled"));
  }
  const primarySel = $("#route-primary");
  if (primarySel) primarySel.onchange = async () => {
    const umo = $("#route-primary").value || null;
    try {
      if (liveMode && api) {
        if (!routeWritable) {
          toast(routeHint || "当前不可写路由");
          await refresh();
          return;
        }
        const res = await api.setPrimaryRoute(umo);
        toast(res.message || "已更新默认推送窗口");
        if (!applySnapFromResult(res)) await refresh();
        else { renderTopConn(); renderSessions(); }
        return;
      }
      store.setDefault("primary", umo);
      await refresh();
    } catch (err) {
      toast("更新失败: " + (err.message || err));
      await refresh();
    }
  };
  $$(".js-route-flavor").forEach((sel) => {
    sel.onchange = async () => {
      const flavor = sel.dataset.flavor;
      const umo = sel.value || null;
      try {
        if (liveMode && api) {
          if (!routeWritable) {
            toast(routeHint || "当前不可写路由");
            await refresh();
            return;
          }
          const res = await api.setFlavorRoute(flavor, umo);
          toast(res.message || `已更新 ${flavor} 推送窗口`);
          if (!applySnapFromResult(res)) await refresh();
          else { renderTopConn(); renderSessions(); }
          return;
        }
        store.setDefault(flavor, umo);
        await refresh();
      } catch (err) {
        toast("更新失败: " + (err.message || err));
        await refresh();
      }
    };
  });
}

function filteredSessions() {
  const key = state.focusWindow || "__none__";
  const all = state.data.sessions;
  if (key === "__none__") return all.filter((s) => s.layer === "none");
  return all.filter((s) => s.effective_umo === key);
}

function renderWindowList() {
  const allCols = state.data.columns || [];
  // 未投递列始终保留；有 umo 的按可见性过滤
  const cols = allCols.filter((col) => !col.umo || isWindowShown(col.umo));
  if (!state.focusWindow || !cols.some((c) => (c.umo || "__none__") === state.focusWindow)) {
    state.focusWindow = cols[0]?.umo || (cols[0] ? "__none__" : allCols[0]?.umo || "__none__");
  }

  $("#window-list").innerHTML = cols
    .map((col) => {
      const key = col.umo || "__none__";
      const on = state.focusWindow === key;
      const tags = [];
      if (col.is_primary) {
        tags.push(`<span class="tag tag-muted">默认推送窗口</span>`);
      }
      for (const f of col.flavors || []) {
        tags.push(`<span class="tag tag-layer-flavor_default">${esc(f)} 推送窗口</span>`);
      }
      return `<button type="button" data-win="${attr(key)}" class="win-item ${on ? "is-on" : ""}">
        <div class="win-item-top">
          <span class="win-item-title ${col.umo ? "" : "is-none"}">${esc(col.title)}</span>
          <span class="win-item-count">${col.sessions.length}</span>
        </div>
        <div class="win-item-umo">${esc(col.umo || "无目标")}</div>
        ${tags.length ? `<div class="win-item-tags">${tags.join("")}</div>` : ""}
      </button>`;
    })
    .join("");

  $$("#window-list [data-win]").forEach((b) => {
    b.onclick = () => {
      state.focusWindow = b.dataset.win;
      renderSessions();
    };
  });

  const btnVis = $("#btn-win-vis");
  if (btnVis) {
    const hiddenN = loadHiddenWindows().size;
    btnVis.textContent = hiddenN ? `管理可见窗口（已藏 ${hiddenN}）` : "管理可见窗口";
    btnVis.onclick = () => openWindowVisibilityDialog();
  }
}

function openWindowVisibilityDialog() {
  const wins = allKnownWindows();
  if (!wins.length) {
    toast("暂无推送窗口记录，请先在聊天里 /hapi bind");
    return;
  }
  const hidden = loadHiddenWindows();
  const groups = groupWindowsByBot(wins);

  const body = groups
    .map(([bot, list]) => {
      const shownN = list.filter((w) => !hidden.has(w.umo)).length;
      const rows = list
        .map((w) => {
          const on = !hidden.has(w.umo);
          return `<label class="win-vis-item">
            <input type="checkbox" data-vis-umo value="${attr(w.umo)}" ${on ? "checked" : ""} />
            <span class="win-vis-title">${esc(w.title)}</span>
            <span class="win-vis-umo mono">${esc(w.umo)}</span>
          </label>`;
        })
        .join("");
      return `<div class="win-vis-group" data-bot="${attr(bot)}">
        <div class="win-vis-group-head">
          <span class="win-vis-bot">Bot:${esc(bot)}</span>
          <span class="win-vis-count muted">${shownN}/${list.length}</span>
          <button type="button" class="btn btn-sm js-vis-group-all" data-bot="${attr(bot)}">全选</button>
          <button type="button" class="btn btn-sm js-vis-group-none" data-bot="${attr(bot)}">全不选</button>
        </div>
        <div class="win-vis-group-body">${rows}</div>
      </div>`;
    })
    .join("");

  $("#dlg-title").textContent = "管理可见推送窗口";
  const dlg = $("#dlg");
  dlg?.classList.add("dlg-win-vis");
  $("#dlg-body").innerHTML = `
    <p class="field-help win-vis-help">勾选的窗口会出现在本页左侧列表和推送下拉框里。按 Bot 分组；默认全部显示。设置只存在本浏览器。</p>
    <div class="win-vis-toolbar">
      <button type="button" class="btn btn-sm" id="vis-all">全部显示</button>
      <button type="button" class="btn btn-sm" id="vis-none">全部隐藏</button>
      <span class="spacer"></span>
      <button type="button" class="btn btn-primary btn-sm" id="vis-apply">应用</button>
    </div>
    <div class="win-vis-list" id="win-vis-list" tabindex="0">${body}</div>
  `;
  dlg?.showModal();
  requestAnimationFrame(() => {
    const list = $("#win-vis-list");
    if (list) {
      list.scrollTop = 0;
      try {
        list.focus({ preventScroll: true });
      } catch (_) {
        /* ignore */
      }
    }
  });
  const onClose = () => {
    dlg?.classList.remove("dlg-win-vis");
    dlg?.removeEventListener("close", onClose);
  };
  dlg?.addEventListener("close", onClose);

  const setGroup = (bot, checked) => {
    $$("#dlg-body .win-vis-group").forEach((g) => {
      if (g.dataset.bot !== bot) return;
      g.querySelectorAll("input[data-vis-umo]").forEach((inp) => {
        inp.checked = checked;
      });
    });
    refreshGroupCounts();
  };
  const refreshGroupCounts = () => {
    $$("#dlg-body .win-vis-group").forEach((g) => {
      const boxes = [...g.querySelectorAll("input[data-vis-umo]")];
      const n = boxes.filter((b) => b.checked).length;
      const el = g.querySelector(".win-vis-count");
      if (el) el.textContent = `${n}/${boxes.length}`;
    });
  };

  $$("#dlg-body .js-vis-group-all").forEach((b) => {
    b.onclick = () => setGroup(b.dataset.bot, true);
  });
  $$("#dlg-body .js-vis-group-none").forEach((b) => {
    b.onclick = () => setGroup(b.dataset.bot, false);
  });
  $$("#dlg-body input[data-vis-umo]").forEach((inp) => {
    inp.onchange = refreshGroupCounts;
  });
  $("#vis-all") &&
    ($("#vis-all").onclick = () => {
      $$("#dlg-body input[data-vis-umo]").forEach((inp) => {
        inp.checked = true;
      });
      refreshGroupCounts();
    });
  $("#vis-none") &&
    ($("#vis-none").onclick = () => {
      $$("#dlg-body input[data-vis-umo]").forEach((inp) => {
        inp.checked = false;
      });
      refreshGroupCounts();
    });
  $("#vis-apply") &&
    ($("#vis-apply").onclick = () => {
      const nextHidden = new Set();
      $$("#dlg-body input[data-vis-umo]").forEach((inp) => {
        if (!inp.checked && inp.value) nextHidden.add(inp.value);
      });
      saveHiddenWindows(nextHidden);
      $("#dlg").close();
      toast(
        nextHidden.size
          ? `已隐藏 ${nextHidden.size} 个窗口（本页列表/下拉）`
          : "已全部显示",
      );
      renderSessions();
    });
}


function renderSessPanel() {
  const key = state.focusWindow || "__none__";
  const col = state.data.columns.find((c) => (c.umo || "__none__") === key);
  $("#focus-title").textContent = col ? `推到「${col.title}」` : "Sessions";

  const rows = filteredSessions();
  const visibleIds = rows.map((s) => s.id);
  const selectedVisible = visibleIds.filter((id) => state.selected.has(id));
  const allOn = visibleIds.length > 0 && selectedVisible.length === visibleIds.length;
  const someOn = selectedVisible.length > 0 && !allOn;

  if (!rows.length) {
    $("#sess-panel").innerHTML = `<div class="empty">这个窗口下没有 session</div>`;
    return;
  }

  const groups = new Map();
  for (const s of rows) {
    if (!groups.has(s.path)) groups.set(s.path, []);
    groups.get(s.path).push(s);
  }

  let body = "";
  for (const [path, items] of groups) {
    const ids = items.map((s) => s.id);
    const folderAll = ids.every((id) => state.selected.has(id));
    const folderSome = ids.some((id) => state.selected.has(id));
    body += `<tr class="folder-row">
      <td><input type="checkbox" class="js-folder" data-path="${attr(path)}" ${folderAll ? "checked" : ""} ${
      folderSome && !folderAll ? "data-ind=1" : ""
    }/></td>
      <td colspan="4"><span class="folder-path">${esc(path)}</span> · ${items.length}</td>
    </tr>`;
    for (const s of items) {
      const checked = state.selected.has(s.id);
      const perms = (PERM[s.flavor] || ["default"])
        .map((p) => `<option value="${p}" ${p === s.permissionMode ? "selected" : ""}>${p}</option>`)
        .join("");
      body += `<tr class="sess-row ${checked ? "is-selected" : ""}" data-sid="${s.id}">
        <td><input type="checkbox" class="js-sel" data-id="${s.id}" ${checked ? "checked" : ""}/></td>
        <td>
          <div class="sess-title">${esc(s.title)}</div>
          <div class="sess-meta">
            <span>${esc(s.flavor)}</span>
            <span>${esc(s.id_short)}</span>
            ${layerTag(s.layer)}
          </div>
        </td>
        <td>${pill(s)}</td>
        <td><select class="ctrl-sm js-perm" data-id="${s.id}">${perms}</select></td>
        <td class="col-bind"><select class="ctrl-sm js-bind" data-id="${s.id}">${bindSelect(s)}</select></td>
      </tr>`;
    }
  }

  $("#sess-panel").innerHTML = `
    <div class="table-card">
      <div class="table-toolbar">
        <label class="tb-check">
          <input type="checkbox" id="sel-all" ${allOn ? "checked" : ""} ${someOn ? "data-ind=1" : ""} />
          <span>${allOn ? "取消全选" : "全选列表"}</span>
        </label>
        <button type="button" class="btn btn-sm ${selectedVisible.length ? "" : "is-ghost"}" id="sel-clear" ${
          selectedVisible.length ? "" : "disabled"
        }>已选 ${selectedVisible.length} · 清除</button>
        <span class="spacer"></span>
        <button type="button" class="btn btn-sm" data-batch="resume" ${selectedVisible.length ? "" : "disabled"}>恢复</button>
        <button type="button" class="btn btn-sm" data-batch="archive" ${selectedVisible.length ? "" : "disabled"}>归档</button>
        <button type="button" class="btn btn-sm btn-danger" data-batch="delete" ${selectedVisible.length ? "" : "disabled"}>删除</button>
      </div>
      <div class="table-wrap">
        <table class="data">
          <thead>
            <tr>
              <th class="col-check"></th>
              <th>会话</th>
              <th class="col-status">状态</th>
              <th class="col-perm">权限</th>
              <th class="col-bind">通知投递</th>
            </tr>
          </thead>
          <tbody>${body}</tbody>
        </table>
      </div>
    </div>`;

  wireTable(visibleIds);
}

function wireTable(visibleIds) {
  const selAll = $("#sel-all");
  if (selAll?.dataset.ind) selAll.indeterminate = true;
  $$(".js-folder[data-ind]").forEach((cb) => {
    cb.indeterminate = true;
  });

  selAll?.addEventListener("change", () => {
    const shouldSelect = !visibleIds.every((id) => state.selected.has(id));
    visibleIds.forEach((id) => {
      if (shouldSelect) state.selected.add(id);
      else state.selected.delete(id);
    });
    renderSessions();
  });

  $("#sel-clear")?.addEventListener("click", () => {
    visibleIds.forEach((id) => state.selected.delete(id));
    renderSessions();
  });

  $$(".js-sel").forEach((cb) => {
    cb.onchange = (e) => {
      e.stopPropagation();
      if (cb.checked) state.selected.add(cb.dataset.id);
      else state.selected.delete(cb.dataset.id);
      renderSessions();
    };
  });

  $$(".js-folder").forEach((cb) => {
    cb.onchange = (e) => {
      e.stopPropagation();
      const pathIds = state.data.sessions.filter((s) => s.path === cb.dataset.path).map((s) => s.id);
      // 仅作用于当前列表可见项
      const ids = pathIds.filter((id) => visibleIds.includes(id));
      const shouldSelect = !ids.every((id) => state.selected.has(id));
      ids.forEach((id) => {
        if (shouldSelect) state.selected.add(id);
        else state.selected.delete(id);
      });
      renderSessions();
    };
  });

  $$(".js-perm").forEach((sel) => {
    sel.onchange = async (e) => {
      e.stopPropagation();
      const sid = sel.dataset.id;
      const mode = sel.value;
      try {
        if (liveMode && api) {
          const res = await api.setPermission(sid, mode);
          toast(res.message || "权限已更新");
          if (!applySnapFromResult(res)) await refresh();
          else { renderTopConn(); renderSessions(); }
          return;
        }
        store.setPermission(sid, mode);
        await refresh();
      } catch (err) {
        toast("权限切换失败: " + (err.message || err));
        await refresh();
      }
    };
  });
  $$(".js-bind").forEach((sel) => {
    sel.onchange = async (e) => {
      e.stopPropagation();
      const sid = sel.dataset.id;
      const umo = sel.value || null;
      try {
        if (liveMode && api) {
          const res = await api.bindSession(sid, umo);
          toast(res.message || "绑定已更新");
          if (!applySnapFromResult(res)) await refresh();
          else { renderTopConn(); renderSessions(); }
          return;
        }
        store.bind(sid, umo);
        await refresh();
      } catch (err) {
        toast("绑定失败: " + (err.message || err));
        await refresh();
      }
    };
  });

  // 单击行：切换勾选；双击打开详情
  $$("tr[data-sid]").forEach((tr) => {
    tr.onclick = (e) => {
      if (e.target.closest("select,input,button,a")) return;
      const id = tr.dataset.sid;
      if (state.selected.has(id)) state.selected.delete(id);
      else state.selected.add(id);
      renderSessions();
    };
    tr.ondblclick = (e) => {
      if (e.target.closest("select,input,button,a")) return;
      openDetail(tr.dataset.sid);
    };
  });

  $$("#sess-panel [data-batch]").forEach((b) => {
    b.onclick = async (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const ids = visibleIds.filter((id) => state.selected.has(id));
      if (!ids.length) {
        toast("请先勾选 session");
        return;
      }
      const action = b.dataset.batch;
      const labels = { resume: "恢复", archive: "归档", delete: "删除" };
      const label = labels[action] || action;
      if (action === "delete" && !confirm(`删除 ${ids.length} 个 session？不可恢复。`)) return;
      if (action === "archive" && !confirm(`归档 ${ids.length} 个 session？`)) return;
      if (action === "resume" && !confirm(`恢复 ${ids.length} 个？可能得到新 session id。`)) return;

      $$("#sess-panel [data-batch]").forEach((x) => {
        x.disabled = true;
        x.classList.add("is-busy");
      });
      try {
        if (!liveMode || !api) {
          for (const id of ids) store.lifecycle(id, action);
          ids.forEach((id) => state.selected.delete(id));
          toast(`${label}完成（本地 mock）`);
          await refresh({ repaint: true });
          return;
        }
        const res = await api.batchLifecycle(ids, action);
        const results = Array.isArray(res?.results) ? res.results : [];
        const okN = results.filter((r) => r && r.ok).length;
        const failN = Math.max(0, (results.length || ids.length) - okN);
        const detail = results
          .filter((r) => r && !r.ok)
          .slice(0, 3)
          .map((r) => `${String(r.id || "").slice(0, 8)}: ${r.message || "失败"}`)
          .join("；");
        let tip = res?.message || "";
        if (!tip) {
          if (failN === 0) tip = `${label}成功 ${okN}/${results.length || ids.length}`;
          else if (okN === 0) tip = `${label}全部失败` + (detail ? ` · ${detail}` : "");
          else tip = `${label}部分成功 ${okN}/${results.length}` + (detail ? ` · ${detail}` : "");
        }
        toast(tip);
        ids.forEach((id) => state.selected.delete(id));
        // 始终 fresh 拉一次，避免 snapshot 陈旧看起来像没操作
        if (res?.snapshot) applySnapFromResult(res);
        await refresh({ fresh: true, repaint: true });
      } catch (err) {
        console.error("batch lifecycle", action, err);
        toast(`${label}失败: ` + (err.message || err));
        await refresh({ fresh: true, repaint: true });
      }
    };
  });
}

function renderSessions() {
  if (!state.data) return;
  const liveIds = new Set((state.data.sessions || []).map((s) => s.id));
  for (const id of [...state.selected]) if (!liveIds.has(id)) state.selected.delete(id);

  renderTopConn();
  renderAlert();
  renderWindowList();
  renderRoutePanel();
  renderSessPanel();
}


/* ---------- interact ---------- */

/** 图片 CSS：按图片类型拆开编辑，保存时拼回一条 card_custom_css */
const CSS_PART_DEFS = [
  {
    id: "global",
    label: "全局",
    vars: [
      "--card-bg",
      "--card-fg",
      "--card-accent",
      "--card-muted",
      "--card-border",
      "--card-code-bg",
      "--card-radius",
      "--card-pad",
      "--card-width",
      "--card-font-scale",
      "--card-title-size",
      "--card-sub-size",
      "--card-body-size",
      "--card-meta-size",
      "--card-foot-size",
      "--card-mono",
      "--card-row-pad-y",
      "--card-row-pad-x",
      "--card-row-gap",
    ],
  },
  {
    id: "session_list",
    label: "Session 列表",
    vars: [
      "--card-idx-w",
      "--card-idx-h",
      "--card-idx-font",
      "--card-idx-radius",
      "--card-idx-top",
      "--card-section-gap",
    ],
  },
  {
    id: "pending",
    label: "待审批",
    vars: [],
    note: "无独占变量，颜色/字号/行距改「全局」。",
  },
  {
    id: "status",
    label: "状态",
    vars: [
      "--card-badge-h",
      "--card-badge-pad-x",
      "--card-badge-font",
      "--card-badge-dot",
    ],
  },
  {
    id: "permission",
    label: "权限",
    vars: [],
    note: "无独占变量，颜色/字号/行距改「全局」。",
  },
  {
    id: "routes",
    label: "路由",
    vars: [],
    note: "无独占变量，颜色/字号/行距改「全局」。",
  },
  {
    id: "message",
    label: "Agent 对话",
    vars: [],
    note: "无独占变量，正文/代码底色等改「全局」。",
  },
  { id: "preview", label: "网页预览", mode: "tail" },
];

function extractCssVars(css) {
  const map = {};
  const re = /(--card-[\w-]+)\s*:\s*([^;]+);/g;
  let m;
  while ((m = re.exec(String(css || "")))) {
    map[m[1]] = m[2].trim();
  }
  return map;
}

function extractPreviewCss(css) {
  const s = String(css || "");
  const rootStart = s.indexOf(":root");
  if (rootStart < 0) return s.trim();
  const brace = s.indexOf("{", rootStart);
  if (brace < 0) return "";
  let depth = 0;
  for (let i = brace; i < s.length; i++) {
    const ch = s[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return s.slice(i + 1).trim();
    }
  }
  return "";
}

function defaultCssText() {
  return (
    (state.meta && state.meta.render && state.meta.render.default_css) ||
    DEFAULT_CARD_CSS_FALLBACK
  );
}

function formatPartVars(def, varMap, fallbackMap) {
  if (!def.vars?.length) {
    return def.note ? `/* ${def.note} */` : "/* 无独占变量 */";
  }
  return def.vars
    .map((name) => {
      const val = varMap[name] ?? fallbackMap[name];
      if (val == null || val === "") return null;
      return `  ${name}: ${val};`;
    })
    .filter(Boolean)
    .join("\n");
}

function splitCssToParts(css) {
  const src = String(css || "").trim() || defaultCssText();
  const vars = extractCssVars(src);
  const fallback = extractCssVars(defaultCssText());
  const parts = {};
  for (const def of CSS_PART_DEFS) {
    if (def.mode === "tail") {
      parts[def.id] =
        extractPreviewCss(src) ||
        extractPreviewCss(defaultCssText()) ||
        "/* 仅网页预览用选择器 */";
      continue;
    }
    parts[def.id] = formatPartVars(def, vars, fallback);
  }
  return parts;
}

function joinCssParts(parts) {
  const fallback = extractCssVars(defaultCssText());
  const merged = { ...fallback };
  // 有独占变量的块按顺序覆盖；空块忽略
  for (const def of CSS_PART_DEFS) {
    if (def.mode === "tail") continue;
    const found = extractCssVars(parts?.[def.id] || "");
    Object.assign(merged, found);
  }
  const lines = [];
  const seen = new Set();
  for (const def of CSS_PART_DEFS) {
    if (def.mode === "tail" || !def.vars?.length) continue;
    lines.push(`  /* —— ${def.label} —— */`);
    for (const name of def.vars) {
      if (seen.has(name)) continue;
      seen.add(name);
      const val = merged[name];
      if (val == null || val === "") continue;
      lines.push(`  ${name}: ${val};`);
    }
    lines.push("");
  }
  // 用户在某块里写了未登记变量，也收进 :root
  for (const [name, val] of Object.entries(merged)) {
    if (seen.has(name) || val == null || val === "") continue;
    lines.push(`  ${name}: ${val};`);
    seen.add(name);
  }
  const preview =
    String(parts?.preview || "").trim() || extractPreviewCss(defaultCssText());
  return `:root {\n${lines.join("\n").replace(/\n+$/, "")}\n}\n\n${preview}\n`;
}

function currentCssFromParts() {
  flushCssPartEditor();
  return joinCssParts(state._cssParts || splitCssToParts(defaultCssText()));
}

function flushCssPartEditor() {
  const ta = $("#ix-css-part");
  if (!ta || !state._cssParts) return;
  const id = state._cssPartId || CSS_PART_DEFS[0].id;
  state._cssParts[id] = ta.value;
}

function showCssPart(partId) {
  const def = CSS_PART_DEFS.find((d) => d.id === partId) || CSS_PART_DEFS[0];
  state._cssPartId = def.id;
  if (!state._cssParts) state._cssParts = splitCssToParts(defaultCssText());
  const ta = $("#ix-css-part");
  if (ta) {
    ta.value = state._cssParts[def.id] || "";
    // 无独占变量的类型：不强制改，仍可粘贴覆盖变量
    ta.readOnly = false;
  }
  $$("#ix-css-tabs [data-css-part]").forEach((t) => {
    t.classList.toggle("is-on", t.dataset.cssPart === def.id);
  });
  const hint = $("#ix-css-part-hint");
  if (hint) {
    if (def.mode === "tail") {
      hint.textContent = "仅网页 DOM 预览读这里；出图不读选择器。";
    } else if (!def.vars?.length) {
      hint.textContent = def.note || "此类型无独占变量，改「全局」即可。";
    } else {
      hint.textContent = "编辑本类型相关变量；保存时拼成完整 CSS。";
    }
  }
}

function wireCssPartTabs() {
  const tabs = $$("#ix-css-tabs [data-css-part]");
  if (!tabs.length) return;
  tabs.forEach((tab) => {
    tab.onclick = () => {
      flushCssPartEditor();
      showCssPart(tab.dataset.cssPart);
    };
  });
  const cur =
    tabs.find((t) => t.classList.contains("is-on"))?.dataset.cssPart ||
    CSS_PART_DEFS[0].id;
  showCssPart(cur);
}

function normalizeRenderMode(m) {
  return String(m || "text").toLowerCase() === "card" ? "card" : "text";
}

function syncCardPanelVisibility(mode) {
  mode = normalizeRenderMode(mode);
  const panel = $("#ix-card-panel");
  const preview = $("#ix-preview-pane");
  if (panel) panel.hidden = mode !== "card";
  if (preview) preview.hidden = mode !== "card";
  // enum-card 高亮
  $$('#ix-rmode-cards input[name="ix-rmode"]').forEach((inp) => {
    const card = inp.closest(".enum-card");
    if (card) card.classList.toggle("is-on", normalizeRenderMode(inp.value) === mode);
  });
}

const RENDER_KIND_LABELS = {
  session_list: "Session 列表",
  pending: "待审批列表",
  status: "状态",
  permission: "权限请求",
  routes: "推送路由",
  message: "Agent 对话",
};

const DEFAULT_CARD_CSS_FALLBACK = `/* ============================================
 * 推送图片样式
 *
 * ① :root 里的 --card-*  —— 出图真正读这些
 *    颜色 / 宽度 / 字号 / 徽章 / 序号框 / 行距
 * ② 下面的 .card / .row 等 —— 只给左侧网页预览
 *    聊天出图不读选择器，只认上面的变量
 * ============================================ */
:root {
  /* —— 颜色 —— */
  --card-bg: #f7f4ea;
  --card-fg: #14120f;
  --card-accent: #0f6b3c;
  --card-muted: #3a362e;
  --card-border: #c9c2b0;
  --card-code-bg: #ebe4d0;

  /* —— 整体尺寸 —— */
  --card-radius: 12px;
  --card-pad: 28px;
  --card-width: 720px;
  --card-font-scale: 1.12;

  /* —— 字号 —— */
  --card-title-size: 24px;
  --card-sub-size: 14.5px;
  --card-body-size: 16.5px;
  --card-meta-size: 13.5px;
  --card-foot-size: 13px;
  --card-mono: 0;

  /* —— status 状态徽章 —— */
  --card-badge-h: 40px;
  --card-badge-pad-x: 20px;
  --card-badge-font: 16.5px;
  --card-badge-dot: 6px;

  /* —— list 序号框 —— */
  --card-idx-w: 46px;
  --card-idx-h: 32px;
  --card-idx-font: 14px;
  --card-idx-radius: 7px;
  --card-idx-top: 6px;

  /* —— 行距 / 间距 —— */
  --card-row-pad-y: 13px;
  --card-row-pad-x: 14px;
  --card-row-gap: 10px;
  --card-section-gap: 16px;
}

/* —— 以下仅 DOM 预览用 —— */
.card {
  width: var(--card-width);
  background: var(--card-bg);
  color: var(--card-fg);
  border: 2px solid var(--card-border);
  border-radius: var(--card-radius);
  padding: var(--card-pad);
  font-size: calc(var(--card-body-size) * var(--card-font-scale));
  line-height: 1.55;
}
.card-title { font-size: calc(var(--card-title-size) * var(--card-font-scale)); font-weight: 700; margin-bottom: 6px; }
.card-sub { color: var(--card-muted); font-size: 0.92em; margin-bottom: 12px; }
.card-bar { width: 120px; height: 3px; background: var(--card-accent); margin-bottom: 14px; }
.row { margin-bottom: 12px; }
.row-detail { color: var(--card-muted); padding-left: 12px; }
.card-foot { margin-top: 12px; padding-top: 10px; border-top: 1px solid var(--card-border); color: var(--card-accent); }
.md pre, .md code { background: var(--card-code-bg); }
`;

const FALLBACK_INSTALLABLE = [
  {
    id: "font_noto_sc",
    group: "font",
    label: "中文字体 Noto Sans SC",
    desc: "下载到插件 assets/fonts/（约 8MB，SIL OFL）",
    installed: false,
  },
  {
    id: "dep_pillow",
    group: "dep",
    label: "Pillow（出图引擎）",
    desc: "pip install Pillow — 低延迟出图，不依赖浏览器",
    installed: false,
  },
  {
    id: "dep_matplotlib",
    group: "dep",
    label: "matplotlib（公式排版）",
    desc: "pip install matplotlib — Agent 消息整图里的公式用它排版",
    installed: false,
  },
];


/** 命令目录：优先 meta.command_catalog（formatters.HELP_*），否则用 help 接口 / 本地兜底 */
function commandCatalog() {
  const fromMeta = state.meta?.command_catalog;
  if (fromMeta?.commands?.length) return fromMeta;
  // 从 help 数据派生（与 formatters.export_help_data 同源）
  const topics = helpTopics().map((t) => ({ id: t.id, name: t.name, desc: t.desc }));
  const seen = new Set();
  const commands = [];
  for (const item of helpCommands()) {
    const usage = String(item.usage || "").trim();
    if (!usage.startsWith("/hapi")) continue;
    const rest = usage.slice("/hapi".length).trim();
    if (!rest) continue;
    const token = rest.split(/\s+/)[0];
    const id = token.replace(/[\[\]<>]/g, "").toLowerCase();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    // takes_arg：本地兜底根据 usage 是否含空格后参数位粗判；真值以后端 catalog 为准
    const takes_arg = /\s/.test(rest.replace(token, "").trim()) || /[\[<]/.test(usage);
    commands.push({
      id,
      topic: item.topic || "",
      usage,
      summary: item.summary || "",
      takes_arg,
    });
  }
  return { topics, commands };
}

function topicNameMap() {
  const m = {};
  for (const t of commandCatalog().topics || []) m[t.id] = t.name || t.id;
  // 兜底中文名
  Object.assign(m, {
    session: m.session || "会话",
    chat: m.chat || "对话",
    approve: m.approve || "审批",
    push: m.push || "通知",
    files: m.files || "文件",
    config: m.config || "配置",
  });
  return m;
}

function findCmdMeta(cmdId) {
  const id = String(cmdId || "").toLowerCase();
  return (commandCatalog().commands || []).find((c) => c.id === id) || null;
}

function cmdDisplayLabel(cmdId) {
  const c = findCmdMeta(cmdId);
  if (!c) return cmdId ? `/hapi ${cmdId}` : "";
  const argHint = c.takes_arg ? "可带参" : "整句";
  return `${c.usage} — ${c.summary || c.id} · ${argHint}`;
}

/** 可输入过滤的命令下拉（combobox） */
function cmdSelectHtml(selected, rowIdx) {
  const label = selected ? cmdDisplayLabel(selected) : "";
  return `<div class="cmd-combo" data-idx="${rowIdx}">
    <input type="text" class="ctrl ctrl-sm js-kw-cmd-input" data-idx="${rowIdx}"
      value="${attr(label)}" placeholder="输入过滤命令…" autocomplete="off" spellcheck="false" />
    <input type="hidden" class="js-kw-cmd" data-idx="${rowIdx}" value="${attr(selected || "")}" />
    <div class="cmd-combo-panel" hidden></div>
  </div>`;
}

function filterCommands(query) {
  const q = String(query || "").trim().toLowerCase();
  const cat = commandCatalog();
  const names = topicNameMap();
  const list = cat.commands || [];
  if (!q) return list;
  return list.filter((c) => {
    const blob = [
      c.id,
      c.usage,
      c.summary,
      names[c.topic] || c.topic,
      `/hapi ${c.id}`,
    ]
      .join(" ")
      .toLowerCase();
    return blob.includes(q);
  });
}

function renderCmdComboPanel(combo, query, selectedId) {
  const panel = combo.querySelector(".cmd-combo-panel");
  if (!panel) return;
  const names = topicNameMap();
  const list = filterCommands(query);
  if (!list.length) {
    panel.innerHTML = `<div class="cmd-combo-empty">无匹配命令</div>`;
    panel.hidden = false;
    return;
  }
  // 按 topic 分组
  const byTopic = new Map();
  for (const c of list) {
    const tid = c.topic || "_";
    if (!byTopic.has(tid)) byTopic.set(tid, []);
    byTopic.get(tid).push(c);
  }
  let html = "";
  for (const [tid, cmds] of byTopic) {
    html += `<div class="cmd-combo-group">${esc(names[tid] || tid)}</div>`;
    for (const c of cmds) {
      const on = c.id === selectedId ? " is-on" : "";
      const argHint = c.takes_arg ? "可带参" : "整句";
      html += `<button type="button" class="cmd-combo-item${on}" data-cmd="${attr(c.id)}">
        <span class="cmd-combo-usage mono">${esc(c.usage)}</span>
        <span class="cmd-combo-sum">${esc(c.summary || c.id)} · ${argHint}</span>
      </button>`;
    }
  }
  panel.innerHTML = html;
  panel.hidden = false;
}

function bindCmdCombos(host) {
  const root = host || document;
  const closeAll = (except) => {
    $$(".cmd-combo-panel", root).forEach((p) => {
      if (except && p === except) return;
      p.hidden = true;
    });
  };

  $$(".cmd-combo", root).forEach((combo) => {
    const idx = Number(combo.dataset.idx);
    const input = combo.querySelector(".js-kw-cmd-input");
    const hidden = combo.querySelector(".js-kw-cmd");
    const panel = combo.querySelector(".cmd-combo-panel");
    if (!input || !hidden || !panel) return;

    const pick = (cmdId) => {
      hidden.value = cmdId || "";
      input.value = cmdId ? cmdDisplayLabel(cmdId) : "";
      panel.hidden = true;
      if (state._ixKwMaps?.[idx]) {
        const prev = state._ixKwMaps[idx].command;
        state._ixKwMaps[idx].command = cmdId || "";
        if (cmdId !== "to") state._ixKwMaps[idx].args = "";
        if (prev !== cmdId) paintKwMapList();
      }
    };

    input.onfocus = () => {
      renderCmdComboPanel(combo, "", hidden.value);
    };
    input.oninput = () => {
      // 输入只做过滤；未点选前不改 hidden（避免半成品 id）
      renderCmdComboPanel(combo, input.value, hidden.value);
    };
    input.onkeydown = (e) => {
      if (e.key === "Escape") {
        panel.hidden = true;
        input.blur();
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        const first = panel.querySelector(".cmd-combo-item");
        if (first) pick(first.dataset.cmd);
      }
    };
    panel.onclick = (e) => {
      const btn = e.target.closest(".cmd-combo-item");
      if (!btn) return;
      e.preventDefault();
      pick(btn.dataset.cmd);
    };
  });

  // 点外部关闭
  if (!state._cmdComboDocBound) {
    state._cmdComboDocBound = true;
    document.addEventListener("click", (e) => {
      if (e.target.closest(".cmd-combo")) return;
      $$(".cmd-combo-panel").forEach((p) => {
        p.hidden = true;
      });
    });
  }
  closeAll();
}

function paintKwMapList() {
  const host = $("#ix-kw-list");
  if (!host) return;
  const rows = Array.isArray(state._ixKwMaps) ? state._ixKwMaps : [];
  if (!rows.length) {
    host.innerHTML = `<div class="empty-inline">还没有映射。点「添加映射」：填关键词，再选对应 /hapi 命令。</div>`;
    return;
  }
  host.innerHTML = rows
    .map((row, i) => {
      const kws = Array.isArray(row.keywords) ? row.keywords.join("，") : "";
      const args = row.args || "";
      // 仅 /hapi to 显示「发送消息」固定内容
      const isTo = String(row.command || "") === "to";
      return `<div class="kw-map-row ${isTo ? "has-msg" : ""}" data-idx="${i}">
        <label class="kw-map-field">
          <span class="kw-map-label">关键词</span>
          <input type="text" class="ctrl js-kw-keys" data-idx="${i}" value="${attr(kws)}" placeholder="stop，停（逗号分隔，可多个）" />
        </label>
        <label class="kw-map-field kw-map-cmd">
          <span class="kw-map-label">映射命令</span>
          ${cmdSelectHtml(row.command || "", i)}
        </label>
        ${
          isTo
            ? `<label class="kw-map-field kw-map-args">
          <span class="kw-map-label">发送消息</span>
          <input type="text" class="ctrl js-kw-args" data-idx="${i}" value="${attr(args)}" placeholder="如 1 clear" />
        </label>`
            : ""
        }
        <button type="button" class="btn btn-sm btn-danger js-kw-del" data-idx="${i}" title="删除">删</button>
      </div>`;
    })
    .join("");

  $$("#ix-kw-list .js-kw-keys").forEach((inp) => {
    inp.oninput = () => {
      const i = Number(inp.dataset.idx);
      if (!state._ixKwMaps?.[i]) return;
      state._ixKwMaps[i].keywords = String(inp.value || "")
        .split(/[,，]/)
        .map((s) => s.trim())
        .filter(Boolean);
    };
  });
  bindCmdCombos($("#ix-kw-list"));
  $$("#ix-kw-list .js-kw-args").forEach((inp) => {
    inp.oninput = () => {
      const i = Number(inp.dataset.idx);
      if (!state._ixKwMaps?.[i]) return;
      state._ixKwMaps[i].args = String(inp.value || "").trim();
    };
  });
  $$("#ix-kw-list .js-kw-del").forEach((btn) => {
    btn.onclick = () => {
      const i = Number(btn.dataset.idx);
      if (!Array.isArray(state._ixKwMaps)) return;
      state._ixKwMaps.splice(i, 1);
      paintKwMapList();
    };
  });
}

function collectQuickOpsPatchFromForm() {
  const pokeOn = Boolean($("#ix-poke")?.checked);
  const pokeAction =
    document.querySelector("#ix-poke-actions input[name='ix-poke-action']:checked")?.value ||
    "approve";
  const prefix = ($("#ix-prefix")?.value || ">").trim() || ">";
  // 再从 DOM 同步一遍关键词，避免漏 input 事件
  $$("#ix-kw-list .js-kw-keys").forEach((inp) => {
    const i = Number(inp.dataset.idx);
    if (!state._ixKwMaps?.[i]) return;
    state._ixKwMaps[i].keywords = String(inp.value || "")
      .split(/[,，]/)
      .map((s) => s.trim())
      .filter(Boolean);
  });
  $$("#ix-kw-list .js-kw-cmd").forEach((inp) => {
    const i = Number(inp.dataset.idx);
    if (!state._ixKwMaps?.[i]) return;
    // hidden input 存 command id
    state._ixKwMaps[i].command = String(inp.value || "").trim().toLowerCase();
  });
  $$("#ix-kw-list .js-kw-args").forEach((inp) => {
    const i = Number(inp.dataset.idx);
    if (!state._ixKwMaps?.[i]) return;
    state._ixKwMaps[i].args = String(inp.value || "").trim();
  });
  const maps = (state._ixKwMaps || [])
    .map((m) => {
      const cmd = String(m.command || "").trim().toLowerCase();
      const entry = {
        keywords: [...(m.keywords || [])].filter(Boolean),
        command: cmd,
      };
      // 仅 to 保留发送消息
      const args = cmd === "to" ? String(m.args || "").trim() : "";
      if (args) entry.args = args;
      return entry;
    })
    .filter((m) => m.keywords.length && m.command);
  return {
    poke_approve: pokeOn,
    poke_action: pokeAction,
    quick_prefix: prefix,
    cmd_keyword_maps: maps,
    cmd_keyword_maps_list: maps,
  };
}

function interactRenderState(cfg) {
  const kinds = Array.isArray(cfg.render_kinds_list)
    ? cfg.render_kinds_list
    : String(cfg.render_kinds || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
  const metaCss =
    (state.meta && state.meta.render && state.meta.render.default_css) ||
    DEFAULT_CARD_CSS_FALLBACK;
  const custom = (cfg.card_custom_css || "").trim();
  return {
    render_mode: normalizeRenderMode(cfg.render_mode),
    formula_mode: cfg.formula_mode || "off",
    kinds,
    card_font_path: cfg.card_font_path || "",
    default_css: metaCss,
    // 编辑器里直接显示「当前生效」的 CSS：有自定义用自定义，否则默认
    effective_css: custom || metaCss,
    using_default_css: !custom,
  };
}

function sampleTitle(kind) {
  return (
    {
      session_list: "Session 列表",
      pending: "待审批",
      status: "Session 状态",
      permission: "权限请求",
      routes: "推送路由",
      // 真实 message 卡：title = 会话标题
      message: "重构鉴权中间件",
    }[kind] || kind
  );
}

function sampleSub(kind) {
  return (
    {
      session_list: "当前窗口 · 3 个 · 思考 1 / 运行 1 / 关闭 1",
      pending: "当前窗口 2 项 · 全局 3 项",
      status: "claude · a1b2c3d4 · 思考中",
      permission: "序号 1 · claude · auth-mw",
      routes: "绑定 1 · 有默认窗口 · Agent 1",
      // 真实 message 卡：subtitle = Agent 消息 · 路径 · flavor · sid
      message: "Agent 消息 · claude · auth-mw · a1b2c3d4",
    }[kind] || ""
  );
}

function sampleFooter(kind) {
  return (
    {
      session_list: "",
      pending: "",
      status: "",
      permission: "",
      routes: "",
      message: "",
    }[kind] || ""
  );
}

/** 按真实出图结构生成 DOM 预览 body */
function sampleDomBody(kind) {
  if (kind === "message") {
    return `<div class="rpc-md">
      <div class="rpc-md-h2">修复摘要</div>
      <div class="rpc-md-p">已完成鉴权中间件重构，补充单测。</div>
      <div class="rpc-md-p">主要改动：</div>
      <div class="rpc-md-li">· 统一 JWT 刷新路径</div>
      <div class="rpc-md-li">· 抽出 session 绑定校验</div>
      <div class="rpc-md-pre"><code>pytest -q tests/test_auth.py</code></div>
    </div>`;
  }
  if (kind === "pending") {
    return [
      { i: 1, a: "claude · auth-mw", b: "Bash · npm test" },
      { i: 2, a: "claude · auth-mw", b: "Edit · src/auth.ts" },
    ]
      .map(
        (r) =>
          `<div class="rpc-row"><div class="rpc-head">[${r.i}] ${esc(r.a)}</div><div class="rpc-detail">${esc(r.b)}</div></div>`,
      )
      .join("");
  }
  if (kind === "permission") {
    return [
      { a: "工具", b: "Bash" },
      { a: "命令", b: "pytest -q tests/test_auth.py" },
    ]
      .map(
        (r) =>
          `<div class="rpc-row"><div class="rpc-head">${esc(r.a)}</div><div class="rpc-detail">${esc(r.b)}</div></div>`,
      )
      .join("");
  }
  if (kind === "status") {
    return [
      { a: "状态", b: "思考中" },
      { a: "模型", b: "opus · effort high" },
      { a: "路径", b: "/home/dev/proj-auth" },
    ]
      .map(
        (r) =>
          `<div class="rpc-row"><div class="rpc-head">${esc(r.a)}</div><div class="rpc-detail">${esc(r.b)}</div></div>`,
      )
      .join("");
  }
  if (kind === "routes") {
    return [
      { i: 1, a: "会话绑定", b: "群 A · 20001" },
      { i: 2, a: "Agent 窗口", b: "claude → 私聊" },
      { i: 3, a: "默认窗口", b: "私聊 · 10001" },
    ]
      .map(
        (r) =>
          `<div class="rpc-row"><div class="rpc-head">[${r.i}] ${esc(r.a)}</div><div class="rpc-detail">${esc(r.b)}</div></div>`,
      )
      .join("");
  }
  // session_list：对齐真实图片（分组条 + 序号块 + 状态点 + sid）
  const sessions = [
    {
      section: "…/dev/proj-auth",
      count: 2,
      items: [
        {
          i: 1,
          title: "重构鉴权中间件",
          status: "思考中",
          sk: "thinking",
          meta: "claude:opus · 当前",
          sid: "a1b2c3d4",
          cur: true,
        },
        {
          i: 2,
          title: "补 session 列表单测",
          status: "已关闭",
          sk: "closed",
          meta: "claude:sonnet",
          sid: "e5f6g7h8",
          cur: false,
        },
      ],
    },
    {
      section: "…/dev/docs",
      count: 1,
      items: [
        {
          i: 3,
          title: "API 文档生成",
          status: "运行中",
          sk: "active",
          meta: "codex:default · 待审 1",
          sid: "i9j0k1l2",
          cur: false,
        },
      ],
    },
  ];
  return sessions
    .map((g) => {
      const rows = g.items
        .map((s) => {
          const curCls = s.cur ? " is-current" : "";
          return `<div class="rpc-sess${curCls}">
            <span class="rpc-idx">${s.i}</span>
            <div class="rpc-sess-main">
              <div class="rpc-sess-title">${esc(s.title)}</div>
              <div class="rpc-sess-meta">
                <span class="rpc-dot rpc-dot-${s.sk}"></span>
                <span>${esc(s.status)} · ${esc(s.meta)}</span>
              </div>
            </div>
            <span class="rpc-sid mono">${esc(s.sid)}</span>
          </div>`;
        })
        .join("");
      return `<div class="rpc-section">
        <div class="rpc-section-head">
          <span class="rpc-section-path">${esc(g.section)}</span>
          <span class="rpc-section-count">${g.count} 个</span>
        </div>
        ${rows}
      </div>`;
    })
    .join("");
}

function paintDomCardPreview() {
  const root = $("#ix-dom-preview");
  if (!root) return;
  const kind = $("#ix-sample")?.value || "session_list";
  const foot = sampleFooter(kind);
  root.innerHTML = `
    <div class="render-preview-card">
      <div class="rpc-title">${esc(sampleTitle(kind))}</div>
      <div class="rpc-sub">${esc(sampleSub(kind))}</div>
      <div class="rpc-bar"></div>
      <div class="rpc-body">${sampleDomBody(kind)}</div>
      ${foot ? `<div class="rpc-foot">${esc(foot)}</div>` : ""}
      </div>
    <p class="field-help" style="margin-top:8px">DOM 仅示意结构。样式以自定义 CSS +「生成实图」为准。</p>`;
}

function collectRenderPatchFromForm() {
  const kindBoxes = [...document.querySelectorAll("[data-rkind]")];
  let kinds = kindBoxes.filter((el) => el.checked).map((el) => el.value);
  const modeRadio = document.querySelector('input[name="ix-rmode"]:checked');
  const render_mode = normalizeRenderMode(modeRadio?.value || $("#ix-rmode")?.value || "text");
  // 面板隐藏时 checkbox 未渲染/未勾：沿用已保存 kinds，避免误清空 message
  if (render_mode === "card" && !kinds.length) {
    const prev =
      state.data?.config?.render_kinds_list ||
      String(state.data?.config?.render_kinds || "").split(",");
    kinds = (Array.isArray(prev) ? prev : [])
      .map((x) => String(x).trim())
      .filter(Boolean);
  }
  if (render_mode === "card" && !kinds.length) {
    kinds = ["session_list", "pending", "status", "permission", "message"];
  }
  const defaultCss = defaultCssText();
  let css = currentCssFromParts();
  if (css.trim() === String(defaultCss).trim()) css = "";

  let fontPath = "";
  const sel = $("#ix-font-select")?.value || "";
  if (sel === "__custom__") {
    fontPath = ($("#ix-font-path")?.value || "").trim();
  } else if (sel) {
    fontPath = sel;
  } else {
    fontPath = "";
  }

  const fmode =
    $("#ix-fmode")?.value ||
    state.data?.config?.formula_mode ||
    "off";

  return {
    render_mode,
    formula_mode: ["off", "detect", "plain", "always"].includes(fmode)
      ? fmode === "always"
        ? "plain"
        : fmode
      : "off",
    render_kinds:
      render_mode === "card"
        ? kinds.join(",") || "session_list,pending,status,permission,message"
        : String(
            state.data?.config?.render_kinds ||
              kinds.join(",") ||
              "session_list,pending,status,permission,message",
          ),
    card_custom_css: css,
    card_font_path: fontPath,
  };
}


function renderInteract() {
  if (!state.data) return;
  renderTopConn();
  renderAlert();
  const cfg = state.data.config;
  const rs = interactRenderState(cfg);
  const engine = { ...(cfg.render_engine || {}) };
  // installable：engine → meta → 前端兜底（避免「加载安装选项失败」）
  if (!Array.isArray(engine.installable) || !engine.installable.length) {
    engine.installable =
      state.meta?.render?.installable ||
      state.meta?.render?.engine?.installable ||
      FALLBACK_INSTALLABLE;
  }
  const pillowOk = Boolean(engine.pillow);
  const fonts = (engine.fonts || {});
  const fontOk = Boolean(fonts.sans || fonts.user_font);
  const engineTag = pillowOk
    ? "Pillow 可用"
    : "未装 Pillow · 回退文本";
  const engineTagCls = pillowOk ? "tag-ok" : "tag-muted";
  const cssValue = rs.effective_css || rs.default_css || "";
  const kindChecks = Object.keys(RENDER_KIND_LABELS)
    .map((k) => {
      const on = rs.kinds.includes(k);
      return `<label class="chk"><input type="checkbox" data-rkind value="${k}" ${on ? "checked" : ""}/> ${esc(
        RENDER_KIND_LABELS[k],
      )}</label>`;
    })
    .join("");

  const kwMaps = Array.isArray(cfg.cmd_keyword_maps_list)
    ? cfg.cmd_keyword_maps_list
    : [];
  state._ixKwMaps = kwMaps.map((m) => ({
    keywords: [...(m.keywords || [])],
    command: m.command || "",
    args: m.args || "",
  }));
  if (!state._ixKwMaps.length) {
    // 与后端 DEFAULT_KEYWORD_MAPS 对齐
    state._ixKwMaps = [
      { keywords: ["stop", "停"], command: "stop", args: "" },
      { keywords: ["sw"], command: "sw", args: "" },
      { keywords: ["cl"], command: "to", args: "1 clear" },
      { keywords: ["继续"], command: "to", args: "1 继续" },
    ];
  }

  $("#view-interact").innerHTML = `
    <div class="card card-section">
      <div class="card-head">
        <div>
          <h2>快捷操作</h2>
          <p class="sub">聊天侧前缀、戳一戳与指令关键词映射。改完点右下角保存。</p>
        </div>
      </div>

      <div class="field">
        <div class="field-label-row">
          <div class="field-label">启用戳一戳快捷操作</div>
        </div>
        <p class="field-help">仅 QQ NapCat 等支持戳一戳的适配器。关闭后戳机器人不会触发任何 hapi 动作。</p>
        <label class="switch">
          <input id="ix-poke" type="checkbox" ${cfg.poke_approve ? "checked" : ""} />
          <span class="switch-track" aria-hidden="true"></span>
          <span class="switch-text">${cfg.poke_approve ? "开启" : "关闭"}</span>
        </label>
      </div>

      <div class="field" id="ix-poke-action-wrap" ${cfg.poke_approve ? "" : "hidden"}>
        <div class="field-label-row">
          <div class="field-label">戳一戳映射动作</div>
        </div>
        <p class="field-help">默认一键批准。</p>
        <div class="poke-action-grid" id="ix-poke-actions">
          ${(cfg.poke_actions || [])
            .map((a) => {
              const on = (cfg.poke_action || "approve") === a.id;
              const cmd = a.cmd
                ? `<span class="pa-cmd mono">${esc(a.cmd)}</span>`
                : `<span class="pa-cmd pa-cmd-empty"></span>`;
              return `<label class="poke-action-card ${on ? "is-on" : ""}">
                <input type="radio" name="ix-poke-action" value="${attr(a.id)}" ${on ? "checked" : ""} />
                <span class="pa-emoji" aria-hidden="true">${esc(a.emoji || "·")}</span>
                <span class="pa-label">${esc(a.label || a.id)}</span>
                ${cmd}
                <span class="pa-desc">${esc(a.desc || "")}</span>
              </label>`;
            })
            .join("")}
        </div>
      </div>

      <div class="field">
        <div class="field-label-row">
          <div class="field-label">快捷发送前缀</div>
        </div>
        <p class="field-help">插件默认不接管所有消息。发送到 HAPI 需使用 <code>/hapi to</code> 或快捷发送前缀；带此前缀的消息会发往当前窗口连接的 HAPI 会话。</p>
        <input id="ix-prefix" class="ctrl" type="text" value="${attr(cfg.quick_prefix)}" style="max-width:220px" />
      </div>

      <div class="field">
        <div class="field-label-row">
          <div class="field-label">指令关键词映射</div>
        </div>
        <p class="field-help">关键词来自帮助命令表。可带参命令支持「关键词 + 参数」。仅当前窗口有交互中会话时生效。</p>
        <div id="ix-kw-list" class="kw-map-list"></div>
        <div class="kw-map-toolbar">
          <button type="button" class="btn btn-sm" id="ix-kw-add">添加映射</button>
        </div>
      </div>

      <div class="section-actions">
        <button type="button" class="btn btn-primary" id="ix-save-quick">保存快捷操作</button>
      </div>
    </div>

    <div class="card card-section">
      <div class="card-head">
        <div>
          <h2>推送呈现</h2>
          <p class="sub">此处修改消息渲染形式（文字 / 图片）。图片渲染使用 Pillow（延迟较低）。</p>
        </div>
        <span class="tag ${engineTagCls}">${engineTag}</span>
      </div>

      ${
        pillowOk
          ? ""
          : `<div class="alert-inline">出图需要 Pillow。可在下方勾选安装，或手动 <code>pip install Pillow</code>。未安装时配置可保存，运行时回退纯文本。</div>`
      }

      <div class="render-layout">
        <div class="render-form">
          <div class="field">
            <div class="field-label">渲染模式</div>
            <div class="enum-cards" id="ix-rmode-cards">
              ${[
                { value: "text", title: "纯文本", desc: "全部走文字推送。" },
                { value: "card", title: "图片", desc: "下方勾选的类型渲成图片。" },
              ].map((o) => `<label class="enum-card">
                <input type="radio" name="ix-rmode" value="${o.value}" ${rs.render_mode === o.value ? "checked" : ""} />
                <div class="t">${esc(o.title)}</div>
                <div class="d">${esc(o.desc)}</div>
              </label>`).join("")}
            </div>
          </div>

          <div id="ix-card-panel" ${rs.render_mode === "card" ? "" : "hidden"}>
          <div class="field">
            <div class="field-label">以下类型渲成图片</div>
            <div class="chk-grid">${kindChecks}</div>
          </div>

          <div class="field" id="ix-fmode-wrap" ${rs.kinds.includes("message") ? "" : "hidden"}>
            <div class="field-label">公式（仅 Agent 对话）</div>
            <select id="ix-fmode" class="ctrl" style="max-width:360px">
              ${[
                { value: "off", title: "关闭" },
                { value: "detect", title: "有公式时整条仍出图（matplotlib 排公式）" },
                { value: "plain", title: "有公式时整条只发文字" },
              ]
                .map(
                  (o) =>
                    `<option value="${o.value}" ${
                      (rs.formula_mode || "off") === o.value ? "selected" : ""
                    }>${esc(o.title)}</option>`,
                )
                .join("")}
            </select>
          </div>

          <div class="field">
            <div class="field-label">图片 CSS（当前生效）</div>
            <p class="field-help">
              ${rs.using_default_css ? "内置默认样式。" : "已保存的自定义样式。"}
              按图片类型拆开编辑，保存时拼成完整 CSS。
            </p>
            <div class="css-part-tabs" id="ix-css-tabs" role="tablist">
              ${CSS_PART_DEFS.map(
                (t, i) =>
                  `<button type="button" class="css-part-tab ${i === 0 ? "is-on" : ""}" data-css-part="${t.id}" role="tab">${esc(t.label)}</button>`,
              ).join("")}
            </div>
            <p class="field-help" id="ix-css-part-hint" style="margin:0 0 6px"></p>
            <textarea id="ix-css-part" class="ctrl render-css-editor" rows="12" spellcheck="false"></textarea>
          </div>

          <div class="field">
            <div class="field-label">图片字体</div>
            <p class="field-help">会在下列路径扫描可选字体。</p>
            <ul class="font-scan-locs">
              ${(fonts.scan_locations || [
                { label: "插件目录", path: fonts.bundled_dir || "assets/fonts", hint: "插件包内 assets/fonts/" },
                { label: "系统常见路径", path: null, hint: "Linux Noto/文泉驿、macOS PingFang、Windows 雅黑 等" },
              ]).map((loc) => `<li><strong>${esc(loc.label)}</strong>${loc.path ? ` · <code class="mono">${esc(loc.path)}</code>` : ""}
                ${loc.hint ? `<span class="muted"> — ${esc(loc.hint)}</span>` : ""}</li>`).join("")}
            </ul>
            <select id="ix-font-select" class="ctrl" style="margin-top:8px">
              <option value="">不指定（用扫描到的可用字体；都没有则回退文本）</option>
              ${(fonts.fonts || []).map((f) => {
                const cur = (rs.card_font_path || "").replace(/\\\\/g, "/");
                const fp = String(f.path || "").replace(/\\\\/g, "/");
                const sel = cur && (cur === fp || cur.endsWith("/" + f.name) || cur === f.name);
                return `<option value="${attr(f.path)}" ${sel ? "selected" : ""}>${esc(f.label || f.name)} · ${f.kb || "?"}KB</option>`;
              }).join("")}
              <option value="__custom__" ${rs.card_font_path && !(fonts.fonts || []).some((f) => f.path === rs.card_font_path) ? "selected" : ""}>自定义路径…</option>
            </select>
            <div id="ix-font-custom-wrap" style="margin-top:8px" ${rs.card_font_path && !(fonts.fonts || []).some((f) => f.path === rs.card_font_path) ? "" : "hidden"}>
              <input id="ix-font-path" class="ctrl" type="text" value="${attr(rs.card_font_path)}" placeholder="绝对路径或相对插件根，如 assets/fonts/xxx.otf" />
            </div>
            ${!(fonts.fonts || []).length ? `<p class="field-help" style="margin-top:6px">未扫到字体。可点下方安装 Noto 到插件目录，或填自定义路径。</p>` : ""}
          </div>

          <div class="field">
            <div class="field-label">可选生图依赖</div>
            <div class="chk-grid" id="ix-install-grid">
              ${(Array.isArray(engine.installable) && engine.installable.length
                  ? engine.installable
                  : FALLBACK_INSTALLABLE
                )
                .map((it) => {
                  const mark = it.installed ? "已就绪" : "未安装";
                  const detail = it.detail ? ` · ${it.detail}` : "";
                  return `<label class="chk install-opt ${it.installed ? "is-ready" : ""}">
                    <input type="checkbox" data-install-id value="${attr(it.id)}"/>
                    <span><strong>${esc(it.label || it.id)}</strong>
                    <span class="install-meta">${esc(mark)}${esc(detail)}</span>
                    <span class="install-desc">${esc(it.desc || "")}</span></span>
                  </label>`;
                })
                .join("")}
            </div>
            <div class="render-actions" style="margin-top:10px">
              <button type="button" class="btn" id="ix-install-selected">安装所选</button>
            </div>
            <div id="ix-install-log" class="field-help" style="margin-top:8px;white-space:pre-wrap"></div>
          </div>

          </div><!-- /ix-card-panel -->

          <div class="render-actions">
            <button type="button" class="btn" id="ix-reset-style">恢复默认样式</button>
          </div>
        </div>

        <div class="render-preview-pane" id="ix-preview-pane" ${rs.render_mode === "card" ? "" : "hidden"}>
          <div class="field-label-row" style="margin-bottom:8px">
            <div class="field-label">预览</div>
            <select id="ix-sample" class="ctrl" style="max-width:160px">
              ${Object.keys(RENDER_KIND_LABELS)
                .map((k) => `<option value="${k}">${esc(RENDER_KIND_LABELS[k])}</option>`)
                .join("")}
            </select>
          </div>
          <p class="field-help">左侧 DOM 示意结构；点「生成实图」走服务端 Pillow（读自定义 CSS 变量），与聊天发出一致。</p>
          <div id="ix-dom-preview" class="render-dom-host"></div>
          <div class="render-actions" style="margin-top:12px">
            <button type="button" class="btn btn-primary" id="ix-gen-card">生成实图预览</button>
          </div>
          <div id="ix-real-meta" class="field-help" style="margin-top:8px"></div>
          <div id="ix-real-preview" class="render-real-host"></div>
        </div>
      </div>

      <div class="section-actions">
        <button type="button" class="btn btn-primary" id="ix-save-render">保存推送设置</button>
      </div>
    </div>
  `;

  // 戳一戳开关：只改 UI 显隐，点保存才落盘
  $("#ix-poke") &&
    ($("#ix-poke").onchange = () => {
      const on = $("#ix-poke").checked;
      const txt = $("#ix-poke").closest(".switch")?.querySelector(".switch-text");
      if (txt) txt.textContent = on ? "开启" : "关闭";
      const wrap = $("#ix-poke-action-wrap");
      if (wrap) wrap.hidden = !on;
    });
  $$("#ix-poke-actions input[name='ix-poke-action']").forEach((inp) => {
    inp.onchange = () => {
      $$("#ix-poke-actions .poke-action-card").forEach((c) => c.classList.remove("is-on"));
      inp.closest(".poke-action-card")?.classList.add("is-on");
    };
  });

  paintKwMapList();
  $("#ix-kw-add") && ($("#ix-kw-add").onclick = () => {
    if (!Array.isArray(state._ixKwMaps)) state._ixKwMaps = [];
    state._ixKwMaps.push({ keywords: [], command: "", args: "" });
    paintKwMapList();
  });

  $("#ix-save-quick") &&
    ($("#ix-save-quick").onclick = async () => {
      const patch = collectQuickOpsPatchFromForm();
      try {
        let res = null;
        if (liveMode && api) {
          res = await api.saveConfig(patch);
          toast(res?.message || "已保存快捷操作");
        } else {
          store.saveConfig({
            ...patch,
            cmd_keyword_maps_list: patch.cmd_keyword_maps_list || [],
          });
          toast("已保存快捷操作（本地 mock）");
        }
        if (res?.config && state.data) state.data.config = { ...state.data.config, ...res.config };
        else if (state.data?.config) Object.assign(state.data.config, patch);
        if (state.draft) Object.assign(state.draft, patch);
        if (Array.isArray(patch.cmd_keyword_maps_list)) {
          state._ixKwMaps = patch.cmd_keyword_maps_list.map((m) => ({
            keywords: [...(m.keywords || [])],
            command: m.command || "",
            args: m.args || "",
          }));
        }
        await refresh({ silent: true });
      } catch (e) {
        toast("保存失败: " + (e.message || e));
      }
    });

  // 渲染模式：本地立即显隐，不必先保存
  $$('#ix-rmode-cards input[name="ix-rmode"]').forEach((inp) => {
    inp.onchange = () => {
      const mode = normalizeRenderMode(inp.value);
      syncCardPanelVisibility(mode);
    };
  });
  syncCardPanelVisibility(rs.render_mode);

  // 勾选「Agent 对话」才显示公式渲染
  const syncFormulaWrap = () => {
    const wrap = $("#ix-fmode-wrap");
    if (!wrap) return;
    const msgOn = [...document.querySelectorAll("[data-rkind]")].some(
      (el) => el.value === "message" && el.checked,
    );
    wrap.hidden = !msgOn;
  };
  $$("[data-rkind]").forEach((el) => {
    el.addEventListener("change", syncFormulaWrap);
  });
  syncFormulaWrap();

  const bindPaint = () => {
    paintDomCardPreview();
  };
  ["ix-sample"].forEach(
    (id) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener("input", bindPaint);
      el.addEventListener("change", bindPaint);
    },
  );


  state._cssParts = splitCssToParts(rs.effective_css || rs.default_css || DEFAULT_CARD_CSS_FALLBACK);
  state._cssPartId = CSS_PART_DEFS[0].id;
  wireCssPartTabs();

  $("#ix-reset-style") &&
    ($("#ix-reset-style").onclick = () => {
      state._cssParts = splitCssToParts(rs.default_css || DEFAULT_CARD_CSS_FALLBACK);
      showCssPart(state._cssPartId || CSS_PART_DEFS[0].id);
      if ($("#ix-font-select")) $("#ix-font-select").value = "";
      if ($("#ix-font-path")) $("#ix-font-path").value = "";
      if ($("#ix-font-custom-wrap")) $("#ix-font-custom-wrap").hidden = true;
      bindPaint();
    });


  // 字体下拉：选「自定义」时显示路径框
  const fontSel = $("#ix-font-select");
  const fontCustom = $("#ix-font-custom-wrap");
  if (fontSel) {
    fontSel.onchange = () => {
      if (fontCustom) fontCustom.hidden = fontSel.value !== "__custom__";
      if (fontSel.value && fontSel.value !== "__custom__" && $("#ix-font-path")) {
        $("#ix-font-path").value = fontSel.value;
      }
    };
  }

  $("#ix-install-selected") &&
    ($("#ix-install-selected").onclick = async () => {
      const boxes = [...document.querySelectorAll("[data-install-id]")];
      const ids = boxes.filter((el) => el.checked).map((el) => el.value);
      const logEl = $("#ix-install-log");
      const btn = $("#ix-install-selected");
      if (!ids.length) {
        if (logEl) logEl.textContent = "请先勾选：中文字体 和/或 Pillow。";
        return;
      }
      const setLog = (s) => {
        if (logEl) logEl.textContent = s;
      };
      setLog("安装中…\n" + ids.map((id) => "· " + id).join("\n"));
      if (btn) {
        btn.disabled = true;
        btn.classList.add("is-busy");
        btn.dataset._old = btn.textContent || "";
        btn.textContent = "安装中…";
      }
      try {
        // 与 self_learning 一样：直接 bridge.apiPost，不绕花活封装
        const bridge = window.AstrBotPluginPage;
        if (!liveMode || !bridge || typeof bridge.apiPost !== "function") {
          throw new Error("不在 AstrBot 插件面板内，或 bridge 不可用");
        }
        let raw = await bridge.apiPost("render/install", { ids, force: false });
        // 解包 { code, data } 若有
        if (raw && typeof raw === "object" && raw.data != null && (raw.code === 0 || raw.code === 200 || raw.success === true)) {
          raw = raw.data;
        }
        const res = raw || {};
        const lines = [];
        lines.push(res.message || (res.ok || res.success ? "完成" : "失败"));
        if (res.output) lines.push(String(res.output));
        else if (Array.isArray(res.log)) lines.push(res.log.join("\n"));
        else {
          for (const r of res.results || []) {
            lines.push(`· ${r.id}: ${r.message || (r.ok ? "ok" : r.error || "fail")}`);
            if (Array.isArray(r.log)) lines.push(r.log.join("\n"));
          }
        }
        setLog(lines.filter(Boolean).join("\n"));
        toast(res.ok || res.success ? "安装完成" : "安装有失败，见下方日志");
        await refresh({ silent: true, repaint: true });
      } catch (e) {
        setLog("安装失败: " + (e.message || e));
        toast("安装失败: " + (e.message || e));
      } finally {
        if (btn) {
          btn.disabled = false;
          btn.classList.remove("is-busy");
          if (btn.dataset._old) btn.textContent = btn.dataset._old;
        }
      }
    });

  $("#ix-save-render") &&
    ($("#ix-save-render").onclick = async () => {
      const patch = collectRenderPatchFromForm();
      try {
        let res = null;
        if (liveMode && api) {
          res = await api.saveConfig(patch);
          toast(res?.message || "已保存推送设置");
        } else {
          store.saveConfig({
            ...patch,
            render_kinds_list: patch.render_kinds.split(","),
            render_engine: engine,
          });
          toast("已保存推送设置（本地 mock）");
        }
        if (res?.config && state.data) state.data.config = { ...state.data.config, ...res.config };
        else if (state.data?.config) Object.assign(state.data.config, patch);
        if (state.draft) Object.assign(state.draft, patch);
        await refresh({ silent: true });
        syncCardPanelVisibility(patch.render_mode);
      } catch (e) {
        toast("保存失败: " + (e.message || e));
      }
    });

  $("#ix-gen-card") &&
    ($("#ix-gen-card").onclick = async () => {
      const kind = $("#ix-sample")?.value || "session_list";
      const style = collectRenderPatchFromForm();
      const meta = $("#ix-real-meta");
      const host = $("#ix-real-preview");
      if (meta) meta.textContent = "生成中…";
      if (host) host.innerHTML = "";
      try {
        let res;
        if (liveMode && api) {
          res = await api.renderPreview({
            kind,
            style,
            formula_mode: style.formula_mode || $("#ix-fmode")?.value || "off",
          });
        } else {
          // mock：无服务端时只提示用 DOM 预览
          res = {
            ok: false,
            error: "本地预览模式无 Pillow 后端；请在 AstrBot 插件面板内生成实图，或安装依赖后重试。",
            ms: 0,
            engine: "none",
            fallback_text: sampleTitle(kind) + "\n" + sampleSub(kind),
          };
        }
        if (res?.ok && res.png_base64) {
          if (meta) {
            const fontHint = res.font_path ? ` · font=${res.font_path}` : "";
            meta.textContent = `实图 · ${res.engine} · ${res.ms}ms · ${res.bytes || "?"}B · ${res.width}×${res.height}${fontHint}`;
          }
          if (host) {
            host.innerHTML = `<img class="render-real-img" alt="card preview" src="data:${res.mime || "image/png"};base64,${res.png_base64}" />`;
          }
        } else {
          if (meta) {
            meta.textContent = `未能生成实图（${res?.engine || "none"} · ${res?.ms ?? "?"}ms）：${res?.error || "unknown"}`;
          }
          if (host && res?.fallback_text) {
            host.innerHTML = `<pre class="render-fallback">${esc(res.fallback_text)}</pre>`;
          }
        }
      } catch (e) {
        if (meta) meta.textContent = "预览失败: " + (e.message || e);
      }
    });

  paintDomCardPreview();
}

/* ---------- help ---------- */

function matchHelpCmd(c, q) {
  if (!q) return true;
  const topicName = helpTopics().find((t) => t.id === c.topic)?.name || "";
  const blob = [c.usage, c.summary, c.example || "", topicName, c.topic].join("\n").toLowerCase();
  // 支持中英文：整句与按空白分词（AND）
  const raw = q.trim().toLowerCase();
  if (!raw) return true;
  if (blob.includes(raw)) return true;
  return raw.split(/\s+/).filter(Boolean).every((tok) => blob.includes(tok));
}

function helpCmdCard(c, { showTopic = false } = {}) {
  const params = [];
  const m = c.usage.match(/[<\[][^>\]]+[>\]]/g);
  if (m) params.push(...m);
  const topicName = helpTopics().find((t) => t.id === c.topic)?.name || c.topic;
  return `<article class="help-cmd">
    <div class="help-cmd-top">
      <code class="help-usage">${esc(c.usage)}</code>
      ${showTopic ? `<span class="tag tag-muted">${esc(topicName)}</span>` : ""}
      ${c.home ? `<span class="tag tag-ok">常用</span>` : ""}
    </div>
    <p class="help-summary">${esc(c.summary)}</p>
    ${
      params.length
        ? `<div class="help-params"><span class="help-params-label">参数</span> ${params
            .map((x) => `<code>${esc(x)}</code>`)
            .join(" ")}</div>`
        : ""
    }
    ${c.example ? `<div class="help-example"><span class="help-params-label">示例</span> <code>${esc(c.example)}</code></div>` : ""}
  </article>`;
}

function helpTopics() {
  return state._helpTopics || HELP_TOPICS;
}
function helpCommands() {
  return state._helpCommands || HELP_COMMANDS;
}

function getHelpFiltered() {
  const q = (state.helpQuery || "").trim().toLowerCase();
  const searching = Boolean(q);
  const topic = state.helpTopic || "session";
  const topics = helpTopics();
  const commands = helpCommands();
  const topicMeta = topics.find((t) => t.id === topic) || topics[0];
  const matched = commands.filter((c) => matchHelpCmd(c, q));
  const cmds = matched.filter((c) => c.topic === topic);
  return { q, searching, topic, topicMeta, matched, cmds, topics, commands };
}

/** 只刷新 tabs / 结果 / 清除按钮，绝不重建搜索框（避免打断中文 IME） */
function updateHelpResults() {
  const root = $("#view-help");
  if (!root || !root.querySelector("#help-q")) {
    renderHelp();
    return;
  }
  const { searching, topic, topicMeta, matched, cmds } = getHelpFiltered();

  const allTopics = helpTopics();
  const allCmds = helpCommands();
  const tabs = allTopics.map((t) => {
    // 有搜索词时显示该分类命中数；无搜索时显示分类总量
    const n = searching
      ? matched.filter((c) => c.topic === t.id).length
      : allCmds.filter((c) => c.topic === t.id).length;
    return `<button type="button" class="help-tab ${t.id === topic ? "is-active" : ""}" data-topic="${t.id}">${esc(
      t.name,
    )}<span class="help-tab-sub">${esc(t.desc)} · ${n}</span></button>`;
  }).join("");

  const tabsEl = $("#help-tabs");
  if (tabsEl) tabsEl.innerHTML = tabs;

  const clearHost = $("#help-clear-host");
  if (clearHost) {
    clearHost.innerHTML = searching
      ? `<button type="button" class="btn btn-sm" id="help-clear">清除</button>`
      : "";
    $("#help-clear")?.addEventListener("click", () => {
      state.helpQuery = "";
      const input = $("#help-q");
      if (input) input.value = "";
      updateHelpResults();
      input?.focus();
    });
  }

  const hint = $("#help-search-hint");
  if (hint) {
    hint.hidden = !searching;
    if (searching) {
      hint.textContent = `搜索中：先匹配全部命令，再按上方分类筛选（当前分类 ${cmds.length} / 共 ${matched.length} 条命中）`;
    }
  }

  const headTitle = searching
    ? `${esc(topicMeta.name)} · 搜索「${esc((state.helpQuery || "").trim())}」`
    : `${esc(topicMeta.name)} · ${esc(topicMeta.desc)}`;
  const headSub = searching
    ? `本分类 ${cmds.length} 条 · 全部分类共 ${matched.length} 条命中`
    : `${cmds.length} 条指令`;
  const titleEl = $("#help-result-title");
  const subEl = $("#help-result-sub");
  if (titleEl) titleEl.innerHTML = headTitle;
  if (subEl) subEl.textContent = headSub;

  const list = $("#help-list");
  if (list) {
    const rows = cmds.map((c) => helpCmdCard(c, { showTopic: false })).join("");
    list.innerHTML =
      rows ||
      `<div class="empty">${
        searching
          ? matched.length
            ? "当前分类下没有匹配，点上方其它分类看看"
            : "没有匹配的命令，试试更短的关键词"
          : "该分类暂无命令"
      }</div>`;
  }

  $$("#help-tabs .help-tab").forEach((b) => {
    b.onclick = () => {
      state.helpTopic = b.dataset.topic;
      // 保留搜索词，只切换分类
      updateHelpResults();
    };
  });
}

function wireHelpSearchInput(input) {
  if (!input || input.dataset.wired === "1") return;
  input.dataset.wired = "1";

  let composing = false;
  let debounce;

  const apply = () => {
    state.helpQuery = input.value;
    updateHelpResults();
  };

  input.addEventListener("compositionstart", () => {
    composing = true;
  });
  input.addEventListener("compositionend", () => {
    composing = false;
    // 组字结束：立刻按完整汉字过滤
    clearTimeout(debounce);
    apply();
  });
  input.addEventListener("input", () => {
    // 组字过程中不要重绘，否则 IME 候选/输入会被打断
    if (composing || input.isComposing) return;
    clearTimeout(debounce);
    debounce = setTimeout(apply, 120);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      state.helpQuery = "";
      input.value = "";
      updateHelpResults();
      input.focus();
    }
  });
}

function renderHelp() {
  if (!state.data) return;
  renderTopConn();
  renderAlert();

  const existing = $("#help-q");
  // 若搜索框已在 DOM 且仍在帮助页，只增量更新（切页后首屏仍全量渲染）
  if (existing && $("#view-help") && !($("#view-help").hidden)) {
    // 保留输入框焦点与值，只刷结果
    if (document.activeElement === existing) {
      updateHelpResults();
      return;
    }
  }

  const { searching } = getHelpFiltered();

  $("#view-help").innerHTML = `
    <div class="card">
      <div class="card-head">
        <div>
          <h2>命令帮助</h2>
          <p class="sub">与插件 /hapi help 主题一致 · 管理员可用 · 前缀默认 /hapi</p>
        </div>
      </div>
      <div class="help-search-row">
        <input id="help-q" class="ctrl help-search" type="text" inputmode="search" enterkeyhint="search"
          placeholder="搜索命令、说明、参数… 如 resume / 审批 / bind" value="${attr(state.helpQuery || "")}"
          autocomplete="off" spellcheck="false" />
        <span id="help-clear-host"></span>
      </div>
      <div id="help-tabs" class="help-tabs"></div>
      <p id="help-search-hint" class="help-search-hint" ${searching ? "" : "hidden"}>搜索中：关键词匹配后仍可点分类筛选；清除或 Esc 退出搜索</p>
    </div>

    <div class="card">
      <div class="card-head">
        <div>
          <h2 id="help-result-title">—</h2>
          <p class="sub" id="help-result-sub"></p>
        </div>
      </div>
      <div id="help-list" class="help-list"></div>
    </div>
  `;

  wireHelpSearchInput($("#help-q"));
  updateHelpResults();
}

/* ---------- settings ---------- */

function parseKindsDraft(d) {
  if (Array.isArray(d.render_kinds_list) && d.render_kinds_list.length) {
    return d.render_kinds_list.map((x) => String(x).trim()).filter(Boolean);
  }
  return String(d.render_kinds || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function fieldControl(f, d) {
  if (f.type === "enum_cards") {
    return `<div class="enum-cards">${f.options
      .map(
        (o) => `<label class="enum-card">
        <input type="radio" name="${f.key}" value="${o.value}" ${d[f.key] === o.value ? "checked" : ""} />
        <div class="t">${esc(o.title)}</div>
        <div class="d">${esc(o.desc)}</div>
      </label>`,
      )
      .join("")}</div>`;
  }
  if (f.type === "kind_checks") {
    const on = new Set(parseKindsDraft(d));
    return `<div class="chk-grid" data-kind-checks="${attr(f.key)}">${Object.keys(RENDER_KIND_LABELS)
      .map((k) => {
        const checked = on.has(k);
        return `<label class="chk"><input type="checkbox" data-settings-kind value="${k}" ${
          checked ? "checked" : ""
        }/> ${esc(RENDER_KIND_LABELS[k])}</label>`;
      })
      .join("")}</div>`;
  }
  if (f.type === "bool") {
    const [offL, onL] = f.boolLabels || ["关闭", "开启"];
    const on = Boolean(d[f.key]);
    let html = `<label class="switch">
      <input type="checkbox" name="${f.key}" ${on ? "checked" : ""} />
      <span class="switch-track" aria-hidden="true"></span>
      <span class="switch-text">${on ? onL : offL}</span>
    </label>`;
    if (f.warn && on) {
      html += `<div class="field-warn">⚠ ${esc(f.warn)}</div>`;
    }
    return html;
  }
  if (f.sensitive) {
    const ph =
      f.key === "access_token" && state.data.config.access_token_configured
        ? `已配置${
            state.data.config.access_token_namespace
              ? " · ns=" + state.data.config.access_token_namespace
              : ""
          }，留空不修改`
        : "输入新值；留空不修改";
    return `<input type="password" class="ctrl" name="${f.key}" value="" placeholder="${attr(
      ph,
    )}" autocomplete="off" />`;
  }
  const t = f.type === "number" ? "number" : f.type === "time" ? "time" : "text";
  return `<input type="${t}" class="ctrl" name="${f.key}" value="${attr(d[f.key] ?? "")}" ${
    f.placeholder ? `placeholder="${attr(f.placeholder)}"` : ""
  } />`;
}

function fieldVisible(f, d) {
  if (!f.showIf) return true;
  return d[f.showIf.key] === f.showIf.eq;
}

function renderField(f, d) {
  if (!fieldVisible(f, d)) return "";
  return `<div class="field">
    <div class="field-label-row">
      <div class="field-label">${esc(f.label)}</div>
      ${f.need ? `<span class="field-need">建议先填</span>` : ""}
    </div>
    ${f.help ? `<p class="field-help">${esc(f.help)}</p>` : ""}
    ${fieldControl(f, d)}
  </div>`;
}

function renderSettings() {
  if (!state.data) return;
  if (!state.draft) state.draft = structuredClone(state.data.config || {});
  renderTopConn();
  renderAlert();

  $("#settings-nav").innerHTML = SETTINGS.map(
    (b) =>
      `<button type="button" data-sec="${b.id}" class="${
        state.settingsSection === b.id ? "is-active" : ""
      }">${esc(b.nav)}</button>`,
  ).join("");

  $$("#settings-nav button").forEach((b) => {
    b.onclick = () => {
      state.settingsSection = b.dataset.sec;
      renderSettings();
      document.getElementById(`sec-${b.dataset.sec}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
    };
  });

  const d = state.draft;
  $("#settings-form").innerHTML = SETTINGS.map((b) => {
    const main = b.fields.map((f) => renderField(f, d)).join("");
    const adv = b.advanced
      ? `<details class="advanced">
          <summary>
            <span class="adv-chevron" aria-hidden="true">▸</span>
            <span class="adv-summary-body">
              <span class="adv-title">${esc(b.advanced.title)}</span>
              <span class="adv-hint">点击展开</span>
            </span>
          </summary>
          <div class="adv-body">
            <p class="note">${esc(b.advanced.note || "")}</p>
            ${b.advanced.fields.map((f) => renderField(f, d)).join("")}
          </div>
        </details>`
      : "";
    return `<section id="sec-${b.id}" class="settings-section">
      <h2>${esc(b.title)}</h2>
      <p class="desc">${esc(b.desc)}</p>
      ${main}${adv}
    </section>`;
  }).join("");

  $$("#settings-form input").forEach((input) => {
    input.onchange = () => {
      if (input.dataset.settingsKind != null) {
        const kinds = [...document.querySelectorAll("[data-settings-kind]")]
          .filter((el) => el.checked)
          .map((el) => el.value);
        state.draft.render_kinds = kinds.join(",") || "session_list,pending,message";
        state.draft.render_kinds_list = kinds;
        return;
      }
      if (input.type === "checkbox") {
        state.draft[input.name] = input.checked;
        const sw = input.closest(".switch");
        const txt = sw?.querySelector(".switch-text");
        if (txt) {
          const f = allSettingsFields().find((x) => x.key === input.name);
          const [offL, onL] = f?.boolLabels || ["关闭", "开启"];
          txt.textContent = input.checked ? onL : offL;
        }
      } else if (input.type === "radio") state.draft[input.name] = input.value;
      else if (input.type === "number") state.draft[input.name] = Number(input.value);
      else state.draft[input.name] = input.value;
      if (
        input.name === "auto_approve_enabled" ||
        input.name === "output_level" ||
        input.name === "remind_pending" ||
        input.name === "render_mode"
      ) {
        renderSettings();
      }
    };
  });
}


function allSettingsFields() {
  const list = [];
  for (const b of SETTINGS) {
    list.push(...b.fields);
    if (b.advanced?.fields) list.push(...b.advanced.fields);
  }
  return list;
}

/* saveSettings() defined later as async in data layer */

function toast(msg) {
  let el = $("#settings-toast");
  if (!el || $("#view-settings")?.hidden) {
    // 非设置页：用顶栏 alert 短暂提示
    const slot = $("#alert");
    if (!slot) return;
    slot.hidden = false;
    slot.innerHTML = `<div class="alert" style="border-color:var(--cursor);background:var(--cursor-dim)"><span>${esc(msg)}</span></div>`;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => {
      // 不覆盖休眠 alert：仅当仍是我们的 toast 时清空
      if (slot.querySelector(".alert") && !slot.querySelector(".alert-danger")) {
        slot.hidden = true;
        slot.innerHTML = "";
      }
    }, 2400);
    return;
  }
  el.hidden = false;
  el.textContent = msg;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => {
    el.hidden = true;
  }, 2400);
}

/* ---------- detail dialog ---------- */

function openDetail(id) {
  const s = state.data.sessions.find((x) => x.id === id);
  if (!s) return;
  const why = {
    session_bind: "已绑定聊天会话，通知优先推到这里（创建 session 时插件会默认绑定）。",
    flavor_default: "未单独绑定，按当前 Agent 的推送设置落到此窗口。",
    primary: "未单独绑定，且该 Agent 未设推送窗口，落到默认推送窗口。",
    none: "会话绑定、Agent 对应推送窗口、默认推送窗口都没有，通知发不出去。",
  }[s.layer];

  $("#dlg-title").textContent = s.title;
  $("#dlg-body").innerHTML = `
    <pre class="dlg-pre">${esc(
      [
        `Session:  ${s.id_short}…`,
        `标题:     ${s.title}`,
        `代理:     ${s.flavor}`,
        `路径:     ${s.path}`,
        `状态:     ${statusLabel(s)}`,
        `权限:     ${s.permissionMode}`,
        `模型:     ${s.modelMode}`,
        `通知去向: ${wTitle(s.effective_umo)}（${LAYER[s.layer].text}）`,
      ].join("\n"),
    )}</pre>
    <label class="dlg-field">权限
      <select id="dlg-perm" class="ctrl">
        ${(PERM[s.flavor] || ["default"])
          .map((p) => `<option value="${p}" ${p === s.permissionMode ? "selected" : ""}>${p}</option>`)
          .join("")}
      </select>
    </label>
    <label class="dlg-field">通知投递
      <select id="dlg-bind" class="ctrl">${bindSelect(s)}</select>
    </label>
    <div class="dlg-actions">
      <button type="button" class="btn btn-sm" data-life="resume">恢复</button>
      <button type="button" class="btn btn-sm" data-life="archive">归档</button>
      <button type="button" class="btn btn-sm btn-danger" data-life="delete">删除</button>
    </div>
    <p class="dlg-why">${esc(why)}</p>`;

  $("#dlg").showModal();
  $("#dlg-perm").onchange = async () => {
    const mode = $("#dlg-perm").value;
    try {
      if (liveMode && api) {
        const res = await api.setPermission(id, mode);
        toast(res.message || "权限已更新");
        if (!applySnapFromResult(res)) await refresh();
        else renderTopConn();
        openDetail(id);
        return;
      }
      store.setPermission(id, mode);
      await refresh();
      openDetail(id);
    } catch (err) {
      toast("权限切换失败: " + (err.message || err));
      await refresh();
      openDetail(id);
    }
  };
  $("#dlg-bind").onchange = async () => {
    const umo = $("#dlg-bind").value || null;
    try {
      if (liveMode && api) {
        const res = await api.bindSession(id, umo);
        toast(res.message || "绑定已更新");
        if (!applySnapFromResult(res)) await refresh();
        else { renderTopConn(); renderSessions(); }
        openDetail(id);
        return;
      }
      store.bind(id, umo);
      await refresh();
      openDetail(id);
    } catch (err) {
      toast("绑定失败: " + (err.message || err));
      await refresh();
      openDetail(id);
    }
  };
  $$("#dlg-body [data-life]").forEach((b) => {
    b.onclick = async (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const action = b.dataset.life;
      const labels = { resume: "恢复", archive: "归档", delete: "删除" };
      const label = labels[action] || action;
      if (action === "delete" && !confirm("确定删除？不可恢复。")) return;
      if (action === "resume" && !confirm("恢复后可能得到新 session id，继续？")) return;
      if (action === "archive" && !confirm("确定归档？")) return;
      $$("#dlg-body [data-life]").forEach((x) => {
        x.disabled = true;
        x.classList.add("is-busy");
      });
      try {
        if (!liveMode || !api) {
          const res = store.lifecycle(id, action);
          state.selected.delete(id);
          toast(`${label}完成（本地 mock）`);
          if (action === "delete") {
            $("#dlg").close();
            await refresh({ repaint: true });
            return;
          }
          await refresh({ repaint: true });
          openDetail(res.new_id || id);
          return;
        }
        const res = await api.lifecycle(id, action);
        // 单条 lifecycle 失败时后端走 error_response，bridge 会抛；这里防业务体 ok:false
        if (res && res.ok === false) {
          throw new Error(res.message || `${label}失败`);
        }
        toast(res?.message || `${label}成功`);
        state.selected.delete(id);
        if (res?.snapshot) applySnapFromResult(res);
        if (action === "delete") {
          $("#dlg").close();
          await refresh({ fresh: true, repaint: true });
          return;
        }
        await refresh({ fresh: true, repaint: true });
        openDetail(res?.new_id || id);
      } catch (err) {
        console.error("lifecycle", action, id, err);
        toast(`${label}失败: ` + (err.message || err));
        await refresh({ fresh: true, repaint: true });
      }
    };
  });
}

/* ---------- 打开官方 HAPI（连接信息按钮） ---------- */

async function copyTextSafe(text) {
  const s = String(text || "");
  if (!s) throw new Error("空内容");
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(s);
      return;
    }
  } catch (_) {}
  const ta = document.createElement("textarea");
  ta.value = s;
  ta.setAttribute("readonly", "");
  ta.style.cssText = "position:fixed;left:-9999px;top:0";
  document.body.appendChild(ta);
  ta.select();
  const ok = document.execCommand("copy");
  ta.remove();
  if (!ok) throw new Error("copy failed");
}

/** 插件页 iframe 里 window.open 常抛 NotSupportedError，用 <a target=_blank> 打开 */
function openHubUrl(url) {
  if (!url) {
    toast("没有可用链接");
    return false;
  }
  try {
    const a = document.createElement("a");
    a.href = url;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    a.remove();
    return true;
  } catch (_) {}
  try {
    const w = window.open(url, "_blank");
    if (w) return true;
  } catch (_) {}
  copyTextSafe(url)
    .then(() => toast("无法自动打开，链接已复制，请粘贴到新标签页"))
    .catch(() => toast("无法自动打开，请到设置查看 HAPI 地址后手动访问"));
  return false;
}

async function fetchHubLaunch(opts = {}) {
  const autologin = opts.autologin !== false;
  if (liveMode && api) {
    return api.hubLaunch({ autologin });
  }
  const cfg = state.data?.config || {};
  const endpoint = String(cfg.hapi_endpoint || "http://127.0.0.1:3006").replace(/\/$/, "");
  const page = endpoint + "/";
  let url = page + "?hub=" + encodeURIComponent(endpoint);
  if (autologin && cfg.access_token_configured) url += "&token=demo";
  return { ok: true, url, url_display: page, origin: endpoint };
}

/* ---------- boot ---------- */

/* ---------- live / mock data layer ---------- */

let api = null; // bridge API or null
let liveMode = false;

function applySnapFromResult(res) {
  if (res && res.snapshot) {
    state.data = res.snapshot;
    return true;
  }
  return false;
}

async function fetchSnapshot(opts = {}) {
  if (!liveMode || !api) return store.snap();
  const snap = await api.sessionsSnapshot(opts);
  if (!snap || typeof snap !== "object") {
    throw new Error("sessions/snapshot 返回空或非对象");
  }
  if (!snap.columns) snap.columns = [];
  if (!snap.window_options) snap.window_options = [];
  if (!snap.defaults) snap.defaults = { primary: null, flavor: {}, writable: false };
  if (!snap.connection) {
    snap.connection = {
      sse_status: "disconnected",
      endpoint_host: "—",
      conn_fail_count: 0,
      conn_error: "snapshot 未包含 connection",
    };
  }
  if (!snap.config || typeof snap.config !== "object" || snap.config._error) {
    // config 通常已在 snapshot 内；缺省/出错时再拉一次，避免显示 mock 默认值
    try {
      const cfgRes = await api.config();
      const cfg = cfgRes?.config || cfgRes;
      if (cfg && typeof cfg === "object") snap.config = cfg;
    } catch (e) {
      console.warn("config fallback failed", e);
      if (!snap.config) snap.config = state.data?.config || {};
      snap.config_error = e.message || String(e);
    }
  }
  return snap;
}

/** @param {{fresh?: boolean, silent?: boolean, repaint?: boolean}} opts
 * silent: 轮询/后台刷新——只更新数据与顶栏，不重绘表单（避免下拉/输入被打回）
 * repaint: 强制按当前页重绘（保存后需要时）
 */
async function refresh(opts = {}) {
  try {
    state.data = await fetchSnapshot(opts);
  } catch (e) {
    console.error(e);
    if (!opts.silent) showAlert(e.message || String(e));
    return;
  }
  const live = new Set((state.data.sessions || []).map((s) => s.id));
  for (const id of [...state.selected]) if (!live.has(id)) state.selected.delete(id);
  renderTopConn();
  renderAlert();

  // 静默刷新：不碰当前页表单（会话下拉、交互配置、设置草稿）
  if (opts.silent && !opts.repaint) {
    return;
  }

  if (state.page === "overview") renderOverview();
  else if (state.page === "sessions") renderSessions();
  else if (state.page === "interact") renderInteract();
  else if (state.page === "help") renderHelp();
  else if (state.page === "settings") renderSettings();
}

/* ---------- visibility-aware auto refresh (never wakes SSE) ---------- */

const POLL_MS = 12000; // 12s；服务端还有 20s sessions TTL，多数请求只读内存
let pollTimer = null;
let pollInFlight = false;

function stopPolling() {
  if (pollTimer != null) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function startPolling() {
  stopPolling();
  if (!liveMode) return;
  pollTimer = setInterval(async () => {
    if (document.hidden) return;
    if (pollInFlight) return;
    // 有 dialog 打开时不抢渲染
    if ($("#dlg")?.open) return;
    pollInFlight = true;
    try {
      // 默认不 fresh：走 soft_refresh + 内存 snapshot，不唤醒 SSE
      await refresh({ silent: true, fresh: false });
    } catch (_) {
      /* 静默 */
    } finally {
      pollInFlight = false;
    }
  }, POLL_MS);
}

function onVisibility() {
  if (document.hidden) {
    stopPolling();
  } else {
    // 回到前台：立刻静默刷一次（仍不 force HAPI，除非缓存过期）
    if (liveMode) {
      refresh({ silent: true, fresh: false }).finally(() => startPolling());
    }
  }
}

function showAlert(msg) {
  const el = $("#alert");
  if (!el) return;
  el.hidden = false;
  el.innerHTML = `<div class="alert alert-danger"><span>${esc(msg)}</span></div>`;
}

// override mock store methods when live
function wireLiveMutations() {
  if (!liveMode || !api) return;

  store.saveConfig = async (patch) => {
    const res = await api.saveConfig(patch);
    if (res?.config) {
      // merge into next snap via refresh
    }
    return res;
  };
  store.wake = async () => {
    await api.wake();
  };
}

async function saveSettings() {
  const prev = state.data.config;
  const draft = state.draft;
  // 设置页出图类型勾选 → 同步到 draft 字符串
  const kindBoxes = [...document.querySelectorAll("[data-settings-kind]")];
  if (kindBoxes.length) {
    const kinds = kindBoxes.filter((el) => el.checked).map((el) => el.value);
    draft.render_kinds = kinds.join(",") || "session_list,pending,message";
    draft.render_kinds_list = kinds;
  }
  const patch = {};
  for (const f of allSettingsFields()) {
    if (f.sensitive) continue;
    if (draft[f.key] !== prev[f.key]) patch[f.key] = draft[f.key];
  }
  const token = document.querySelector('#settings-form input[name="access_token"]')?.value;
  const secret = document.querySelector('#settings-form input[name="cf_access_client_secret"]')?.value;
  if (token) patch.access_token = token;
  if (secret) patch.cf_access_client_secret = secret;
  if (!Object.keys(patch).length) {
    toast("没有变更");
    return;
  }
  try {
    if (liveMode && api) {
      const res = await api.saveConfig(patch);
      toast(res.message || "已保存");
      if (res.reconnect_required) {
        showAlert("已保存。连接类配置需重连后完全生效 — 可点概览「按配置重连 HAPI」。");
      }
    } else {
      store.saveConfig(patch);
      toast("已保存");
    }
    state.draft = null;
    await refresh();
    renderSettings();
  } catch (e) {
    toast("保存失败: " + (e.message || e));
  }
}

function bindShell() {
  ensureFxLayer();
  $$("#nav .side-link").forEach((b) => {
    b.onclick = () => go(b.dataset.page);
  });

  $("#btn-menu")?.addEventListener("click", () => {
    $("#app").classList.add("sidebar-open");
    $("#scrim").hidden = false;
  });
  $("#scrim")?.addEventListener("click", closeSidebar);
  $("#btn-refresh")?.addEventListener("click", () => {
    // 手动刷新才 force 拉 HAPI；仍不 wake SSE
    refresh({ fresh: true });
  });
  $("#dlg-close")?.addEventListener("click", () => $("#dlg").close());
  $("#btn-settings-save")?.addEventListener("click", () => saveSettings());
  $("#btn-settings-reset")?.addEventListener("click", async () => {
    const snap = await fetchSnapshot();
    state.draft = structuredClone(snap.config);
    renderSettings();
    toast("已撤销未保存修改");
  });
}

async function boot() {
  ensureFxLayer();
  bindShell();

  if (hasBridge()) {
    try {
      const { bridge, ctx } = await initBridge();
      api = createApi(bridge);
      liveMode = true;
      wireLiveMutations();

      // theme / locale：初始 + onContext 跟随 Dashboard
      const applyCtx = (c) => {
        const dark = Boolean(c?.isDark);
        document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
        try {
          document.documentElement.lang = bridge.getLocale?.() || c?.locale || "zh-CN";
        } catch (_) {
          /* ignore */
        }
      };
      applyCtx(ctx);
      if (typeof bridge.onContext === "function") {
        const offCtx = bridge.onContext(applyCtx);
        if (typeof offCtx === "function") {
          window.addEventListener("beforeunload", offCtx);
        }
      }

      // load help from server (fallback: bundled HELP_*)
      try {
        const help = await api.help();
        if (help?.topics?.length && help?.commands?.length) {
          state._helpTopics = help.topics;
          state._helpCommands = help.commands;
        }
      } catch (e) {
        console.warn("help load failed, using bundled", e);
      }
      // meta: permission modes + render default_css 等
      try {
        const meta = await api.meta();
        state.meta = meta || null;
        if (meta?.permission_modes) {
          Object.assign(PERM, meta.permission_modes);
        }
      } catch (e) {
        console.warn("meta load failed", e);
      }
    } catch (e) {
      console.error("bridge init failed", e);
      showAlert("Bridge 初始化失败: " + (e.message || e));
      liveMode = false;
    }
  }

  try {
    state.data = await fetchSnapshot();
  } catch (e) {
    console.error(e);
    showAlert("加载数据失败: " + (e.message || e) + "（请查 AstrBot 日志中的 WebUI *failed）");
    // 空壳：不填 mock 默认配置，避免与真实设置混淆
    state.data = {
      connection: {
        sse_status: "disconnected",
        endpoint_host: "—",
        conn_fail_count: 0,
        conn_error: e.message || String(e),
        source: "frontend_fallback",
      },
      metrics: { active: 0, thinking: 0, pending: 0, unrouted: 0, total: 0 },
      sessions: [],
      columns: [],
      defaults: { primary: null, flavor: {}, writable: false },
      window_options: [],
      config: {},
      error: e.message || String(e),
    };
    // 仍尝试单独拉 config，尽量显示真实设置
    if (liveMode && api) {
      try {
        const cfgRes = await api.config();
        state.data.config = cfgRes?.config || cfgRes || {};
      } catch (e2) {
        console.warn("boot config failed", e2);
      }
    }
  }
  state.focusWindow = state.data.columns[0]?.umo || "__none__";
  go("overview");

  if (liveMode) {
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("beforeunload", stopPolling);
    if (!document.hidden) startPolling();
  }
}

boot();
