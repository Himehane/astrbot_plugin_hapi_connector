/**
 * 设置页 — 字段结构来自 meta.config_schema（_conf_schema + overlay）
 * 值来自 state.data.config（插件真实配置 / mock）
 */
import { RENDER_KIND_LABELS } from "../constants.js?v=3.0.0";
import { state } from "../state.js?v=3.0.0";
import { $, $$, esc, attr } from "../utils.js?v=3.0.0";
import { renderTopConn, renderAlert } from "../ui.js?v=3.0.0";
import { CONFIG_SCHEMA_FALLBACK } from "../settings_schema_fallback.js?v=3.0.0";

/** 当前生效的设置 schema（live meta 优先，否则 fallback） */
export function getConfigSchema() {
  const fromMeta = state.meta?.config_schema;
  if (fromMeta?.groups?.length) return fromMeta;
  return CONFIG_SCHEMA_FALLBACK;
}

function settingsGroups() {
  return getConfigSchema().groups || [];
}

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
    return `<div class="enum-cards">${(f.options || [])
      .map(
        (o) => `<label class="enum-card">
        <input type="radio" name="${f.key}" value="${o.value}" ${d[f.key] === o.value ? "checked" : ""} />
        <div class="t">${esc(o.title)}</div>
        <div class="d">${esc(o.desc || "")}</div>
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
  if (f.sensitive || f.type === "password") {
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
  if (f.type === "enum") {
    return `<select class="ctrl" name="${f.key}">${(f.options || [])
      .map(
        (o) =>
          `<option value="${attr(o.value)}" ${d[f.key] === o.value ? "selected" : ""}>${esc(
            o.title || o.value,
          )}</option>`,
      )
      .join("")}</select>`;
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

  const groups = settingsGroups();
  if (!groups.length) {
    $("#settings-nav").innerHTML = "";
    $("#settings-form").innerHTML =
      `<p class="desc">设置 schema 未加载。请刷新页面；本地预览应有 fallback。</p>`;
    return;
  }

  if (!groups.some((b) => b.id === state.settingsSection)) {
    state.settingsSection = groups[0].id;
  }

  $("#settings-nav").innerHTML = groups
    .map(
      (b) =>
        `<button type="button" data-sec="${b.id}" class="${
          state.settingsSection === b.id ? "is-active" : ""
        }">${esc(b.nav)}</button>`,
    )
    .join("");

  $$("#settings-nav button").forEach((b) => {
    b.onclick = () => {
      state.settingsSection = b.dataset.sec;
      renderSettings();
      document.getElementById(`sec-${b.dataset.sec}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
    };
  });

  const d = state.draft;
  $("#settings-form").innerHTML = groups
    .map((b) => {
      const main = (b.fields || []).map((f) => renderField(f, d)).join("");
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
            ${(b.advanced.fields || []).map((f) => renderField(f, d)).join("")}
          </div>
        </details>`
        : "";
      return `<section id="sec-${b.id}" class="settings-section">
      <h2>${esc(b.title)}</h2>
      <p class="desc">${esc(b.desc)}</p>
      ${main}${adv}
    </section>`;
    })
    .join("");

  $$("#settings-form input, #settings-form select").forEach((input) => {
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
  for (const b of settingsGroups()) {
    list.push(...(b.fields || []));
    if (b.advanced?.fields) list.push(...b.advanced.fields);
  }
  return list;
}

export { renderSettings, allSettingsFields };
