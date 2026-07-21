/**
 * 帮助页：部署文档（docs/*.md）优先 + 命令帮助
 * 文档标题取自 md 首个 H1；正文由后端读盘后前端 md.js 渲染
 */
import { HELP_TOPICS, HELP_COMMANDS } from "../constants.js?v=3.0.0";
import { state } from "../state.js?v=3.0.0";
import { $, $$, esc, attr } from "../utils.js?v=3.0.0";
import { renderTopConn, renderAlert } from "../ui.js?v=3.0.0";
import { renderMarkdown } from "../md.js?v=3.0.0";
import { isLive, getApi } from "../live.js?v=3.0.0";

const FALLBACK_DOCS = [
  {
    id: "install",
    file: "install.md",
    title: "HAPI 安装与启动指南",
  },
  {
    id: "session-isolation",
    file: "session-isolation.md",
    title: "多窗口会话隔离特性说明",
  },
  {
    id: "cf-access",
    file: "cf_access_guide.md",
    title: "Cloudflare Zero Trust Access 配置指南",
  },
];

const FALLBACK_MD = {
  install: `本文档说明如何安装并启动 [HAPI](https://github.com/tiann/hapi) 服务，以便配合本插件使用。

本地预览模式下无法读取仓库 docs/。请通过 AstrBot 插件页打开管理面板，或直接查看仓库 \`docs/install.md\`。`,
  "session-isolation": `**在不同 AstrBot 会话中管理的不同 session 将会互相独立。**

本地预览模式下无法读取完整文档与截图。请通过 AstrBot 打开管理面板，或查看仓库 \`docs/session-isolation.md\`。`,
  "cf-access": `本文档记录如何为 HAPI 服务配置 Cloudflare Zero Trust Access 认证。

本地预览模式下无法读取完整文档与截图。请通过 AstrBot 打开管理面板，或查看仓库 \`docs/cf_access_guide.md\`。`,
};

function helpTopics() {
  return state._helpTopics || HELP_TOPICS;
}
function helpCommands() {
  return state._helpCommands || HELP_COMMANDS;
}
function docsCatalog() {
  return state._docsList?.length ? state._docsList : FALLBACK_DOCS;
}

function matchHelpCmd(c, q) {
  if (!q) return true;
  const topicName = helpTopics().find((t) => t.id === c.topic)?.name || "";
  const blob = [c.usage, c.summary, c.example || "", topicName, c.topic].join("\n").toLowerCase();
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
  const tabs = allTopics
    .map((t) => {
      const n = searching
        ? matched.filter((c) => c.topic === t.id).length
        : allCmds.filter((c) => c.topic === t.id).length;
      return `<button type="button" class="help-tab ${t.id === topic ? "is-active" : ""}" data-topic="${t.id}">${esc(
        t.name,
      )}<span class="help-tab-sub">${esc(t.desc)} · ${n}</span></button>`;
    })
    .join("");

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
    clearTimeout(debounce);
    apply();
  });
  input.addEventListener("input", () => {
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

function ensureHelpMode() {
  if (state.helpMode !== "docs" && state.helpMode !== "commands") {
    state.helpMode = "docs";
  }
  if (!state.helpDocId) {
    state.helpDocId = state._docsDefault || "install";
  }
}

async function loadDocBody(docId) {
  if (state._docsCache?.[docId]) return state._docsCache[docId];

  if (isLive() && getApi()) {
    try {
      const doc = await getApi().docsGet(docId);
      if (doc?.markdown != null) {
        state._docsCache = state._docsCache || {};
        state._docsCache[docId] = doc;
        return doc;
      }
    } catch (e) {
      console.warn("docs load failed", docId, e);
      return {
        id: docId,
        title: docsCatalog().find((d) => d.id === docId)?.title || docId,
        markdown: `> 文档加载失败：${e.message || e}\n\n请确认插件已重载，且 \`docs/\` 目录随插件一并安装。`,
        error: true,
      };
    }
  }

  const meta = docsCatalog().find((d) => d.id === docId) || FALLBACK_DOCS[0];
  return {
    id: docId,
    title: meta.title,
    markdown: FALLBACK_MD[docId] || FALLBACK_MD.install,
    offline: true,
  };
}

function paintDocTabs() {
  const docs = docsCatalog();
  const active = state.helpDocId || docs[0]?.id;
  const el = $("#help-doc-tabs");
  if (!el) return;
  el.innerHTML = docs
    .map(
      (d) =>
        `<button type="button" class="help-tab ${d.id === active ? "is-active" : ""}" data-doc="${attr(d.id)}">${esc(
          d.title,
        )}<span class="help-tab-sub">${esc(d.file)}</span></button>`,
    )
    .join("");
  $$("#help-doc-tabs .help-tab").forEach((b) => {
    b.onclick = () => {
      if (b.dataset.doc === state.helpDocId) return;
      state.helpDocId = b.dataset.doc;
      void paintDocBody();
    };
  });
}

async function paintDocBody() {
  paintDocTabs();
  const host = $("#help-doc-body");
  const titleEl = $("#help-doc-title");
  const subEl = $("#help-doc-sub");
  if (!host) return;

  const docId = state.helpDocId || "install";
  host.innerHTML = `<div class="empty">加载文档中…</div>`;
  if (titleEl) titleEl.textContent = "…";
  if (subEl) subEl.textContent = "";

  const doc = await loadDocBody(docId);
  // 切换期间用户可能已点到其它文档
  if ((state.helpDocId || "install") !== docId) return;

  if (titleEl) titleEl.textContent = doc.title || docId;
  if (subEl) {
    subEl.textContent = doc.offline
      ? `预览占位 · ${doc.file || docId}`
      : `来源 docs/${doc.file || docId}`;
  }
  host.innerHTML = `<div class="md-body">${renderMarkdown(doc.markdown || "")}</div>`;

  // 文档内互链 #doc:id
  host.querySelectorAll("a.md-doc-link[data-doc]").forEach((a) => {
    a.addEventListener("click", (e) => {
      e.preventDefault();
      const id = a.getAttribute("data-doc");
      if (!id || id === state.helpDocId) return;
      state.helpDocId = id;
      void paintDocBody();
      $("#help-doc-card")?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  });
}

function paintModeTabs() {
  const mode = state.helpMode || "docs";
  $$("#help-mode-tabs .help-mode-tab").forEach((b) => {
    b.classList.toggle("is-active", b.dataset.mode === mode);
  });
  const docsPane = $("#help-pane-docs");
  const cmdPane = $("#help-pane-commands");
  if (docsPane) docsPane.hidden = mode !== "docs";
  if (cmdPane) cmdPane.hidden = mode !== "commands";
}

function renderHelp() {
  if (!state.data) return;
  renderTopConn();
  renderAlert();
  ensureHelpMode();

  const existing = $("#help-q");
  // 命令区搜索框已在 DOM 且仍在帮助页时，命令模式只增量更新
  if (
    state.helpMode === "commands" &&
    existing &&
    $("#view-help") &&
    !$("#view-help").hidden &&
    document.activeElement === existing
  ) {
    updateHelpResults();
    return;
  }

  const { searching } = getHelpFiltered();
  const mode = state.helpMode || "docs";

  $("#view-help").innerHTML = `
    <div class="card">
      <div class="card-head">
        <div>
          <h2>帮助与文档</h2>
          <p class="sub">部署文档来自仓库 docs/ · 命令说明与 /hapi help 同源 · 管理员可用</p>
        </div>
      </div>
      <div id="help-mode-tabs" class="help-mode-tabs" role="tablist">
        <button type="button" class="help-mode-tab ${mode === "docs" ? "is-active" : ""}" data-mode="docs" role="tab">部署文档</button>
        <button type="button" class="help-mode-tab ${mode === "commands" ? "is-active" : ""}" data-mode="commands" role="tab">命令帮助</button>
      </div>
    </div>

    <div id="help-pane-docs" ${mode === "docs" ? "" : "hidden"}>
      <div class="card" id="help-doc-card">
        <div class="card-head">
          <div>
            <h2 id="help-doc-title">—</h2>
            <p class="sub" id="help-doc-sub"></p>
          </div>
        </div>
        <div id="help-doc-tabs" class="help-tabs help-doc-tabs"></div>
        <div id="help-doc-body" class="help-doc-body"></div>
      </div>
    </div>

    <div id="help-pane-commands" ${mode === "commands" ? "" : "hidden"}>
      <div class="card">
        <div class="card-head">
          <div>
            <h2>命令帮助</h2>
            <p class="sub">与插件 /hapi help 主题一致 · 前缀默认 /hapi</p>
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
    </div>
  `;

  $$("#help-mode-tabs .help-mode-tab").forEach((b) => {
    b.onclick = () => {
      const next = b.dataset.mode;
      if (next === state.helpMode) return;
      state.helpMode = next;
      paintModeTabs();
      if (next === "commands") {
        wireHelpSearchInput($("#help-q"));
        updateHelpResults();
      } else {
        void paintDocBody();
      }
    };
  });

  if (mode === "commands") {
    wireHelpSearchInput($("#help-q"));
    updateHelpResults();
  } else {
    void paintDocBody();
  }
}

export { renderHelp, helpTopics, helpCommands };
