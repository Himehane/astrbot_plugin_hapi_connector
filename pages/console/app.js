/**
 * HAPI Connector WebUI · pages/console
 * - AstrBot iframe：window.AstrBotPluginPage bridge
 * - 本地预览（无 bridge）：内置 mock
 * 规范见 dev-docs/plugin-pages.md
 *
 * 页面：概览 / 会话 / 交互 / 命令帮助 / 设置
 */

import { hasBridge, initBridge, createApi } from "./api.js";

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
  hub: { title: "HAPI 网页", desc: "用已配置的 endpoint / token 打开官方 HAPI Web（可内嵌）" },
  interact: { title: "交互优化", desc: "快捷操作、审批体验与推送呈现（样式 / 预览）" },
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
        type: "password",
        need: true,
        sensitive: true,
        help: "HAPI 访问口令，支持 token:namespace。不回显已保存内容，留空表示不修改。",
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
        key: "default_notification_window",
        label: "配置级默认推送窗口 ID",
        type: "text",
        help: "多数用聊天 /hapi bind 设默认推送窗口。这里是配置里的窗口 ID；不确定请留空。",
      },
      {
        key: "render_mode",
        label: "推送呈现模式",
        type: "enum_cards",
        help: "结构信息是否出卡片。详细样式与预览请到「交互优化」页。需可选依赖 Pillow。",
        options: [
          { value: "text", title: "纯文本", desc: "全部文字推送，速度最快（默认）。" },
          { value: "auto", title: "结构出卡", desc: "list/pending 等出卡片，Agent 对话仍文本。" },
          { value: "card", title: "尽量出卡", desc: "更多结构类型出卡；未装 Pillow 时回退文本。" },
        ],
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
        help: "一直没处理时按间隔再提醒，避免 AI 干等。",
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
  { topic: "push", usage: "/hapi bind [<flavor>]", summary: "设置当前聊天为默认推送窗口；带 flavor（如 claude/codex）时只对对应 agent 生效", example: "/hapi bind claude", home: true },
  { topic: "push", usage: "/hapi bind status", summary: "查看默认推送窗口、flavor 推送窗口和 session 绑定状态", example: null, home: true },
  { topic: "push", usage: "/hapi routes", summary: "查看当前生效的会话推送路由", example: null, home: false },
  { topic: "push", usage: "/hapi bind reset", summary: "清空会话路由和窗口状态，保留默认推送窗口和 flavor 推送窗口", example: null, home: true },
  { topic: "files", usage: "/hapi files [路径]", summary: "浏览远端目录", example: "/hapi files src", home: true },
  { topic: "files", usage: "/hapi files -l [路径]", summary: "浏览目录并显示文件大小", example: "/hapi files -l .", home: false },
  { topic: "files", usage: "/hapi find <关键词>", summary: "搜索远端文件", example: "/hapi find config", home: true },
  { topic: "files", usage: "/hapi download <路径>", summary: "下载远端文件到聊天（别名: /hapi dl）", example: "/hapi dl logs/app.log", home: true },
  { topic: "files", usage: "/hapi upload [cancel]", summary: "上传文件到当前 session，支持快捷前缀附件", example: "/hapi upload", home: true },
  { topic: "config", usage: "/hapi perm [模式]", summary: "查看或切换权限模式", example: null, home: true },
  { topic: "config", usage: "/hapi plan", summary: "切换 Plan 模式（toggle）。Claude 切换 permissionMode，Codex 切换 collaborationMode", example: null, home: true },
  { topic: "config", usage: "/hapi model [模式]", summary: "查看或切换当前使用的模型（Claude / Gemini）", example: null, home: true },
  { topic: "config", usage: "/hapi effort [值]", summary: "查看或切换推理强度。Claude：auto/medium/high/max；Codex：none/minimal/low/medium/high/xhigh", example: "/hapi effort high", home: true },
  { topic: "config", usage: "/hapi output [级别]", summary: "查看或切换推送级别 silence/simple/summary/detail", example: "/hapi output summary", home: true },
  { topic: "config", usage: "/hapi remote", summary: "切换当前 session 到 remote 托管模式", example: null, home: true },
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

function wTitle(u) {
  if (!u) return "—";
  const opt = (state.data?.window_options || []).find((w) => w.umo === u);
  if (opt?.title) return opt.title;
  if (u.includes("FriendMessage") || u.includes("Private")) {
    const tail = u.split(":").pop();
    return tail && tail !== u ? `私聊 · ${tail}` : "私聊";
  }
  if (u.includes("GroupMessage") || /group/i.test(u)) {
    const tail = u.split(":").pop();
    return tail && tail !== u ? `群 · ${tail}` : "群聊";
  }
  return u.length > 28 ? u.slice(0, 14) + "…" + u.slice(-10) : u;
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
    access_token_configured: true,
    access_token_namespace: "default",
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
      { id: "approve", label: "批准待审", desc: "批准当前窗口可见的非 question 权限请求", emoji: "✅" },
      { id: "pending", label: "查看待审", desc: "列出当前窗口待审批请求", emoji: "📋" },
      { id: "list", label: "会话列表", desc: "列出当前窗口可见的 session", emoji: "☰" },
      { id: "status", label: "当前状态", desc: "查看当前绑定 session 状态", emoji: "◎" },
      { id: "stop", label: "中止当前", desc: "中止（abort）当前窗口生效中的 session", emoji: "⏹" },
      { id: "output_cycle", label: "切换推送级别", desc: "在 silence→simple→summary→detail 间循环", emoji: "📢" },
      { id: "none", label: "仅确认（无业务）", desc: "提示已收到戳一戳，不执行业务", emoji: "👋" },
    ],
    remind_pending: true,
    remind_interval: 180,
    auto_approve_enabled: false,
    auto_approve_start: "23:00",
    auto_approve_end: "07:00",
    default_notification_window: "",
    render_mode: "text",
    formula_mode: "off",
    render_kinds: "session_list,pending,status,permission",
    render_kinds_list: ["session_list", "pending", "status", "permission"],
    card_style_preset: "terminal_light",
    card_width: 720,
    card_accent: "#1a7f4b",
    card_bg: "#faf8f2",
    card_fg: "#1c1914",
    card_font_scale: 100,
    card_density: "comfortable",
    card_show_brand: true,
    card_mono: true,
    render_engine: { pillow: false, install_hint: "pip install Pillow" },
    card_style: {
      preset: "terminal_light",
      width: 720,
      bg: "#faf8f2",
      fg: "#1c1914",
      accent: "#1a7f4b",
      density: "comfortable",
      show_brand: true,
      mono: true,
      font_scale: 1,
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
  hub: {
    autologin: true,
    launch: null, // last hub/launch payload
    loadedUrl: null, // iframe currently showing (with token if autologin)
    error: null,
  },
};

function ruleText() {
  return `绑定会话优先；否则按 Agent 类型推送到对应推送窗口，未设置则推送到默认推送窗口。「按推送设置」= 不单独绑定。`;
}

function bindSelect(s) {
  const opts = state.data.window_options
    .map(
      (w) =>
        `<option value="${attr(w.umo)}" ${s.bound_umo === w.umo ? "selected" : ""}>${esc(w.title)}</option>`,
    )
    .join("");
  // 空值 = 不单独绑定，交给上方推送设置 / 默认推送窗口；分栏已表达「当前窗口」，不必写「现：xxx」
  return `<option value="" ${s.bound_umo ? "" : "selected"}>按推送设置</option>${opts}`;
}

/* ---------- shell render ---------- */

function renderTopConn() {
  const c = state.data.connection;
  const ok = c.sse_status === "connected";
  const label = ok ? "已连接" : c.sse_status === "hibernated" ? "已休眠" : "重连中";

  $("#top-conn").className = `conn-chip ${ok ? "ok" : "bad"}`;
  $("#top-conn").innerHTML = `<span class="dot"></span>${esc(label)} · ${esc(c.endpoint_host)}`;

  const foot = $("#sidebar-conn");
  foot.className = `sidebar-footer ${ok ? "ok" : "bad"}`;
  $("#sidebar-conn-text").textContent = label;
}

function renderAlert() {
  const c = state.data.connection;
  const el = $("#alert");
  if (c.sse_status === "hibernated") {
    el.hidden = false;
    el.innerHTML = `<div class="alert alert-danger">
      <span>SSE 已休眠（失败 ${c.conn_fail_count} 次）${c.conn_error ? " · " + esc(c.conn_error) : ""}</span>
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
  state.page = page;
  setPageChrome(page);
  closeSidebar();
  if (page === "overview") renderOverview();
  else if (page === "sessions") renderSessions();
  else if (page === "hub") renderHub();
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

  const c = state.data.connection;
  const m = state.data.metrics;
  const cfg = state.data.config;
  const ok = c.sse_status === "connected";
  const label = ok ? "已连接" : c.sse_status === "hibernated" ? "已休眠" : "重连中";

  const levelOpts = OUTPUT_LEVELS.map(
    (o) =>
      `<option value="${o.value}" ${cfg.output_level === o.value ? "selected" : ""}>${esc(o.title)}</option>`,
  ).join("");

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

    <div class="card">
      <div class="card-head">
        <div>
          <h2>常用设置</h2>
          <p class="sub">改完即时生效（demo）；完整项在「设置」</p>
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
        ${
          cfg.auto_approve_enabled
            ? `<label class="qs-field">
          <span class="qs-label">托管开始</span>
          <input id="qs-auto-start" class="ctrl" type="time" value="${attr(cfg.auto_approve_start || "23:00")}" />
        </label>
        <label class="qs-field">
          <span class="qs-label">托管结束</span>
          <input id="qs-auto-end" class="ctrl" type="time" value="${attr(cfg.auto_approve_end || "07:00")}" />
        </label>
        <div class="qs-field qs-note">
          <span class="qs-label">说明</span>
          <span class="qs-note-text">时段内权限请求将自动批准，可跨午夜（如 23:00–07:00）</span>
        </div>`
            : ""
        }
      </div>
    </div>

    <div class="card">
      <div class="card-head">
        <div>
          <h2>连接信息</h2>
          <p class="sub">来自当前插件配置（demo mock）</p>
        </div>
        <button type="button" class="linkish" data-go="settings">改连接 →</button>
      </div>
      <dl class="kv">
        <dt>Endpoint</dt><dd>${esc(cfg.hapi_endpoint || c.endpoint_host)}</dd>
        <dt>SSE</dt><dd>${esc(label)}</dd>
        <dt>Token</dt><dd>${cfg.access_token_configured ? "已配置" + (cfg.access_token_namespace ? " · ns=" + esc(cfg.access_token_namespace) : "") : "未配置"}</dd>
        <dt>推送级别</dt><dd>${esc(cfg.output_level)}</dd>
        <dt>代理</dt><dd>${esc(cfg.proxy_url || "无")}</dd>
        <dt>CF Access</dt><dd>${cfg.cf_access_enabled ? "已启用" : "未启用"}</dd>
      </dl>
    </div>

    <div class="card">
      <div class="card-head">
        <div>
          <h2>快捷操作</h2>
          <p class="sub">Demo 本地模拟</p>
        </div>
      </div>
      <div class="quick-actions">
        <button type="button" class="btn" data-go="sessions">管理会话 / 推送</button>
        <button type="button" class="btn" data-go="settings">打开设置</button>
        <button type="button" class="btn" id="btn-reconnect">按配置重连 HAPI</button>
        ${liveMode ? "" : `<button type="button" class="btn" id="btn-sim-hibernate">模拟 SSE 休眠</button>
        <button type="button" class="btn" id="btn-sim-wake">模拟唤醒</button>`}
      </div>
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
      await refresh();
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
      applyQuick({ auto_approve_enabled: $("#qs-auto").checked });
    });
  $("#qs-auto-start") &&
    ($("#qs-auto-start").onchange = () => applyQuick({ auto_approve_start: $("#qs-auto-start").value || "23:00" }));
  $("#qs-auto-end") &&
    ($("#qs-auto-end").onchange = () => applyQuick({ auto_approve_end: $("#qs-auto-end").value || "07:00" }));

  $$("#view-overview [data-go]").forEach((b) => {
    b.onclick = () => go(b.dataset.go);
  });
  $("#btn-reconnect")?.addEventListener("click", async () => {
    if (!confirm("按当前已保存配置重建 HAPI 客户端并重启 SSE？")) return;
    try {
      if (liveMode && api) {
        const res = await api.reconnect();
        toast(res.message || "已重连");
        await refresh();
      } else {
        store.wake();
        toast("demo：已模拟唤醒");
        await refresh();
      }
    } catch (e) {
      toast("重连失败: " + (e.message || e));
    }
  });
  $("#btn-sim-hibernate")?.addEventListener("click", async () => {
    store.hibernate();
    await refresh();
  });
  $("#btn-sim-wake")?.addEventListener("click", async () => {
    store.wake();
    await refresh();
  });
}

/* ---------- sessions (+ 推送路由) ---------- */
function renderRoutePanel() {
  const def = state.data.defaults;
  const opts = state.data.window_options;
  const winOpts = (selected) =>
    `<option value="">未设置</option>` +
    opts
      .map(
        (w) =>
          `<option value="${attr(w.umo)}" ${selected === w.umo ? "selected" : ""}>${esc(w.title)}</option>`,
      )
      .join("");

  const flavorCells = FLAVOR_ROUTE_KEYS.map(
    (f) => `<label class="route-cell">
      <span class="route-cell-label">${esc(f)} 推送窗口</span>
      <select class="ctrl-sm js-route-flavor" data-flavor="${f}">${winOpts(def.flavor[f] || "")}</select>
    </label>`,
  ).join("");

  $("#route-panel").innerHTML = `
    <div class="route-panel-inner">
      <div class="route-panel-head">
        <div>
          <div class="route-panel-title">推送设置</div>
          <p class="route-panel-sub">表内「按推送设置」时：优先按 Agent 类型推送到对应推送窗口；若未设置则推送到默认推送窗口</p>
        </div>
      </div>
      <div class="route-row">
        <label class="route-cell route-cell-primary">
          <span class="route-cell-label">默认推送窗口</span>
          <select id="route-primary" class="ctrl-sm">${winOpts(def.primary)}</select>
        </label>
        <div class="route-flavor-grid">${flavorCells}</div>
      </div>
    </div>`;

  const routeWritable = state.data.defaults?.writable !== false;
  const routeHint = state.data.defaults?.writable_reason || "";
  if (!routeWritable && liveMode) {
    $("#route-primary")?.setAttribute("disabled", "disabled");
    $$(".js-route-flavor").forEach((sel) => sel.setAttribute("disabled", "disabled"));
  }
  $("#route-primary").onchange = async () => {
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
  const cols = state.data.columns;
  if (!state.focusWindow) state.focusWindow = cols[0]?.umo || "__none__";

  $("#window-list").innerHTML = cols
    .map((col) => {
      const key = col.umo || "__none__";
      const on = state.focusWindow === key;
      const tags = [];
      if (col.is_primary) {
        tags.push(`<span class="tag tag-muted">默认推送窗口</span>`);
      }
      for (const f of col.flavors) {
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
  $("#rule-footnote").innerHTML = ruleText();
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

  // 全选：未全选 → 全选；已全选或半选再点 → 清空当前列表选择（可反选）
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

  $$("[data-batch]").forEach((b) => {
    b.onclick = async () => {
      const ids = visibleIds.filter((id) => state.selected.has(id));
      if (!ids.length) {
        alert("请先勾选 session");
        return;
      }
      const action = b.dataset.batch;
      if (action === "delete" && !confirm(`删除 ${ids.length} 个 session？`)) return;
      if (action === "archive" && !confirm(`归档 ${ids.length} 个 session？`)) return;
      if (action === "resume" && !confirm(`恢复 ${ids.length} 个？可能得到新 session id。`)) return;
      try {
        if (liveMode && api) {
          const res = await api.batchLifecycle(ids, action);
          toast(res.message || "批量完成");
          ids.forEach((id) => state.selected.delete(id));
          if (!applySnapFromResult(res)) await refresh();
          else { renderTopConn(); renderSessions(); }
          return;
        }
        for (const id of ids) store.lifecycle(id, action);
        ids.forEach((id) => state.selected.delete(id));
        await refresh();
      } catch (err) {
        toast("批量操作失败: " + (err.message || err));
        await refresh();
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

const RENDER_KIND_LABELS = {
  session_list: "Session 列表",
  pending: "待审批列表",
  status: "状态",
  permission: "权限请求卡",
  routes: "推送路由",
};

const RENDER_PRESETS = [
  { id: "terminal_light", label: "终端浅色" },
  { id: "terminal_dark", label: "终端深色" },
  { id: "clean", label: "简洁" },
  { id: "compact", label: "紧凑（手机）" },
];

const PRESET_STYLE = {
  terminal_light: { bg: "#faf8f2", fg: "#1c1914", accent: "#1a7f4b", width: 720 },
  terminal_dark: { bg: "#1c1914", fg: "#f0ebe0", accent: "#3ecf8e", width: 720 },
  clean: { bg: "#ffffff", fg: "#111827", accent: "#2563eb", width: 720 },
  compact: { bg: "#faf8f2", fg: "#1c1914", accent: "#1a7f4b", width: 560 },
};

function interactRenderState(cfg) {
  const kinds = Array.isArray(cfg.render_kinds_list)
    ? cfg.render_kinds_list
    : String(cfg.render_kinds || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
  return {
    render_mode: cfg.render_mode || "text",
    formula_mode: cfg.formula_mode || "off",
    kinds,
    card_style_preset: cfg.card_style_preset || "terminal_light",
    card_width: Number(cfg.card_width) || 720,
    card_accent: cfg.card_accent || "#1a7f4b",
    card_bg: cfg.card_bg || "#faf8f2",
    card_fg: cfg.card_fg || "#1c1914",
    card_font_scale: Number(cfg.card_font_scale) || 100,
    card_density: cfg.card_density || "comfortable",
    card_show_brand: cfg.card_show_brand !== false,
    card_mono: cfg.card_mono !== false,
  };
}

function sampleDomRows(kind) {
  if (kind === "pending") {
    return [
      { i: 1, a: "claude · auth-mw", b: "Bash · npm test" },
      { i: 2, a: "claude · auth-mw", b: "Edit · src/auth.ts" },
    ];
  }
  if (kind === "permission") {
    return [
      { i: 0, a: "工具", b: "Bash" },
      { i: 0, a: "命令", b: "pytest -q tests/test_auth.py" },
    ];
  }
  if (kind === "status") {
    return [
      { i: 0, a: "状态", b: "active · thinking" },
      { i: 0, a: "模型", b: "opus · effort high" },
      { i: 0, a: "路径", b: "/home/dev/proj-auth" },
    ];
  }
  if (kind === "routes") {
    return [
      { i: 1, a: "会话绑定", b: "群 A · 20001" },
      { i: 2, a: "Agent 窗口", b: "claude → 私聊" },
      { i: 3, a: "默认窗口", b: "私聊 · 10001" },
    ];
  }
  return [
    { i: 1, a: "claude", b: "重构鉴权中间件 · thinking" },
    { i: 2, a: "claude", b: "补 session 列表单测 · idle" },
    { i: 3, a: "codex", b: "API 文档生成 · active" },
  ];
}

function sampleTitle(kind) {
  return (
    {
      session_list: "Session 列表",
      pending: "待审批",
      status: "Session 状态",
      permission: "权限请求",
      routes: "推送路由",
    }[kind] || kind
  );
}

function sampleSub(kind) {
  return (
    {
      session_list: "当前窗口可见 · 3",
      pending: "当前窗口 2 项 · 全局 3 项",
      status: "claude · a1b2c3d4",
      permission: "序号 1 · claude · auth-mw",
      routes: "通知投递优先级",
    }[kind] || ""
  );
}

function sampleFooter(kind) {
  return (
    {
      session_list: "/hapi sw <n>  切换    > 消息  快捷发送",
      pending: "/hapi a  全部批准    /hapi pending  列表",
      status: "output=simple · render=auto",
      permission: "/hapi allow 1   /hapi deny 1",
      routes: "/hapi bind  ·  /hapi routes",
    }[kind] || ""
  );
}

function paintDomCardPreview() {
  const root = $("#ix-dom-preview");
  if (!root) return;
  const kind = $("#ix-sample")?.value || "session_list";
  const bg = $("#ix-bg")?.value || "#faf8f2";
  const fg = $("#ix-fg")?.value || "#1c1914";
  const accent = $("#ix-accent")?.value || "#1a7f4b";
  const width = Number($("#ix-width")?.value) || 720;
  const scale = (Number($("#ix-scale")?.value) || 100) / 100;
  const density = $("#ix-density")?.value || "comfortable";
  const brand = $("#ix-brand")?.checked;
  const mono = $("#ix-mono")?.checked;
  const pad = density === "compact" ? 12 : 18;
  const rows = sampleDomRows(kind)
    .map((r) => {
      const head = r.i ? `[${r.i}] ${r.a}` : r.a;
      return `<div class="rpc-row"><div class="rpc-head">${esc(head)}</div><div class="rpc-detail">${esc(r.b)}</div></div>`;
    })
    .join("");
  root.innerHTML = `
    <div class="render-preview-card" style="
      --rpc-bg:${attr(bg)};
      --rpc-fg:${attr(fg)};
      --rpc-accent:${attr(accent)};
      --rpc-muted:${attr(fg)}99;
      max-width:${Math.min(width, 640)}px;
      padding:${pad}px;
      font-family:${mono ? "var(--font)" : "var(--font-ui)"};
      font-size:${(13 * scale).toFixed(1)}px;
    ">
      <div class="rpc-title">${esc(sampleTitle(kind))}</div>
      <div class="rpc-sub">${esc(sampleSub(kind))}</div>
      <div class="rpc-bar"></div>
      ${rows}
      <div class="rpc-foot">${esc(sampleFooter(kind))}</div>
      ${brand ? `<div class="rpc-brand">hapi connector</div>` : ""}
    </div>`;
}

function collectRenderPatchFromForm() {
  const kindBoxes = [...document.querySelectorAll("[data-rkind]")];
  const kinds = kindBoxes.filter((el) => el.checked).map((el) => el.value);
  return {
    render_mode: $("#ix-rmode")?.value || "text",
    formula_mode: $("#ix-fmode")?.value || "off",
    render_kinds: kinds.join(",") || "session_list,pending",
    card_style_preset: $("#ix-preset")?.value || "terminal_light",
    card_width: Number($("#ix-width")?.value) || 720,
    card_accent: $("#ix-accent")?.value || "#1a7f4b",
    card_bg: $("#ix-bg")?.value || "#faf8f2",
    card_fg: $("#ix-fg")?.value || "#1c1914",
    card_font_scale: Number($("#ix-scale")?.value) || 100,
    card_density: $("#ix-density")?.value || "comfortable",
    card_show_brand: Boolean($("#ix-brand")?.checked),
    card_mono: Boolean($("#ix-mono")?.checked),
  };
}

function applyPresetToForm(presetId) {
  const p = PRESET_STYLE[presetId] || PRESET_STYLE.terminal_light;
  if ($("#ix-width")) $("#ix-width").value = p.width;
  if ($("#ix-accent")) $("#ix-accent").value = p.accent;
  if ($("#ix-bg")) $("#ix-bg").value = p.bg;
  if ($("#ix-fg")) $("#ix-fg").value = p.fg;
  if ($("#ix-width-val")) $("#ix-width-val").textContent = String(p.width);
  if (presetId === "compact" && $("#ix-density")) $("#ix-density").value = "compact";
  if (presetId === "clean" && $("#ix-mono")) $("#ix-mono").checked = false;
  if (presetId !== "clean" && $("#ix-mono") && presetId !== "compact") $("#ix-mono").checked = true;
  if (presetId === "compact" && $("#ix-brand")) $("#ix-brand").checked = false;
  if (presetId !== "compact" && $("#ix-brand")) $("#ix-brand").checked = true;
}

function renderInteract() {
  if (!state.data) return;
  renderTopConn();
  renderAlert();
  const cfg = state.data.config;
  const rs = interactRenderState(cfg);
  const engine = cfg.render_engine || {};
  const pillowOk = Boolean(engine.pillow);
  const kindChecks = Object.keys(RENDER_KIND_LABELS)
    .map((k) => {
      const on = rs.kinds.includes(k);
      return `<label class="chk"><input type="checkbox" data-rkind value="${k}" ${on ? "checked" : ""}/> ${esc(
        RENDER_KIND_LABELS[k],
      )}</label>`;
    })
    .join("");

  $("#view-interact").innerHTML = `
    <div class="card">
      <div class="card-head">
        <div>
          <h2>快捷操作</h2>
          <p class="sub">聊天侧前缀与可配置的戳一戳快捷动作。</p>
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
        <p class="field-help">一戳执行的安全快捷指令。默认「批准待审」兼容旧行为；可改为 list / stop / 切换推送级别等。</p>
        <div class="poke-action-grid" id="ix-poke-actions">
          ${(cfg.poke_actions || [])
            .map((a) => {
              const on = (cfg.poke_action || "approve") === a.id;
              return `<label class="poke-action-card ${on ? "is-on" : ""}">
                <input type="radio" name="ix-poke-action" value="${attr(a.id)}" ${on ? "checked" : ""} />
                <span class="pa-emoji" aria-hidden="true">${esc(a.emoji || "·")}</span>
                <span class="pa-label">${esc(a.label || a.id)}</span>
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
        <p class="field-help">默认 &gt; 时，「&gt; 继续修 bug」进当前会话；「&gt;2 内容」进列表第 2 个。</p>
        <input id="ix-prefix" class="ctrl" type="text" value="${attr(cfg.quick_prefix)}" style="max-width:220px" />
      </div>
    </div>

    <div class="card">
      <div class="card-head">
        <div>
          <h2>推送呈现</h2>
          <p class="sub">控制 list / 审批等<strong>结构化</strong>消息是否出卡片。Agent 对话流默认仍为纯文本以保证速度。卡片依赖可选 Pillow。</p>
        </div>
        <span class="tag ${pillowOk ? "tag-ok" : "tag-muted"}">${pillowOk ? "Pillow 可用" : "未装 Pillow · 回退文本"}</span>
      </div>

      ${
        pillowOk
          ? ""
          : `<div class="alert-inline">实卡预览与聊天出图需要可选依赖：
            <code>pip install Pillow</code> 或
            <code>pip install -r requirements-render.txt</code>
            。未安装时配置仍可保存，运行时自动纯文本。</div>`
      }

      <div class="render-layout">
        <div class="render-form">
          <div class="field">
            <div class="field-label">渲染模式</div>
            <p class="field-help">text=全文本；auto=结构卡+对话文本（推荐）；card=更多结构类型出卡。</p>
            <select id="ix-rmode" class="ctrl">
              <option value="text" ${rs.render_mode === "text" ? "selected" : ""}>text · 纯文本（最快）</option>
              <option value="auto" ${rs.render_mode === "auto" ? "selected" : ""}>auto · 结构出卡</option>
              <option value="card" ${rs.render_mode === "card" ? "selected" : ""}>card · 尽量出卡</option>
            </select>
          </div>

          <div class="field">
            <div class="field-label">出卡类型</div>
            <div class="chk-grid">${kindChecks}</div>
          </div>

          <div class="field">
            <div class="field-label">公式策略（预留）</div>
            <p class="field-help">首版不接数学引擎；开启后复杂公式仍保留源码文本。</p>
            <select id="ix-fmode" class="ctrl">
              <option value="off" ${rs.formula_mode === "off" ? "selected" : ""}>off · 关闭</option>
              <option value="detect" ${rs.formula_mode === "detect" ? "selected" : ""}>detect · 检测到 $ 时（预留）</option>
              <option value="always" ${rs.formula_mode === "always" ? "selected" : ""}>always · 总是（预留）</option>
            </select>
          </div>

          <div class="field">
            <div class="field-label">样式预设</div>
            <select id="ix-preset" class="ctrl">
              ${RENDER_PRESETS.map(
                (p) =>
                  `<option value="${p.id}" ${rs.card_style_preset === p.id ? "selected" : ""}>${esc(p.label)}</option>`,
              ).join("")}
            </select>
          </div>

          <div class="field-row2">
            <div class="field">
              <div class="field-label">宽度 <span id="ix-width-val">${rs.card_width}</span>px</div>
              <input id="ix-width" type="range" min="400" max="1200" step="10" value="${rs.card_width}" />
            </div>
            <div class="field">
              <div class="field-label">字号 <span id="ix-scale-val">${rs.card_font_scale}</span>%</div>
              <input id="ix-scale" type="range" min="75" max="150" step="5" value="${rs.card_font_scale}" />
            </div>
          </div>

          <div class="field-row3">
            <label class="field">强调色
              <input id="ix-accent" type="color" value="${attr(rs.card_accent)}" />
            </label>
            <label class="field">背景
              <input id="ix-bg" type="color" value="${attr(rs.card_bg)}" />
            </label>
            <label class="field">文字
              <input id="ix-fg" type="color" value="${attr(rs.card_fg)}" />
            </label>
          </div>

          <div class="field-row2">
            <div class="field">
              <div class="field-label">密度</div>
              <select id="ix-density" class="ctrl">
                <option value="comfortable" ${rs.card_density === "comfortable" ? "selected" : ""}>comfortable</option>
                <option value="compact" ${rs.card_density === "compact" ? "selected" : ""}>compact</option>
              </select>
            </div>
            <div class="field" style="display:flex;flex-direction:column;gap:8px;justify-content:flex-end">
              <label class="chk"><input id="ix-mono" type="checkbox" ${rs.card_mono ? "checked" : ""}/> 等宽字体</label>
              <label class="chk"><input id="ix-brand" type="checkbox" ${rs.card_show_brand ? "checked" : ""}/> 品牌角标</label>
            </div>
          </div>

          <div class="render-actions">
            <button type="button" class="btn" id="ix-reset-style">恢复默认样式</button>
            <button type="button" class="btn btn-primary" id="ix-save-render">保存并应用</button>
          </div>
        </div>

        <div class="render-preview-pane">
          <div class="field-label-row" style="margin-bottom:8px">
            <div class="field-label">预览</div>
            <select id="ix-sample" class="ctrl" style="max-width:160px">
              ${Object.keys(RENDER_KIND_LABELS)
                .map((k) => `<option value="${k}">${esc(RENDER_KIND_LABELS[k])}</option>`)
                .join("")}
            </select>
          </div>
          <p class="field-help">左侧为即时 DOM 预览（调色用）。点「生成实卡」走服务端 Pillow，与聊天发出效果一致。</p>
          <div id="ix-dom-preview" class="render-dom-host"></div>
          <div class="render-actions" style="margin-top:12px">
            <button type="button" class="btn btn-primary" id="ix-gen-card" ${pillowOk || !liveMode ? "" : ""}>生成实卡预览</button>
          </div>
          <div id="ix-real-meta" class="field-help" style="margin-top:8px"></div>
          <div id="ix-real-preview" class="render-real-host"></div>
        </div>
      </div>
    </div>
  `;

  const applyQuick = async (patch) => {
    try {
      if (liveMode && api) await api.saveConfig(patch);
      else store.saveConfig(patch);
      if (state.draft) Object.assign(state.draft, patch);
      await refresh();
    } catch (e) {
      toast("保存失败: " + (e.message || e));
    }
  };

  $("#ix-poke").onchange = () => {
    const on = $("#ix-poke").checked;
    const txt = $("#ix-poke").closest(".switch")?.querySelector(".switch-text");
    if (txt) txt.textContent = on ? "开启" : "关闭";
    const wrap = $("#ix-poke-action-wrap");
    if (wrap) wrap.hidden = !on;
    applyQuick({ poke_approve: on });
  };
  $$("#ix-poke-actions input[name='ix-poke-action']").forEach((inp) => {
    inp.onchange = () => {
      $$("#ix-poke-actions .poke-action-card").forEach((c) => c.classList.remove("is-on"));
      inp.closest(".poke-action-card")?.classList.add("is-on");
      applyQuick({ poke_action: inp.value });
    };
  });
  $("#ix-prefix").onchange = () => applyQuick({ quick_prefix: $("#ix-prefix").value });

  const bindPaint = () => {
    paintDomCardPreview();
  };
  ["ix-width", "ix-scale", "ix-accent", "ix-bg", "ix-fg", "ix-density", "ix-mono", "ix-brand", "ix-sample"].forEach(
    (id) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener("input", () => {
        if (id === "ix-width" && $("#ix-width-val")) $("#ix-width-val").textContent = el.value;
        if (id === "ix-scale" && $("#ix-scale-val")) $("#ix-scale-val").textContent = el.value;
        bindPaint();
      });
      el.addEventListener("change", bindPaint);
    },
  );
  $("#ix-preset") &&
    ($("#ix-preset").onchange = () => {
      applyPresetToForm($("#ix-preset").value);
      bindPaint();
    });

  $("#ix-reset-style") &&
    ($("#ix-reset-style").onclick = () => {
      if ($("#ix-preset")) $("#ix-preset").value = "terminal_light";
      applyPresetToForm("terminal_light");
      if ($("#ix-scale")) {
        $("#ix-scale").value = 100;
        if ($("#ix-scale-val")) $("#ix-scale-val").textContent = "100";
      }
      if ($("#ix-density")) $("#ix-density").value = "comfortable";
      if ($("#ix-mono")) $("#ix-mono").checked = true;
      if ($("#ix-brand")) $("#ix-brand").checked = true;
      bindPaint();
    });

  $("#ix-save-render") &&
    ($("#ix-save-render").onclick = async () => {
      const patch = collectRenderPatchFromForm();
      try {
        if (liveMode && api) {
          const res = await api.saveConfig(patch);
          toast(res?.message || "已保存");
        } else {
          store.saveConfig({
            ...patch,
            render_kinds_list: patch.render_kinds.split(","),
            render_engine: engine,
          });
          toast("已保存（本地 mock）");
        }
        if (state.draft) Object.assign(state.draft, patch);
        await refresh({ silent: true });
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
          res = await api.renderPreview({ kind, style, formula_mode: style.formula_mode });
        } else {
          // mock：无服务端时只提示用 DOM 预览
          res = {
            ok: false,
            error: "本地预览模式无 Pillow 后端；请在 AstrBot 插件面板内生成实卡，或安装依赖后重试。",
            ms: 0,
            engine: "none",
            fallback_text: sampleTitle(kind) + "\n" + sampleSub(kind),
          };
        }
        if (res?.ok && res.png_base64) {
          if (meta) {
            meta.textContent = `实卡 · ${res.engine} · ${res.ms}ms · ${res.bytes || "?"}B · ${res.width}×${res.height}`;
          }
          if (host) {
            host.innerHTML = `<img class="render-real-img" alt="card preview" src="data:${res.mime || "image/png"};base64,${res.png_base64}" />`;
          }
        } else {
          if (meta) {
            meta.textContent = `未能生成实卡（${res?.engine || "none"} · ${res?.ms ?? "?"}ms）：${res?.error || "unknown"}`;
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
      if (input.name === "auto_approve_enabled" || input.name === "output_level" || input.name === "remind_pending") {
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
    b.onclick = async () => {
      const action = b.dataset.life;
      if (action === "delete" && !confirm("确定删除？")) return;
      if (action === "resume" && !confirm("恢复后可能得到新 session id，继续？")) return;
      if (action === "archive" && !confirm("确定归档？")) return;
      try {
        if (liveMode && api) {
          const res = await api.lifecycle(id, action);
          toast(res.message || "完成");
          state.selected.delete(id);
          if (action === "delete") {
            $("#dlg").close();
            if (!applySnapFromResult(res)) await refresh();
            else { renderTopConn(); renderSessions(); }
            return;
          }
          if (!applySnapFromResult(res)) await refresh();
          else { renderTopConn(); renderSessions(); }
          openDetail(res.new_id || id);
          return;
        }
        const res = store.lifecycle(id, action);
        state.selected.delete(id);
        if (action === "delete") {
          $("#dlg").close();
          await refresh();
          return;
        }
        await refresh();
        openDetail(res.new_id || id);
      } catch (err) {
        toast("操作失败: " + (err.message || err));
        await refresh();
      }
    };
  });
}

/* ---------- HAPI Web embed (official hub SPA) ---------- */

async function fetchHubLaunch() {
  if (liveMode && api) {
    return api.hubLaunch({ autologin: state.hub.autologin });
  }
  // mock / 本地预览
  const cfg = state.data?.config || {};
  const endpoint = String(cfg.hapi_endpoint || "http://127.0.0.1:3006").replace(/\/$/, "");
  const tokenConfigured = Boolean(cfg.access_token_configured);
  const origin = endpoint;
  const page = origin + "/";
  const autologin = state.hub.autologin && tokenConfigured;
  const mockToken = "demo-token:default";
  let url = page + "?hub=" + encodeURIComponent(origin);
  if (autologin) url += "&token=" + encodeURIComponent(mockToken);
  return {
    ok: true,
    url,
    url_display: page,
    origin,
    path: "/",
    autologin,
    token_configured: tokenConfigured,
    loopback: /127\.0\.0\.1|localhost/i.test(endpoint),
    warnings: [
      "本地预览（无 bridge）：使用 mock 启动链。",
      ...(tokenConfigured
        ? ["自动登录会把 token 写入启动 URL（官方 HAPI 会尽快剥离）。"]
        : ["未配置 token：只能打开登录页。"]),
    ],
    note: "HAPI Web 支持 ?token= / ?hub=",
  };
}

function mountHubIframe(url) {
  const wrap = $("#hub-frame-wrap");
  if (!wrap) return;
  wrap.innerHTML = "";
  const iframe = document.createElement("iframe");
  iframe.className = "hub-iframe";
  iframe.title = "HAPI Web";
  iframe.src = url;
  // 允许剪贴板等；跨域无法读内部 DOM，属预期
  iframe.setAttribute("allow", "clipboard-read; clipboard-write");
  iframe.setAttribute("referrerpolicy", "no-referrer");
  wrap.appendChild(iframe);
  state.hub.loadedUrl = url;
}

function renderHubToolbar(launch) {
  const bar = $("#hub-toolbar");
  if (!bar) return;
  const L = launch || {};
  const warnHtml = (L.warnings || [])
    .map((w) => `<div class="hub-warn">⚠ ${esc(w)}</div>`)
    .join("");
  bar.innerHTML = `
    <div class="hub-toolbar-row">
      <div class="hub-meta">
        <div class="hub-origin mono">${esc(L.url_display || L.origin || "—")}</div>
        <div class="hub-status">
          ${L.autologin ? '<span class="tag tag-ok">自动登录</span>' : '<span class="tag tag-muted">仅打开页面</span>'}
          ${L.token_configured ? "" : '<span class="tag tag-warn">无 token</span>'}
          ${L.loopback ? '<span class="tag tag-warn">本机地址</span>' : ""}
        </div>
      </div>
      <div class="hub-actions">
        <label class="hub-check">
          <input type="checkbox" id="hub-autologin" ${state.hub.autologin ? "checked" : ""} />
          带 token 自动登录
        </label>
        <button type="button" class="btn" id="hub-reload">重新加载</button>
        <button type="button" class="btn" id="hub-open">新窗口打开</button>
        <button type="button" class="btn" id="hub-copy">复制链接（含登录）</button>
        <button type="button" class="btn" id="hub-copy-safe">复制地址（无 token）</button>
      </div>
    </div>
    ${warnHtml}
    <p class="hub-note">${esc(L.note || "由插件配置的 hapi_endpoint / access_token 生成启动链；与本面板的管控功能互补。")}</p>
  `;

  $("#hub-autologin")?.addEventListener("change", async (e) => {
    state.hub.autologin = Boolean(e.target.checked);
    await loadHub(true);
  });
  $("#hub-reload")?.addEventListener("click", () => loadHub(true));
  $("#hub-open")?.addEventListener("click", () => {
    const u = state.hub.loadedUrl || L.url;
    if (!u) return toast("尚无启动链接");
    const w = window.open(u, "_blank", "noopener,noreferrer");
    if (!w) {
      toast("无法打开新窗口（可能被拦截或插件页 sandbox 限制）；请「复制链接」后在浏览器粘贴");
    }
  });
  $("#hub-copy")?.addEventListener("click", async () => {
    const u = state.hub.loadedUrl || L.url;
    if (!u) return toast("尚无启动链接");
    try {
      await navigator.clipboard.writeText(u);
      toast("已复制（含 token 时请勿外传）");
    } catch {
      toast("复制失败，请手动从新窗口地址栏获取");
    }
  });
  $("#hub-copy-safe")?.addEventListener("click", async () => {
    const u = L.url_display || L.origin;
    if (!u) return toast("尚无地址");
    try {
      await navigator.clipboard.writeText(u);
      toast("已复制无 token 地址");
    } catch {
      toast("复制失败");
    }
  });
}

async function loadHub(force = false) {
  const ph = $("#hub-placeholder");
  if (ph) ph.textContent = "正在生成启动链接…";
  try {
    const launch = await fetchHubLaunch();
    state.hub.launch = launch;
    state.hub.error = null;
    renderHubToolbar(launch);
    if (!launch.url) {
      const wrap = $("#hub-frame-wrap");
      if (wrap) wrap.innerHTML = `<div class="hub-placeholder empty">无法生成启动链接</div>`;
      return;
    }
    // 同 URL 且已加载时不强制刷新，避免轮询打断用户操作
    if (!force && state.hub.loadedUrl === launch.url && $("#hub-frame-wrap iframe")) {
      return;
    }
    mountHubIframe(launch.url);
  } catch (e) {
    state.hub.error = e.message || String(e);
    state.hub.launch = null;
    renderHubToolbar({
      url_display: state.data?.config?.hapi_endpoint || "—",
      warnings: [state.hub.error],
      autologin: false,
      token_configured: Boolean(state.data?.config?.access_token_configured),
    });
    const wrap = $("#hub-frame-wrap");
    if (wrap) {
      wrap.innerHTML = `<div class="hub-placeholder empty">加载失败：${esc(state.hub.error)}
        <div style="margin-top:10px"><button type="button" class="btn" id="hub-retry">重试</button></div>
      </div>`;
      $("#hub-retry")?.addEventListener("click", () => loadHub(true));
    }
  }
}

function renderHub() {
  // 工具栏先占位，再异步拉 launch
  if (!state.hub.launch && !state.hub.error) {
    renderHubToolbar({
      url_display: state.data?.config?.hapi_endpoint || "—",
      warnings: ["正在准备…"],
      autologin: state.hub.autologin,
      token_configured: Boolean(state.data?.config?.access_token_configured),
    });
  } else if (state.hub.launch) {
    renderHubToolbar(state.hub.launch);
  }
  loadHub(false);
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
  if (!snap.columns) snap.columns = [];
  if (!snap.window_options) snap.window_options = [];
  if (!snap.defaults) snap.defaults = { primary: null, flavor: {}, writable: false };
  if (!snap.config) {
    // config 通常已在 snapshot 内；缺省时再拉一次
    try {
      const cfg = await api.config();
      snap.config = cfg.config || cfg;
    } catch (_) {
      snap.config = state.data?.config || {};
    }
  }
  return snap;
}

/** @param {{fresh?: boolean, silent?: boolean}} opts */
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
  // 自动轮询时：设置页有未保存草稿则不重绘表单，避免打断输入
  if (state.page === "overview") renderOverview();
  else if (state.page === "sessions") renderSessions();
  else if (state.page === "hub") {
    // 轮询时只刷新工具栏元信息，不重载 iframe（避免打断操作 / 反复带 token 加载）
    if (!opts.silent) renderHub();
    else if (state.hub.launch) renderHubToolbar(state.hub.launch);
  } else if (state.page === "interact") renderInteract();
  else if (state.page === "help") renderHelp();
  else if (state.page === "settings") {
    if (!opts.silent || !state.draft) renderSettings();
    else {
      renderTopConn();
      renderAlert();
    }
  }
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
      // meta: permission modes from flavor_profiles
      try {
        const meta = await api.meta();
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
    showAlert("加载数据失败: " + (e.message || e));
    // fallback empty shell
    state.data = {
      connection: { sse_status: "disconnected", endpoint_host: "—", conn_fail_count: 0, conn_error: String(e) },
      metrics: { active: 0, thinking: 0, pending: 0, unrouted: 0, total: 0 },
      sessions: [],
      columns: [],
      defaults: { primary: null, flavor: {}, writable: false },
      window_options: [],
      config: {},
    };
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
