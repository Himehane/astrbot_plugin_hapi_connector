/**
 * 页面导航：注册 go / repaint 到 data 与 go 叶子模块
 * 离开 interact / settings 时拦截未保存更改
 */
import { state } from "./state.js?v=3.0.1";
import { setPageChrome, closeSidebar, askUnsavedLeave } from "./ui.js?v=3.0.1";
import {
  setRepaintPage,
  setAllSettingsFields,
  isSettingsDirty,
  saveSettings,
  paintSettingsSaveStatus,
} from "./data.js?v=3.0.1";
import { setGo } from "./go.js?v=3.0.1";
import { renderOverview } from "./pages/overview.js?v=3.0.1";
import { renderSessions } from "./pages/sessions.js?v=3.0.1";
import {
  renderInteract,
  isInteractDirty,
  saveAllInteractDirty,
  discardInteractDraft,
} from "./pages/interact.js?v=3.0.1";
import { renderHelp } from "./pages/help.js?v=3.0.1";
import { renderDocs } from "./pages/docs.js?v=3.0.1";
import { renderSettings, allSettingsFields } from "./pages/settings.js?v=3.0.1";

function repaint(page) {
  if (page === "overview") renderOverview();
  else if (page === "sessions") renderSessions();
  else if (page === "interact") renderInteract();
  else if (page === "help") renderHelp();
  else if (page === "docs") renderDocs();
  else if (page === "settings") renderSettings();
}

/**
 * 当前页是否有未保存更改；若有则弹三选一。
 * @returns {Promise<boolean>} true = 可以离开
 */
async function confirmLeaveIfDirty(fromPage) {
  if (fromPage === "settings" && isSettingsDirty()) {
    const choice = await askUnsavedLeave("设置有未保存的更改，离开前如何处理？");
    if (choice === "cancel") return false;
    if (choice === "save") {
      const ok = await saveSettings();
      if (!ok) return false;
    } else {
      // discard：清 draft，下次进设置会从 config 重建
      state.draft = null;
      paintSettingsSaveStatus("");
    }
    return true;
  }
  if (fromPage === "interact" && isInteractDirty()) {
    const choice = await askUnsavedLeave("交互优化有未保存的更改，离开前如何处理？");
    if (choice === "cancel") return false;
    if (choice === "save") {
      const ok = await saveAllInteractDirty();
      if (!ok) return false;
    } else {
      discardInteractDraft();
    }
    return true;
  }
  return true;
}

async function goImpl(page) {
  if (page === "hub") page = "overview";
  if (page === state.page) {
    setPageChrome(page);
    closeSidebar();
    // 交互页有未保存编辑时不要整页重绘，否则表单会丢
    if (page === "interact" && isInteractDirty()) return;
    repaint(page);
    return;
  }
  const from = state.page;
  const canLeave = await confirmLeaveIfDirty(from);
  if (!canLeave) return;
  state.page = page;
  setPageChrome(page);
  closeSidebar();
  repaint(page);
}

setRepaintPage(repaint);
setAllSettingsFields(allSettingsFields);
setGo(goImpl);

export { goImpl as go };
