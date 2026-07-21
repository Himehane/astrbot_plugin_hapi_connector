/**
 * 页面导航：注册 go / repaint 到 data 与 go 叶子模块
 */
import { state } from "./state.js?v=3.0.0";
import { setPageChrome, closeSidebar } from "./ui.js?v=3.0.0";
import { setRepaintPage, setAllSettingsFields } from "./data.js?v=3.0.0";
import { setGo } from "./go.js?v=3.0.0";
import { renderOverview } from "./pages/overview.js?v=3.0.0";
import { renderSessions } from "./pages/sessions.js?v=3.0.0";
import { renderInteract } from "./pages/interact.js?v=3.0.0";
import { renderHelp } from "./pages/help.js?v=3.0.0";
import { renderSettings, allSettingsFields } from "./pages/settings.js?v=3.0.0";

function repaint(page) {
  if (page === "overview") renderOverview();
  else if (page === "sessions") renderSessions();
  else if (page === "interact") renderInteract();
  else if (page === "help") renderHelp();
  else if (page === "settings") renderSettings();
}

function goImpl(page) {
  if (page === "hub") page = "overview";
  state.page = page;
  setPageChrome(page);
  closeSidebar();
  repaint(page);
}

setRepaintPage(repaint);
setAllSettingsFields(allSettingsFields);
setGo(goImpl);

export { goImpl as go };
