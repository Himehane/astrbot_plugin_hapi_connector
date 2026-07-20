"""推送卡片渲染。

能力：
1. 结构卡（list / pending / status / permission / routes）
2. 对话卡（message）：Markdown 子集
3. **自定义 CSS**：`card_custom_css` 完整可编辑；HTML 引擎（Playwright 可选）完整生效；
   Pillow 引擎解析 CSS 变量（--card-*）与基础字号
4. **可移植字体**：见 font_manager（card_font_path → assets/fonts → 系统 CJK；无则回退文本，不自动下载）

可选依赖：
    pip install Pillow
    # 完整 CSS 保真（推荐）：
    pip install playwright && playwright install chromium
"""

from __future__ import annotations

import html
import io
import re
import tempfile
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

try:
    from astrbot.api import logger
except ImportError:  # pragma: no cover
    import logging

    logger = logging.getLogger("hapi_connector.card_render")

try:
    from PIL import Image, ImageDraw, ImageFont  # type: ignore

    _HAS_PILLOW = True
except ImportError:  # pragma: no cover
    Image = ImageDraw = ImageFont = None  # type: ignore
    _HAS_PILLOW = False

try:
    from . import font_manager
except ImportError:  # pragma: no cover — 未部署时 WebUI 其它接口仍可用
    class _FontManagerStub:
        def font_status(self):
            return {"sans": None, "mono": None, "user_font": None}
        def installable_items(self):
            return []
        def bundled_dir(self):
            from pathlib import Path
            return Path(__file__).resolve().parent / "assets" / "fonts"
        def resolve_font_path(self, *a, **k):
            return None
        def ensure_default_fonts(self):
            return {}
        def load_image_font(self, *a, **k):
            raise RuntimeError("font_manager 不可用")
    font_manager = _FontManagerStub()  # type: ignore


RENDER_MODES = ("text", "auto", "card")
FORMULA_MODES = ("off", "detect", "always")
CARD_KINDS = (
    "session_list",
    "pending",
    "status",
    "permission",
    "routes",
    "message",
)
DENSITY_OPTIONS = ("comfortable", "compact")
PRESET_IDS = ("terminal_light", "terminal_dark", "clean", "compact")
DEFAULT_KINDS = ("session_list", "pending", "status", "permission", "message")

# 默认 CSS：用户可在 WebUI 整段覆盖 / 追加。变量名是 Pillow 引擎的契约。
DEFAULT_CARD_CSS = """\
/* HAPI Connector 推送卡片默认样式
 * 可自由改写。HTML 引擎（Playwright）完整生效；
 * Pillow 引擎识别下方 --card-* 变量与 font-size/padding。
 */
:root {
  --card-bg: #faf8f2;
  --card-fg: #1c1914;
  --card-accent: #1a7f4b;
  --card-muted: #6b665a;
  --card-border: #d4cfc0;
  --card-code-bg: #efe9d8;
  --card-radius: 12px;
  --card-pad: 24px;
  --card-width: 720px;
  --card-font-scale: 1;
  --card-title-size: 22px;
  --card-body-size: 14px;
  --card-mono: 0; /* 1=等宽 */
}

* { box-sizing: border-box; margin: 0; padding: 0; }

body {
  background: transparent;
  font-family: "HapiCard", "Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif;
  color: var(--card-fg);
}

.card {
  width: var(--card-width);
  max-width: 100%;
  background: var(--card-bg);
  color: var(--card-fg);
  border: 2px solid var(--card-border);
  border-radius: var(--card-radius);
  padding: var(--card-pad);
  font-size: calc(var(--card-body-size) * var(--card-font-scale));
  line-height: 1.55;
}

.card.mono {
  font-family: "HapiCardMono", "HapiCard", "Noto Sans Mono CJK SC", ui-monospace, monospace;
}

.card-title {
  font-size: calc(var(--card-title-size) * var(--card-font-scale));
  font-weight: 700;
  letter-spacing: 0.01em;
  margin-bottom: 6px;
}

.card-sub {
  color: var(--card-muted);
  font-size: 0.92em;
  margin-bottom: 12px;
}

.card-bar {
  width: 120px;
  height: 3px;
  background: var(--card-accent);
  border-radius: 2px;
  margin-bottom: 14px;
}

.row { margin-bottom: 12px; }
.row-head { font-weight: 600; }
.row-detail {
  color: var(--card-muted);
  margin-top: 2px;
  padding-left: 12px;
  word-break: break-word;
}

.card-foot {
  margin-top: 12px;
  padding-top: 10px;
  border-top: 1px solid var(--card-border);
  color: var(--card-accent);
  font-size: 0.9em;
  white-space: pre-wrap;
}

.card-brand {
  margin-top: 12px;
  text-align: right;
  color: var(--card-muted);
  font-size: 0.78em;
}

/* 对话 Markdown */
.md h1, .md h2, .md h3 {
  font-weight: 700;
  margin: 0.7em 0 0.35em;
  line-height: 1.3;
}
.md h1 { font-size: 1.35em; }
.md h2 { font-size: 1.2em; }
.md h3 { font-size: 1.08em; }
.md p { margin: 0.45em 0; white-space: pre-wrap; word-break: break-word; }
.md ul, .md ol { margin: 0.4em 0 0.4em 1.2em; }
.md li { margin: 0.2em 0; }
.md code {
  font-family: "HapiCardMono", "HapiCard", ui-monospace, monospace;
  background: var(--card-code-bg);
  padding: 0.1em 0.35em;
  border-radius: 4px;
  font-size: 0.92em;
}
.md pre {
  background: var(--card-code-bg);
  border: 1px solid var(--card-border);
  border-radius: 8px;
  padding: 10px 12px;
  overflow-x: auto;
  margin: 0.55em 0;
  font-family: "HapiCardMono", "HapiCard", ui-monospace, monospace;
  font-size: 0.88em;
  white-space: pre-wrap;
  word-break: break-word;
}
.md pre code { background: transparent; padding: 0; }
.md blockquote {
  border-left: 3px solid var(--card-accent);
  margin: 0.5em 0;
  padding: 0.2em 0 0.2em 12px;
  color: var(--card-muted);
}
.md a { color: var(--card-accent); text-decoration: none; }
.md hr {
  border: none;
  border-top: 1px solid var(--card-border);
  margin: 0.8em 0;
}
.md strong { font-weight: 700; }
.md em { font-style: italic; }
"""


@dataclass
class CardStyle:
    preset: str = "terminal_light"
    width: int = 720
    padding: int = 24
    radius: int = 12
    bg: str = "#faf8f2"
    fg: str = "#1c1914"
    accent: str = "#1a7f4b"
    muted: str = "#6b665a"
    border: str = "#d4cfc0"
    code_bg: str = "#efe9d8"
    font_scale: float = 1.0
    mono: bool = True
    show_brand: bool = True
    density: str = "comfortable"
    custom_css: str = ""
    font_path: str = ""

    def resolved(self) -> "CardStyle":
        preset = self.preset if self.preset in PRESETS else "terminal_light"
        dens = self.density if self.density in DENSITY_OPTIONS else "comfortable"
        width = max(400, min(1400, int(self.width or 720)))
        scale = float(self.font_scale or 1.0)
        if scale > 3:
            scale = scale / 100.0
        scale = max(0.75, min(1.5, scale))
        return CardStyle(
            preset=preset,
            width=width,
            padding=max(8, min(48, int(self.padding or 24))),
            radius=max(0, min(28, int(self.radius or 12))),
            bg=self.bg or "#faf8f2",
            fg=self.fg or "#1c1914",
            accent=self.accent or "#1a7f4b",
            muted=self.muted or "#6b665a",
            border=self.border or "#d4cfc0",
            code_bg=self.code_bg or "#efe9d8",
            font_scale=scale,
            mono=bool(self.mono),
            show_brand=bool(self.show_brand),
            density=dens,
            custom_css=self.custom_css or "",
            font_path=self.font_path or "",
        )


PRESETS: dict[str, dict[str, Any]] = {
    "terminal_light": {
        "preset": "terminal_light",
        "width": 720,
        "padding": 24,
        "radius": 12,
        "bg": "#faf8f2",
        "fg": "#1c1914",
        "accent": "#1a7f4b",
        "muted": "#6b665a",
        "border": "#d4cfc0",
        "code_bg": "#efe9d8",
        "font_scale": 1.0,
        "mono": True,
        "show_brand": True,
        "density": "comfortable",
    },
    "terminal_dark": {
        "preset": "terminal_dark",
        "width": 720,
        "padding": 24,
        "radius": 12,
        "bg": "#1c1914",
        "fg": "#f0ebe0",
        "accent": "#3ecf8e",
        "muted": "#9a9486",
        "border": "#3d3a32",
        "code_bg": "#2a261e",
        "font_scale": 1.0,
        "mono": True,
        "show_brand": True,
        "density": "comfortable",
    },
    "clean": {
        "preset": "clean",
        "width": 720,
        "padding": 28,
        "radius": 16,
        "bg": "#ffffff",
        "fg": "#111827",
        "accent": "#2563eb",
        "muted": "#6b7280",
        "border": "#e5e7eb",
        "code_bg": "#f3f4f6",
        "font_scale": 1.05,
        "mono": False,
        "show_brand": True,
        "density": "comfortable",
    },
    "compact": {
        "preset": "compact",
        "width": 560,
        "padding": 16,
        "radius": 8,
        "bg": "#faf8f2",
        "fg": "#1c1914",
        "accent": "#1a7f4b",
        "muted": "#6b665a",
        "border": "#d4cfc0",
        "code_bg": "#efe9d8",
        "font_scale": 0.92,
        "mono": True,
        "show_brand": False,
        "density": "compact",
    },
}


@dataclass
class RenderResult:
    ok: bool
    png: bytes | None = None
    mime: str = "image/png"
    width: int = 0
    height: int = 0
    bytes_len: int = 0
    ms: float = 0.0
    engine: str = "none"
    error: str | None = None
    kind: str = ""
    fallback_text: str = ""
    font_path: str = ""


def pillow_available() -> bool:
    return _HAS_PILLOW


def playwright_available() -> bool:
    try:
        import playwright  # noqa: F401

        return True
    except ImportError:
        return False


def engine_status() -> dict[str, Any]:
    fonts = font_manager.font_status()
    # 默认快路径是 Pillow；完整 CSS 才上 Playwright
    default = "pillow" if _HAS_PILLOW else ("playwright" if playwright_available() else None)
    return {
        "pillow": _HAS_PILLOW,
        "playwright": playwright_available(),
        "formula_engine": False,
        "engines": {
            "card": default,
            "fast_path": "pillow" if _HAS_PILLOW else None,
            "full_css": "playwright" if playwright_available() else "pillow-vars",
            "formula": None,
        },
        "fonts": fonts,
        "installable": font_manager.installable_items(),
        "install_hint": _install_hint(),
    }


def _install_hint() -> str | None:
    parts = []
    if not _HAS_PILLOW:
        parts.append("pip install Pillow（或 WebUI 勾选安装）")
    fonts = font_manager.font_status()
    if not fonts.get("sans") and not fonts.get("user_font"):
        parts.append(
            f"中文字体：WebUI 勾选安装，或放到 {font_manager.bundled_dir()} / 配置 card_font_path"
        )
    return " · ".join(parts) if parts else None


def parse_kinds(raw: Any) -> list[str]:
    if raw is None:
        return list(DEFAULT_KINDS)
    if isinstance(raw, (list, tuple)):
        items = [str(x).strip() for x in raw]
    else:
        s = str(raw).strip()
        if not s:
            return list(DEFAULT_KINDS)
        if s.startswith("["):
            try:
                import json

                data = json.loads(s)
                if isinstance(data, list):
                    items = [str(x).strip() for x in data]
                else:
                    items = [p.strip() for p in s.split(",")]
            except Exception:
                items = [p.strip() for p in s.split(",")]
        else:
            items = [p.strip() for p in s.replace("，", ",").split(",")]
    out = [k for k in items if k in CARD_KINDS]
    return out or list(DEFAULT_KINDS)


def kinds_to_storage(kinds: list[str]) -> str:
    return ",".join(k for k in kinds if k in CARD_KINDS) or ",".join(DEFAULT_KINDS)


def _parse_bool(v: Any, default: bool) -> bool:
    if v is None:
        return default
    if isinstance(v, bool):
        return v
    s = str(v).strip().lower()
    if s in ("1", "true", "yes", "on"):
        return True
    if s in ("0", "false", "no", "off"):
        return False
    return default


def style_from_config(cfg: dict[str, Any] | None) -> CardStyle:
    cfg = cfg or {}
    preset = str(cfg.get("card_style_preset") or "terminal_light").strip()
    if preset not in PRESETS:
        preset = "terminal_light"
    base = dict(PRESETS[preset])

    def _int(key: str, default: int, lo: int, hi: int) -> int:
        try:
            n = int(cfg.get(key, default))
        except (TypeError, ValueError):
            n = default
        return max(lo, min(hi, n))

    def _float_scale(raw: Any, default: float = 1.0) -> float:
        try:
            v = float(raw)
            if v > 3:
                v = v / 100.0
            return max(0.75, min(1.5, v))
        except (TypeError, ValueError):
            return default

    def _color(key: str, default: str) -> str:
        if key not in cfg or cfg.get(key) in (None, ""):
            return default
        s = str(cfg.get(key)).strip()
        if not s.startswith("#"):
            s = "#" + s
        if len(s) not in (4, 7):
            return default
        try:
            _hex_to_rgb(s)
        except Exception:
            return default
        return s

    density = str(cfg.get("card_density") or base.get("density") or "comfortable")
    if density not in DENSITY_OPTIONS:
        density = "comfortable"

    width = _int("card_width", int(base["width"]), 400, 1400)
    mono = base.get("mono", True)
    if "card_mono" in cfg and cfg.get("card_mono") is not None:
        mono = _parse_bool(cfg.get("card_mono"), bool(mono))
    show_brand = base.get("show_brand", True)
    if "card_show_brand" in cfg and cfg.get("card_show_brand") is not None:
        show_brand = _parse_bool(cfg.get("card_show_brand"), bool(show_brand))

    custom_css = ""
    if cfg.get("card_custom_css") is not None:
        custom_css = str(cfg.get("card_custom_css") or "")
    font_path = str(cfg.get("card_font_path") or "").strip()

    # 用户自定义 CSS 里的变量可覆盖色值
    vars_from_css = extract_css_vars(custom_css) if custom_css else {}

    def pick_color(key: str, conf_key: str, base_key: str) -> str:
        if conf_key in cfg and cfg.get(conf_key) not in (None, ""):
            return _color(conf_key, str(base[base_key]))
        if key in vars_from_css:
            return vars_from_css[key]
        return str(base[base_key])

    pad = 16 if density == "compact" else int(base.get("padding", 24))
    if "--card-pad" in vars_from_css:
        try:
            pad = int(re.sub(r"[^\d]", "", vars_from_css["--card-pad"]) or pad)
        except ValueError:
            pass

    return CardStyle(
        preset=preset,
        width=width,
        padding=pad,
        radius=int(base.get("radius", 12)),
        bg=pick_color("--card-bg", "card_bg", "bg"),
        fg=pick_color("--card-fg", "card_fg", "fg"),
        accent=pick_color("--card-accent", "card_accent", "accent"),
        muted=str(vars_from_css.get("--card-muted") or base["muted"]),
        border=str(vars_from_css.get("--card-border") or base["border"]),
        code_bg=str(vars_from_css.get("--card-code-bg") or base.get("code_bg", "#efe9d8")),
        font_scale=_float_scale(
            cfg.get(
                "card_font_scale",
                float(base.get("font_scale", 1.0)) * 100
                if isinstance(base.get("font_scale"), float)
                else base.get("font_scale", 1.0),
            ),
            float(base.get("font_scale", 1.0)),
        ),
        mono=bool(mono),
        show_brand=bool(show_brand),
        density=density,
        custom_css=custom_css,
        font_path=font_path,
    )


def style_to_public(style: CardStyle) -> dict[str, Any]:
    d = asdict(style)
    # 不在公开字段里塞超长 css 两遍；调用方已有 config.card_custom_css
    return d


def extract_css_vars(css: str) -> dict[str, str]:
    """从 CSS 文本抽 --name: value;（足够覆盖 :root 与任意选择器）。"""
    out: dict[str, str] = {}
    if not css:
        return out
    for m in re.finditer(
        r"(--[a-zA-Z0-9-_]+)\s*:\s*([^;]+);", css
    ):
        out[m.group(1)] = m.group(2).strip()
    return out


def sample_payload(kind: str) -> dict[str, Any]:
    if kind == "pending":
        return {
            "title": "待审批",
            "subtitle": "当前窗口 2 项 · 全局 3 项",
            "rows": [
                {"index": 1, "label": "claude · auth-mw", "detail": "Bash · npm test"},
                {"index": 2, "label": "claude · auth-mw", "detail": "Edit · src/auth.ts"},
            ],
            "footer": "/hapi a  全部批准    /hapi pending  列表",
        }
    if kind == "permission":
        return {
            "title": "权限请求",
            "subtitle": "序号 1 · claude · auth-mw",
            "rows": [
                {"index": 0, "label": "工具", "detail": "Bash"},
                {"index": 0, "label": "命令", "detail": "pytest -q tests/test_auth.py"},
            ],
            "footer": "/hapi allow 1   /hapi deny 1",
        }
    if kind == "status":
        return {
            "title": "Session 状态",
            "subtitle": "claude · a1b2c3d4",
            "rows": [
                {"index": 0, "label": "状态", "detail": "active · thinking"},
                {"index": 0, "label": "模型", "detail": "opus · effort high"},
                {"index": 0, "label": "权限", "detail": "default"},
                {"index": 0, "label": "路径", "detail": "/home/dev/proj-auth"},
            ],
            "footer": "output=simple · render=auto",
        }
    if kind == "routes":
        return {
            "title": "推送路由",
            "subtitle": "通知投递优先级",
            "rows": [
                {"index": 1, "label": "会话绑定", "detail": "群 A · 20001"},
                {"index": 2, "label": "Agent 窗口", "detail": "claude → 私聊"},
                {"index": 3, "label": "默认窗口", "detail": "私聊 · 10001"},
            ],
            "footer": "/hapi bind  ·  /hapi routes",
        }
    if kind == "message":
        return {
            "title": "Agent 消息",
            "subtitle": "claude · auth-mw",
            "body": (
                "## 修复摘要\n\n"
                "已完成鉴权中间件重构：\n\n"
                "1. 统一 JWT 校验\n"
                "2. 补充单测覆盖\n\n"
                "```ts\n"
                "export function requireAuth(req) {\n"
                "  return verify(req.headers.authorization);\n"
                "}\n"
                "```\n\n"
                "> 建议：合并前跑一遍 `npm test`\n"
            ),
            "footer": "output=simple",
        }
    return {
        "title": "Session 列表",
        "subtitle": "当前窗口可见 · 3",
        "rows": [
            {"index": 1, "label": "claude", "detail": "重构鉴权中间件 · thinking"},
            {"index": 2, "label": "claude", "detail": "补 session 列表单测 · idle"},
            {"index": 3, "label": "codex", "detail": "API 文档生成 · active"},
        ],
        "footer": "/hapi sw <n>  切换    > 消息  快捷发送",
    }


def payload_to_fallback_text(kind: str, data: dict[str, Any]) -> str:
    if kind == "message":
        parts = [
            str(data.get("title") or ""),
            str(data.get("subtitle") or ""),
            str(data.get("body") or data.get("text") or ""),
        ]
        footer = data.get("footer")
        if footer:
            parts.append(str(footer))
        return "\n".join(p for p in parts if p).strip()

    lines = [str(data.get("title") or kind), str(data.get("subtitle") or "")]
    for row in data.get("rows") or []:
        idx = row.get("index") or 0
        label = row.get("label") or ""
        detail = row.get("detail") or ""
        prefix = f"[{idx}] " if idx else "  "
        lines.append(f"{prefix}{label}  {detail}".rstrip())
    footer = data.get("footer")
    if footer:
        lines.append("")
        lines.append(str(footer))
    return "\n".join(x for x in lines if x is not None).strip()


def should_render_card(
    *,
    kind: str,
    render_mode: str,
    kinds: list[str],
) -> bool:
    mode = (render_mode or "text").strip().lower()
    if mode == "text":
        return False
    if kind not in kinds:
        return False
    if mode == "card":
        return True
    # auto：所有已启用 kind 出卡（含 message）
    return kind in CARD_KINDS


def render_card(
    kind: str,
    data: dict[str, Any] | None = None,
    style: CardStyle | None = None,
    *,
    formula_mode: str = "off",
    prefer_engine: str | None = None,
) -> RenderResult:
    t0 = time.perf_counter()
    kind = kind if kind in CARD_KINDS else "session_list"
    data = data or sample_payload(kind)
    style = (style or CardStyle()).resolved()
    fallback = payload_to_fallback_text(kind, data)

    if not _HAS_PILLOW and not playwright_available():
        return RenderResult(
            ok=False,
            ms=(time.perf_counter() - t0) * 1000,
            engine="none",
            error="未安装渲染引擎。可选：pip install Pillow 或 playwright",
            kind=kind,
            fallback_text=fallback,
        )

    try:
        # 字体解析提前：失败时给出可移植提示，而不是出方块字
        font_file = font_manager.resolve_font_path(
            mono=style.mono,
            user_path=style.font_path or None,
        )
        engine_order = _engine_order(prefer_engine, style)
        last_err: str | None = None
        for eng in engine_order:
            try:
                if eng == "playwright":
                    html_doc, font_file = build_card_html(
                        kind, data, style, formula_mode=formula_mode
                    )
                    png, w, h = _render_with_playwright(html_doc, style)
                elif eng == "pillow":
                    png, w, h = _render_with_pillow(
                        kind, data, style, formula_mode=formula_mode
                    )
                else:
                    continue
                ms = (time.perf_counter() - t0) * 1000
                return RenderResult(
                    ok=True,
                    png=png,
                    width=w,
                    height=h,
                    bytes_len=len(png),
                    ms=ms,
                    engine=eng,
                    kind=kind,
                    fallback_text=fallback,
                    font_path=str(font_file or ""),
                )
            except Exception as e:
                last_err = f"{eng}: {e}"
                logger.warning("card render engine %s failed: %s", eng, e)
                continue
        return RenderResult(
            ok=False,
            ms=(time.perf_counter() - t0) * 1000,
            engine="none",
            error=last_err or "所有渲染引擎均失败",
            kind=kind,
            fallback_text=fallback,
            font_path=str(font_file or ""),
        )
    except Exception as e:
        logger.warning("card render failed: %s", e)
        return RenderResult(
            ok=False,
            ms=(time.perf_counter() - t0) * 1000,
            engine="none",
            error=str(e),
            kind=kind,
            fallback_text=fallback,
        )


def _engine_order(prefer: str | None, style: CardStyle | None = None) -> list[str]:
    """引擎选择：

    - 显式 prefer 优先
    - 有自定义 CSS 且 Playwright 可用 → 完整 CSS 保真
    - 否则 Pillow 低延迟快路径（结构卡 / 对话卡统一）
    """
    order: list[str] = []
    if prefer in ("playwright", "pillow"):
        order.append(prefer)

    has_custom = bool(style and (style.custom_css or "").strip())
    if has_custom and playwright_available() and "playwright" not in order:
        order.append("playwright")
    if _HAS_PILLOW and "pillow" not in order:
        order.append("pillow")
    # 无自定义 CSS 时 Playwright 仅作兜底（更慢）
    if playwright_available() and "playwright" not in order:
        order.append("playwright")
    return order


def render_meta() -> dict[str, Any]:
    return {
        "render_modes": list(RENDER_MODES),
        "formula_modes": list(FORMULA_MODES),
        "card_kinds": list(CARD_KINDS),
        "default_kinds": list(DEFAULT_KINDS),
        "presets": [
            {
                "id": pid,
                "label": {
                    "terminal_light": "终端浅色",
                    "terminal_dark": "终端深色",
                    "clean": "简洁",
                    "compact": "紧凑（手机）",
                }.get(pid, pid),
                "style": PRESETS[pid],
            }
            for pid in PRESET_IDS
        ],
        "density_options": list(DENSITY_OPTIONS),
        "samples": list(CARD_KINDS),
        "default_css": DEFAULT_CARD_CSS,
        "css_vars": [
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
            "--card-body-size",
        ],
        "engine": engine_status(),
        "formula_subset": {
            "supported": [],
            "planned": ["$inline$", "$$block$$"],
            "note": "formula_mode 预留；复杂公式回退源码文本。",
        },
    }


def config_defaults() -> dict[str, Any]:
    return {
        "render_mode": "text",
        "formula_mode": "off",
        "render_kinds": kinds_to_storage(list(DEFAULT_KINDS)),
        "card_style_preset": "terminal_light",
        "card_width": 720,
        "card_accent": "#1a7f4b",
        "card_bg": "#faf8f2",
        "card_fg": "#1c1914",
        "card_font_scale": 100,
        "card_density": "comfortable",
        "card_show_brand": True,
        "card_mono": True,
        "card_custom_css": "",
        "card_font_path": "",
    }


# ──── HTML 构建 ────


def _font_face_css(style: CardStyle) -> tuple[str, Path | None]:
    """生成 @font-face，返回 (css, font_path)。"""
    sans = font_manager.resolve_font_path(
        mono=False, user_path=style.font_path or None
    )
    mono = font_manager.resolve_font_path(
        mono=True, user_path=style.font_path or None
    )
    if sans is None:
        raise RuntimeError(
            font_manager.ensure_default_fonts().get("error")
            or "无可用中文字体"
        )
    mono = mono or sans

    def face(family: str, path: Path) -> str:
        # file:// 绝对路径，供 Playwright 加载
        uri = path.resolve().as_uri()
        fmt = "truetype"
        if path.suffix.lower() in (".otf",):
            fmt = "opentype"
        if path.suffix.lower() in (".ttc", ".otc"):
            # TTC：Playwright/Chromium 通常可加载
            fmt = "truetype"
        return (
            f"@font-face {{ font-family: '{family}'; "
            f"src: url('{uri}') format('{fmt}'); "
            f"font-weight: 100 900; font-style: normal; }}"
        )

    css = face("HapiCard", sans) + "\n" + face("HapiCardMono", mono)
    return css, sans


def _injected_root_vars(style: CardStyle) -> str:
    return f"""
:root {{
  --card-bg: {style.bg};
  --card-fg: {style.fg};
  --card-accent: {style.accent};
  --card-muted: {style.muted};
  --card-border: {style.border};
  --card-code-bg: {style.code_bg};
  --card-radius: {style.radius}px;
  --card-pad: {style.padding}px;
  --card-width: {style.width}px;
  --card-font-scale: {style.font_scale};
}}
"""


def build_card_html(
    kind: str,
    data: dict[str, Any],
    style: CardStyle,
    *,
    formula_mode: str = "off",
) -> tuple[str, Path | None]:
    font_css, font_path = _font_face_css(style)
    user_css = (style.custom_css or "").strip() or DEFAULT_CARD_CSS
    # 用户 CSS 在默认之后，可覆盖；再注入当前 token 变量保证滑块/配色生效
    css = (
        font_css
        + "\n"
        + DEFAULT_CARD_CSS
        + "\n"
        + user_css
        + "\n"
        + _injected_root_vars(style)
    )
    mono_cls = " mono" if style.mono else ""
    brand = (
        '<div class="card-brand">hapi connector</div>' if style.show_brand else ""
    )

    if kind == "message":
        body_md = str(data.get("body") or data.get("text") or "")
        body_html = markdown_to_html(body_md)
        title = html.escape(str(data.get("title") or "Agent 消息"))
        sub = html.escape(str(data.get("subtitle") or ""))
        foot = html.escape(str(data.get("footer") or ""))
        inner = f"""
        <div class="card-title">{title}</div>
        {f'<div class="card-sub">{sub}</div>' if sub else ''}
        <div class="card-bar"></div>
        <div class="md">{body_html}</div>
        {f'<div class="card-foot">{foot}</div>' if foot else ''}
        {brand}
        """
    else:
        title = html.escape(str(data.get("title") or kind))
        sub = html.escape(str(data.get("subtitle") or ""))
        foot = html.escape(str(data.get("footer") or ""))
        rows_html = []
        for row in data.get("rows") or []:
            idx = row.get("index") or 0
            label = html.escape(str(row.get("label") or ""))
            detail = html.escape(str(row.get("detail") or ""))
            head = f"[{idx}] {label}" if idx else label
            rows_html.append(
                f'<div class="row"><div class="row-head">{head}</div>'
                + (f'<div class="row-detail">{detail}</div>' if detail else "")
                + "</div>"
            )
        inner = f"""
        <div class="card-title">{title}</div>
        {f'<div class="card-sub">{sub}</div>' if sub else ''}
        <div class="card-bar"></div>
        {''.join(rows_html)}
        {f'<div class="card-foot">{foot}</div>' if foot else ''}
        {brand}
        """

    _ = formula_mode
    doc = f"""<!DOCTYPE html>
<html><head>
<meta charset="utf-8"/>
<style>
{css}
</style>
</head>
<body>
<div class="card{mono_cls}" id="card">
{inner}
</div>
</body></html>"""
    return doc, font_path


_MD_SPECIAL = re.compile(r"([&<>])")


def _esc(s: str) -> str:
    return html.escape(s, quote=False)


def markdown_to_html(text: str) -> str:
    """轻量 Markdown → HTML（标题/列表/代码/引用/粗斜体/链接/hr）。"""
    if not text:
        return ""
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    lines = text.split("\n")
    out: list[str] = []
    i = 0
    in_ul = False
    in_ol = False

    def close_lists():
        nonlocal in_ul, in_ol
        if in_ul:
            out.append("</ul>")
            in_ul = False
        if in_ol:
            out.append("</ol>")
            in_ol = False

    while i < len(lines):
        line = lines[i]
        # fenced code
        if line.strip().startswith("```"):
            close_lists()
            lang = line.strip()[3:].strip()
            i += 1
            code_lines = []
            while i < len(lines) and not lines[i].strip().startswith("```"):
                code_lines.append(lines[i])
                i += 1
            if i < len(lines):
                i += 1
            code = _esc("\n".join(code_lines))
            out.append(
                f'<pre><code class="lang-{_esc(lang)}">{code}</code></pre>'
            )
            continue

        if not line.strip():
            close_lists()
            i += 1
            continue

        if re.match(r"^---+$|^\*\*\*+$|^___+$", line.strip()):
            close_lists()
            out.append("<hr/>")
            i += 1
            continue

        m = re.match(r"^(#{1,3})\s+(.*)$", line)
        if m:
            close_lists()
            level = len(m.group(1))
            out.append(f"<h{level}>{_inline(m.group(2))}</h{level}>")
            i += 1
            continue

        if line.lstrip().startswith(">"):
            close_lists()
            q = re.sub(r"^\s*>\s?", "", line)
            out.append(f"<blockquote><p>{_inline(q)}</p></blockquote>")
            i += 1
            continue

        m = re.match(r"^\s*[-*+]\s+(.*)$", line)
        if m:
            if in_ol:
                out.append("</ol>")
                in_ol = False
            if not in_ul:
                out.append("<ul>")
                in_ul = True
            out.append(f"<li>{_inline(m.group(1))}</li>")
            i += 1
            continue

        m = re.match(r"^\s*\d+\.\s+(.*)$", line)
        if m:
            if in_ul:
                out.append("</ul>")
                in_ul = False
            if not in_ol:
                out.append("<ol>")
                in_ol = True
            out.append(f"<li>{_inline(m.group(1))}</li>")
            i += 1
            continue

        close_lists()
        out.append(f"<p>{_inline(line)}</p>")
        i += 1

    close_lists()
    return "\n".join(out)


def _inline(s: str) -> str:
    s = _esc(s)
    s = re.sub(r"`([^`]+)`", r"<code>\1</code>", s)
    s = re.sub(r"\*\*([^*]+)\*\*", r"<strong>\1</strong>", s)
    s = re.sub(r"__([^_]+)__", r"<strong>\1</strong>", s)
    s = re.sub(r"(?<!\*)\*([^*]+)\*(?!\*)", r"<em>\1</em>", s)
    s = re.sub(r"\[([^\]]+)\]\(([^)]+)\)", r'<a href="\2">\1</a>', s)
    return s


# ──── Playwright 引擎 ────


def _render_with_playwright(html_doc: str, style: CardStyle) -> tuple[bytes, int, int]:
    from playwright.sync_api import sync_playwright  # type: ignore

    # Playwright sync 在已有 asyncio loop 里可能炸；用临时线程
    import concurrent.futures

    def _run():
        with sync_playwright() as p:
            browser = p.chromium.launch(
                args=["--no-sandbox", "--disable-dev-shm-usage"]
            )
            try:
                page = browser.new_page(
                    viewport={"width": style.width + 40, "height": 200},
                    device_scale_factor=2,
                )
                page.set_content(html_doc, wait_until="load")
                # 等待字体
                page.evaluate("() => document.fonts.ready")
                card = page.locator("#card")
                box = card.bounding_box()
                if not box:
                    raise RuntimeError("无法测量卡片尺寸")
                png = card.screenshot(type="png")
                return png, int(box["width"]), int(box["height"])
            finally:
                browser.close()

    # 若在 running loop 中，丢到线程
    try:
        import asyncio

        asyncio.get_running_loop()
        in_loop = True
    except RuntimeError:
        in_loop = False

    if in_loop:
        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as ex:
            return ex.submit(_run).result(timeout=60)
    return _run()


# ──── Pillow 引擎 ────


def _hex_to_rgb(h: str) -> tuple[int, int, int]:
    s = h.lstrip("#")
    if len(s) == 3:
        s = "".join(c * 2 for c in s)
    if len(s) != 6:
        raise ValueError(f"bad color {h}")
    return int(s[0:2], 16), int(s[2:4], 16), int(s[4:6], 16)


def _load_font(size: int, mono: bool, style: CardStyle):
    return font_manager.load_image_font(
        size,
        mono=mono,
        user_path=style.font_path or None,
    )


def _text_size(draw, text: str, font) -> tuple[int, int]:
    bbox = draw.textbbox((0, 0), text or " ", font=font)
    return bbox[2] - bbox[0], bbox[3] - bbox[1]


def _wrap_text(draw, text: str, font, max_width: int) -> list[str]:
    text = (text or "").replace("\r\n", "\n").replace("\r", "\n")
    lines: list[str] = []
    for para in text.split("\n"):
        if not para:
            lines.append("")
            continue
        cur = ""
        for ch in para:
            trial = cur + ch
            w, _ = _text_size(draw, trial, font)
            if w <= max_width or not cur:
                cur = trial
            else:
                lines.append(cur)
                cur = ch
        if cur:
            lines.append(cur)
    return lines or [""]


def _draw_rounded_rect(draw, xy, radius: int, fill, outline=None, width: int = 1):
    draw.rounded_rectangle(xy, radius=radius, fill=fill, outline=outline, width=width)


def _render_with_pillow(
    kind: str,
    data: dict[str, Any],
    style: CardStyle,
    *,
    formula_mode: str = "off",
) -> tuple[bytes, int, int]:
    if kind == "message":
        return _draw_message_png(data, style)
    return _draw_struct_png(kind, data, style, formula_mode=formula_mode)


def _draw_struct_png(
    kind: str,
    data: dict[str, Any],
    style: CardStyle,
    *,
    formula_mode: str = "off",
) -> tuple[bytes, int, int]:
    scale = style.font_scale
    dense = style.density == "compact"
    pad = style.padding
    width = style.width
    content_w = width - pad * 2

    title_size = max(14, int(22 * scale))
    sub_size = max(11, int(13 * scale))
    body_size = max(11, int(14 * scale))
    foot_size = max(10, int(12 * scale))
    line_gap = 6 if dense else 10
    row_gap = 8 if dense else 12

    tmp = Image.new("RGB", (width, 100), _hex_to_rgb(style.bg))
    d0 = ImageDraw.Draw(tmp)
    font_title = _load_font(title_size, style.mono, style)
    font_sub = _load_font(sub_size, style.mono, style)
    font_body = _load_font(body_size, style.mono, style)
    font_foot = _load_font(foot_size, style.mono, style)

    title = str(data.get("title") or kind)
    subtitle = str(data.get("subtitle") or "")
    rows = list(data.get("rows") or [])
    footer = str(data.get("footer") or "")

    y = pad
    y += _text_size(d0, title, font_title)[1] + 6
    if subtitle:
        for _ in _wrap_text(d0, subtitle, font_sub, content_w):
            y += _text_size(d0, "测", font_sub)[1] + 2
        y += 8
    y += 2 + line_gap
    for row in rows:
        label = str(row.get("label") or "")
        detail = str(row.get("detail") or "")
        idx = row.get("index") or 0
        head = f"[{idx}] {label}" if idx else label
        for _ in _wrap_text(d0, head, font_body, content_w):
            y += _text_size(d0, "测", font_body)[1] + 2
        if detail:
            for _ in _wrap_text(d0, detail, font_sub, content_w - 12):
                y += _text_size(d0, "测", font_sub)[1] + 2
        y += row_gap
    if footer:
        y += 4
        for _ in _wrap_text(d0, footer, font_foot, content_w):
            y += _text_size(d0, "测", font_foot)[1] + 2
    if style.show_brand:
        y += 10 + _text_size(d0, "hapi", font_foot)[1]
    y += pad
    height = max(y, 120)

    bg = _hex_to_rgb(style.bg)
    fg = _hex_to_rgb(style.fg)
    accent = _hex_to_rgb(style.accent)
    muted = _hex_to_rgb(style.muted)
    border = _hex_to_rgb(style.border)

    img = Image.new("RGB", (width, height), bg)
    draw = ImageDraw.Draw(img)
    _draw_rounded_rect(
        draw,
        (1, 1, width - 2, height - 2),
        radius=style.radius,
        fill=bg,
        outline=border,
        width=2,
    )

    y = pad
    draw.text((pad, y), title, font=font_title, fill=fg)
    y += _text_size(draw, title, font_title)[1] + 6
    if subtitle:
        for line in _wrap_text(draw, subtitle, font_sub, content_w):
            draw.text((pad, y), line, font=font_sub, fill=muted)
            y += _text_size(draw, line or " ", font_sub)[1] + 2
        y += 8
    draw.rectangle((pad, y, pad + min(120, content_w // 3), y + 3), fill=accent)
    y += 3 + line_gap

    for row in rows:
        label = str(row.get("label") or "")
        detail = str(row.get("detail") or "")
        idx = row.get("index") or 0
        head = f"[{idx}] {label}" if idx else label
        for line in _wrap_text(draw, head, font_body, content_w):
            draw.text((pad, y), line, font=font_body, fill=fg)
            y += _text_size(draw, line or " ", font_body)[1] + 2
        if detail:
            for line in _wrap_text(draw, detail, font_sub, content_w - 12):
                draw.text((pad + 12, y), line, font=font_sub, fill=muted)
                y += _text_size(draw, line or " ", font_sub)[1] + 2
        y += row_gap

    if footer:
        y += 4
        draw.line((pad, y, width - pad, y), fill=border, width=1)
        y += 8
        for line in _wrap_text(draw, footer, font_foot, content_w):
            draw.text((pad, y), line, font=font_foot, fill=accent)
            y += _text_size(draw, line or " ", font_foot)[1] + 2

    if style.show_brand:
        brand = "hapi connector"
        bw, bh = _text_size(draw, brand, font_foot)
        draw.text(
            (width - pad - bw, height - pad - bh), brand, font=font_foot, fill=muted
        )

    _ = formula_mode
    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=True)
    return buf.getvalue(), width, height


def _draw_message_png(data: dict[str, Any], style: CardStyle) -> tuple[bytes, int, int]:
    """Pillow 对话卡：Markdown 子集的简易排版。"""
    scale = style.font_scale
    pad = style.padding
    width = style.width
    content_w = width - pad * 2

    title_size = max(14, int(20 * scale))
    sub_size = max(11, int(12 * scale))
    body_size = max(11, int(14 * scale))
    code_size = max(10, int(12.5 * scale))
    h1_size = max(16, int(20 * scale))
    h2_size = max(15, int(17 * scale))
    foot_size = max(10, int(12 * scale))

    tmp = Image.new("RGB", (width, 100), _hex_to_rgb(style.bg))
    d0 = ImageDraw.Draw(tmp)

    font_title = _load_font(title_size, style.mono, style)
    font_sub = _load_font(sub_size, style.mono, style)
    font_body = _load_font(body_size, False, style)
    font_code = _load_font(code_size, True, style)
    font_h1 = _load_font(h1_size, False, style)
    font_h2 = _load_font(h2_size, False, style)
    font_foot = _load_font(foot_size, style.mono, style)

    title = str(data.get("title") or "Agent 消息")
    subtitle = str(data.get("subtitle") or "")
    body = str(data.get("body") or data.get("text") or "")
    footer = str(data.get("footer") or "")

    blocks = _parse_md_blocks(body)

    def measure_block(b) -> int:
        h = 0
        if b["type"] == "code":
            for line in _wrap_text(d0, b["text"], font_code, content_w - 20) or [""]:
                h += _text_size(d0, line or " ", font_code)[1] + 2
            return h + 20
        if b["type"] in ("h1", "h2", "h3"):
            f = font_h1 if b["type"] == "h1" else font_h2
            for line in _wrap_text(d0, b["text"], f, content_w):
                h += _text_size(d0, line or " ", f)[1] + 2
            return h + 8
        if b["type"] == "hr":
            return 14
        f = font_body
        prefix = ""
        if b["type"] == "li":
            prefix = "• "
        elif b["type"] == "quote":
            prefix = "│ "
        text = prefix + b["text"]
        for line in _wrap_text(d0, text, f, content_w):
            h += _text_size(d0, line or " ", f)[1] + 2
        return h + 6

    y = pad
    y += _text_size(d0, title, font_title)[1] + 6
    if subtitle:
        for _ in _wrap_text(d0, subtitle, font_sub, content_w):
            y += _text_size(d0, "测", font_sub)[1] + 2
        y += 6
    y += 8  # bar
    for b in blocks:
        y += measure_block(b)
    if footer:
        y += 16
        for _ in _wrap_text(d0, footer, font_foot, content_w):
            y += _text_size(d0, "测", font_foot)[1] + 2
    if style.show_brand:
        y += 10 + _text_size(d0, "hapi", font_foot)[1]
    y += pad
    # 限高，避免爆炸
    height = min(max(y, 120), 4000)

    bg = _hex_to_rgb(style.bg)
    fg = _hex_to_rgb(style.fg)
    accent = _hex_to_rgb(style.accent)
    muted = _hex_to_rgb(style.muted)
    border = _hex_to_rgb(style.border)
    code_bg = _hex_to_rgb(style.code_bg)

    img = Image.new("RGB", (width, height), bg)
    draw = ImageDraw.Draw(img)
    _draw_rounded_rect(
        draw,
        (1, 1, width - 2, height - 2),
        radius=style.radius,
        fill=bg,
        outline=border,
        width=2,
    )

    y = pad
    draw.text((pad, y), title, font=font_title, fill=fg)
    y += _text_size(draw, title, font_title)[1] + 6
    if subtitle:
        for line in _wrap_text(draw, subtitle, font_sub, content_w):
            draw.text((pad, y), line, font=font_sub, fill=muted)
            y += _text_size(draw, line or " ", font_sub)[1] + 2
        y += 6
    draw.rectangle((pad, y, pad + min(120, content_w // 3), y + 3), fill=accent)
    y += 10

    for b in blocks:
        if y > height - pad - 20:
            draw.text((pad, y), "…", font=font_body, fill=muted)
            break
        if b["type"] == "code":
            lines = _wrap_text(draw, b["text"], font_code, content_w - 20) or [""]
            block_h = sum(_text_size(draw, ln or " ", font_code)[1] + 2 for ln in lines) + 16
            _draw_rounded_rect(
                draw,
                (pad, y, width - pad, y + block_h),
                radius=6,
                fill=code_bg,
                outline=border,
                width=1,
            )
            yy = y + 8
            for line in lines:
                draw.text((pad + 10, yy), line, font=font_code, fill=fg)
                yy += _text_size(draw, line or " ", font_code)[1] + 2
            y += block_h + 8
            continue
        if b["type"] == "hr":
            draw.line((pad, y + 6, width - pad, y + 6), fill=border, width=1)
            y += 14
            continue
        if b["type"] in ("h1", "h2", "h3"):
            f = font_h1 if b["type"] == "h1" else font_h2
            for line in _wrap_text(draw, b["text"], f, content_w):
                draw.text((pad, y), line, font=f, fill=fg)
                y += _text_size(draw, line or " ", f)[1] + 2
            y += 6
            continue
        prefix = ""
        xoff = 0
        color = fg
        if b["type"] == "li":
            prefix = "• "
        elif b["type"] == "quote":
            prefix = "│ "
            color = muted
            draw.rectangle((pad, y, pad + 3, y + 16), fill=accent)
            xoff = 8
        text = prefix + b["text"]
        for line in _wrap_text(draw, text, font_body, content_w - xoff):
            draw.text((pad + xoff, y), line, font=font_body, fill=color)
            y += _text_size(draw, line or " ", font_body)[1] + 2
        y += 4

    if footer and y < height - pad:
        draw.line((pad, y + 4, width - pad, y + 4), fill=border, width=1)
        y += 12
        for line in _wrap_text(draw, footer, font_foot, content_w):
            draw.text((pad, y), line, font=font_foot, fill=accent)
            y += _text_size(draw, line or " ", font_foot)[1] + 2

    if style.show_brand:
        brand = "hapi connector"
        bw, bh = _text_size(draw, brand, font_foot)
        draw.text(
            (width - pad - bw, height - pad - bh), brand, font=font_foot, fill=muted
        )

    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=True)
    return buf.getvalue(), width, height


def _parse_md_blocks(text: str) -> list[dict[str, str]]:
    text = (text or "").replace("\r\n", "\n").replace("\r", "\n")
    lines = text.split("\n")
    blocks: list[dict[str, str]] = []
    i = 0
    while i < len(lines):
        line = lines[i]
        if line.strip().startswith("```"):
            i += 1
            buf = []
            while i < len(lines) and not lines[i].strip().startswith("```"):
                buf.append(lines[i])
                i += 1
            if i < len(lines):
                i += 1
            blocks.append({"type": "code", "text": "\n".join(buf)})
            continue
        if not line.strip():
            i += 1
            continue
        if re.match(r"^---+$|^\*\*\*+$|^___+$", line.strip()):
            blocks.append({"type": "hr", "text": ""})
            i += 1
            continue
        m = re.match(r"^(#{1,3})\s+(.*)$", line)
        if m:
            level = len(m.group(1))
            blocks.append({"type": f"h{level}", "text": m.group(2)})
            i += 1
            continue
        if line.lstrip().startswith(">"):
            blocks.append(
                {"type": "quote", "text": re.sub(r"^\s*>\s?", "", line)}
            )
            i += 1
            continue
        m = re.match(r"^\s*[-*+]\s+(.*)$", line)
        if m:
            blocks.append({"type": "li", "text": m.group(1)})
            i += 1
            continue
        m = re.match(r"^\s*\d+\.\s+(.*)$", line)
        if m:
            blocks.append({"type": "li", "text": m.group(1)})
            i += 1
            continue
        # strip simple ** for pillow plain text
        plain = re.sub(r"\*\*([^*]+)\*\*", r"\1", line)
        plain = re.sub(r"`([^`]+)`", r"\1", plain)
        blocks.append({"type": "p", "text": plain})
        i += 1
    return blocks or [{"type": "p", "text": ""}]
