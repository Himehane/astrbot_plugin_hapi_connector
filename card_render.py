"""推送卡片渲染。

能力：
1. 结构卡（list / pending / status / permission / routes）
2. 对话卡（message）：Markdown 子集
3. **自定义 CSS**：`card_custom_css`；Pillow 解析 `--card-*` 变量与基础排版
4. **字体**：见 font_manager（card_font_path → assets/fonts → 系统 CJK；无则回退文本）

可选依赖：
    pip install Pillow
"""

from __future__ import annotations

import html
import io
import re
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
except ImportError:  # pragma: no cover — 脚本直跑 / 未作为包部署
    try:
        import font_manager  # type: ignore
    except ImportError:
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


RENDER_MODES = ("text", "card")
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
DEFAULT_KINDS = (
    "session_list",
    "pending",
    "status",
    "permission",
    "routes",
    "message",
)

# 默认 CSS：用户可在 WebUI 整段覆盖 / 追加。变量名是 Pillow 引擎的契约。
DEFAULT_CARD_CSS = """\
/* HAPI Connector 推送卡片默认样式（当前生效时可在 WebUI 直接改）
 * Pillow 识别下方 --card-* 变量与基础字号/内边距。
 */
:root {
  --card-bg: #f7f4ea;
  --card-fg: #14120f;
  --card-accent: #0f6b3c;
  --card-muted: #3a362e;
  --card-border: #c9c2b0;
  --card-code-bg: #ebe4d0;
  --card-radius: 12px;
  --card-pad: 28px;
  --card-width: 720px;
  --card-font-scale: 1.12;
  --card-title-size: 24px;
  --card-body-size: 17px;
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
.row-section {
  margin: 14px 0 6px;
  font-weight: 700;
  color: var(--card-accent);
  font-size: 0.95em;
}
.row-section .row-detail {
  display: inline;
  padding-left: 6px;
  font-weight: 500;
  color: var(--card-muted);
  font-size: 0.9em;
}
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
    padding: int = 28
    radius: int = 12
    bg: str = "#f7f4ea"
    fg: str = "#14120f"
    accent: str = "#0f6b3c"
    muted: str = "#3a362e"  # 副文也够深，手机上可读
    border: str = "#c9c2b0"
    code_bg: str = "#ebe4d0"
    font_scale: float = 1.12
    mono: bool = False  # 正文默认非等宽，更清晰
    show_brand: bool = True
    density: str = "comfortable"
    custom_css: str = ""
    font_path: str = ""

    def resolved(self) -> "CardStyle":
        preset = self.preset if self.preset in PRESETS else "terminal_light"
        dens = self.density if self.density in DENSITY_OPTIONS else "comfortable"
        width = max(400, min(1400, int(self.width or 720)))
        scale = float(self.font_scale or 1.12)
        if scale > 3:
            scale = scale / 100.0
        scale = max(0.85, min(1.6, scale))
        return CardStyle(
            preset=preset,
            width=width,
            padding=max(12, min(48, int(self.padding or 28))),
            radius=max(0, min(28, int(self.radius or 12))),
            bg=self.bg or "#f7f4ea",
            fg=self.fg or "#14120f",
            accent=self.accent or "#0f6b3c",
            muted=self.muted or "#3a362e",
            border=self.border or "#c9c2b0",
            code_bg=self.code_bg or "#ebe4d0",
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
        "padding": 28,
        "radius": 12,
        "bg": "#f7f4ea",
        "fg": "#14120f",
        "accent": "#0f6b3c",
        "muted": "#3a362e",
        "border": "#c9c2b0",
        "code_bg": "#ebe4d0",
        "font_scale": 1.12,
        "mono": False,
        "show_brand": True,
        "density": "comfortable",
    },
    "terminal_dark": {
        "preset": "terminal_dark",
        "width": 720,
        "padding": 28,
        "radius": 12,
        "bg": "#16140f",
        "fg": "#f4efe4",
        "accent": "#4ade9b",
        "muted": "#c4bba8",
        "border": "#3d3a32",
        "code_bg": "#2a261e",
        "font_scale": 1.12,
        "mono": False,
        "show_brand": True,
        "density": "comfortable",
    },
    "clean": {
        "preset": "clean",
        "width": 720,
        "padding": 30,
        "radius": 16,
        "bg": "#ffffff",
        "fg": "#0f172a",
        "accent": "#1d4ed8",
        "muted": "#334155",
        "border": "#cbd5e1",
        "code_bg": "#f1f5f9",
        "font_scale": 1.15,
        "mono": False,
        "show_brand": True,
        "density": "comfortable",
    },
    "compact": {
        "preset": "compact",
        "width": 600,
        "padding": 20,
        "radius": 10,
        "bg": "#f7f4ea",
        "fg": "#14120f",
        "accent": "#0f6b3c",
        "muted": "#3a362e",
        "border": "#c9c2b0",
        "code_bg": "#ebe4d0",
        "font_scale": 1.05,
        "mono": False,
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


def engine_status(user_font_path: str | None = None) -> dict[str, Any]:
    fonts = font_manager.font_status(user_path=user_font_path or None)
    return {
        "pillow": _HAS_PILLOW,
        "engines": {"card": "pillow" if _HAS_PILLOW else None},
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
            "footer": "output=simple · render=card",
        }
    if kind == "routes":
        return {
            "title": "推送路由",
            "subtitle": "绑定 1 · 有默认窗口 · Agent 1",
            "rows": [
                {"type": "section", "label": "会话绑定", "detail": "1", "count": 1},
                {
                    "type": "row",
                    "index": 1,
                    "sid_short": "a1b2c3d4",
                    "label": "[claude] 重构鉴权",
                    "detail": "→ Bot:maimai-群聊-1081179981",
                },
                {"type": "section", "label": "默认发送窗口", "detail": "", "count": 1},
                {
                    "type": "row",
                    "index": 0,
                    "label": "primary",
                    "detail": "Bot:maimai-私聊-2732367272",
                },
                {"type": "section", "label": "Agent 默认窗口", "detail": "1", "count": 1},
                {
                    "type": "row",
                    "index": 0,
                    "label": "claude",
                    "detail": "Bot:maimai-私聊-2732367272",
                },
            ],
            "footer": "bind 设默认   ·   bind <agent> 设 Agent 窗口   ·   routes",
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
        "subtitle": "当前窗口 · 3 个 · 思考 1 / 运行 1 / 关闭 1",
        "layout": "session_list",
        "rows": [
            {"type": "section", "label": "…/dev/proj-auth", "full_path": "/home/dev/proj-auth", "detail": "2", "count": 2},
            {
                "type": "session",
                "index": 1,
                "sid_short": "a1b2c3d4",
                "label": "重构鉴权中间件",
                "detail": "思考中 · claude:opus · 当前",
                "status": "思考中",
                "status_key": "thinking",
                "flavor": "claude",
                "model": "opus",
                "pending": 0,
                "is_current": True,
            },
            {
                "type": "session",
                "index": 2,
                "sid_short": "e5f6g7h8",
                "label": "补 session 列表单测",
                "detail": "已关闭 · claude:sonnet",
                "status": "已关闭",
                "status_key": "closed",
                "flavor": "claude",
                "model": "sonnet",
                "pending": 0,
                "is_current": False,
            },
            {"type": "section", "label": "…/dev/docs", "full_path": "/home/dev/docs", "detail": "1", "count": 1},
            {
                "type": "session",
                "index": 3,
                "sid_short": "i9j0k1l2",
                "label": "API 文档生成",
                "detail": "运行中 · codex:default",
                "status": "运行中",
                "status_key": "active",
                "flavor": "codex",
                "model": "default",
                "pending": 1,
                "is_current": False,
            },
        ],
        "footer": "sw <序号|ID> 切换   ·   > 消息 快捷发送   ·   list all 全局",
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
        rtype = str(row.get("type") or "row")
        label = str(row.get("label") or "")
        detail = str(row.get("detail") or "")
        if rtype == "section":
            lines.append("")
            lines.append(f"{label}" + (f" ({detail})" if detail else ""))
            continue
        idx = row.get("index") or 0
        sid = str(row.get("sid_short") or "")
        if idx and sid:
            head = f"[{idx} | {sid}] {label}"
        elif idx:
            head = f"[{idx}] {label}"
        else:
            head = label
        lines.append(head)
        if detail:
            lines.append(detail)
    footer = data.get("footer")
    if footer:
        lines.append("")
        lines.append(str(footer))
    return "\n".join(x for x in lines if x is not None).strip()


def normalize_render_mode(raw) -> str:
    """仅 text / card。"""
    mode = str(raw or "text").strip().lower()
    if mode == "card":
        return "card"
    return "text"


def should_render_card(
    *,
    kind: str,
    render_mode: str,
    kinds: list[str],
) -> bool:
    mode = normalize_render_mode(render_mode)
    if mode != "card":
        return False
    if kind not in CARD_KINDS:
        return False
    return kind in (kinds or [])


def render_card(
    kind: str,
    data: dict[str, Any] | None = None,
    style: CardStyle | None = None,
    *,
    formula_mode: str = "off",
) -> RenderResult:
    """Pillow 出卡。无 Pillow / 无字体时 ok=False，调用方回退文本。"""
    t0 = time.perf_counter()
    kind = kind if kind in CARD_KINDS else "session_list"
    data = data or sample_payload(kind)
    style = (style or CardStyle()).resolved()
    fallback = payload_to_fallback_text(kind, data)

    if not _HAS_PILLOW:
        return RenderResult(
            ok=False,
            ms=(time.perf_counter() - t0) * 1000,
            engine="none",
            error="未安装 Pillow。可在 WebUI 勾选安装，或 pip install Pillow",
            kind=kind,
            fallback_text=fallback,
        )

    font_file = font_manager.resolve_font_path(
        mono=style.mono,
        user_path=style.font_path or None,
    )
    try:
        png, w, h = _render_with_pillow(
            kind, data, style, formula_mode=formula_mode
        )
        ms = (time.perf_counter() - t0) * 1000
        return RenderResult(
            ok=True,
            png=png,
            width=w,
            height=h,
            bytes_len=len(png),
            ms=ms,
            engine="pillow",
            kind=kind,
            fallback_text=fallback,
            font_path=str(font_file or ""),
        )
    except Exception as e:
        logger.warning("card render failed: %s", e)
        return RenderResult(
            ok=False,
            ms=(time.perf_counter() - t0) * 1000,
            engine="pillow",
            error=str(e),
            kind=kind,
            fallback_text=fallback,
            font_path=str(font_file or ""),
        )


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
            "note": "formula_mode 未接引擎时公式按源码文本显示。",
        },
    }


def config_defaults() -> dict[str, Any]:
    return {
        "render_mode": "text",
        "formula_mode": "off",
        "render_kinds": kinds_to_storage(list(DEFAULT_KINDS)),
        "card_style_preset": "terminal_light",
        "card_width": 720,
        "card_accent": "#0f6b3c",
        "card_bg": "#f7f4ea",
        "card_fg": "#14120f",
        "card_font_scale": 112,
        "card_density": "comfortable",
        "card_show_brand": True,
        "card_mono": False,
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
            rtype = str(row.get("type") or "row")
            label = html.escape(str(row.get("label") or ""))
            detail = html.escape(str(row.get("detail") or ""))
            if rtype == "section":
                sec = label + (f" ({detail})" if detail else "")
                rows_html.append(
                    f'<div class="row row-section"><span class="row-head">{sec}</span></div>'
                )
                continue
            idx = row.get("index") or 0
            sid = html.escape(str(row.get("sid_short") or ""))
            if idx and sid:
                head = f"[{idx} | {sid}] {label}"
            elif idx:
                head = f"[{idx}] {label}"
            else:
                head = label
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
    if kind == "session_list" or data.get("layout") == "session_list":
        return _draw_session_list_png(data, style)
    return _draw_struct_png(kind, data, style, formula_mode=formula_mode)


def _mix_rgb(
    a: tuple[int, int, int], b: tuple[int, int, int], t: float
) -> tuple[int, int, int]:
    t = max(0.0, min(1.0, t))
    return (
        int(a[0] + (b[0] - a[0]) * t),
        int(a[1] + (b[1] - a[1]) * t),
        int(a[2] + (b[2] - a[2]) * t),
    )


def _status_color(
    status_key: str,
    accent: tuple[int, int, int],
    muted: tuple[int, int, int],
    fg: tuple[int, int, int],
) -> tuple[int, int, int]:
    sk = (status_key or "").lower()
    if sk in ("thinking", "think"):
        return accent
    if sk in ("active", "running", "run"):
        return (46, 125, 72)  # green-ish, readable on light/dark-ish
    if sk in ("closed", "idle", "inactive"):
        return muted
    return fg


def _draw_session_list_png(
    data: dict[str, Any],
    style: CardStyle,
) -> tuple[bytes, int, int]:
    """会话列表专用版式：分组头 + 卡片行 + 状态色点 + 当前高亮，不照抄文本列表。"""
    scale = style.font_scale
    dense = style.density == "compact"
    pad = style.padding
    width = style.width
    content_w = width - pad * 2

    title_size = max(18, int(24 * scale))
    sub_size = max(13, int(14.5 * scale))
    body_size = max(14, int(16.5 * scale))
    meta_size = max(12, int(13.5 * scale))
    foot_size = max(12, int(13 * scale))
    idx_size = max(13, int(14 * scale))

    row_pad_y = 10 if dense else 13
    row_pad_x = 12 if dense else 14
    section_gap = 12 if dense else 16
    row_gap = 8 if dense else 10

    tmp = Image.new("RGB", (width, 100), _hex_to_rgb(style.bg))
    d0 = ImageDraw.Draw(tmp)
    font_title = _load_font(title_size, False, style)
    font_sub = _load_font(sub_size, False, style)
    font_body = _load_font(body_size, False, style)
    font_meta = _load_font(meta_size, False, style)
    font_foot = _load_font(foot_size, False, style)
    font_idx = _load_font(idx_size, True, style)

    title = str(data.get("title") or "Session 列表")
    subtitle = str(data.get("subtitle") or "")
    rows = list(data.get("rows") or [])
    footer = str(data.get("footer") or "")

    bg = _hex_to_rgb(style.bg)
    fg = _hex_to_rgb(style.fg)
    accent = _hex_to_rgb(style.accent)
    muted = _hex_to_rgb(style.muted)
    sub_fg = _mix_rgb(muted, fg, 0.35)
    border = _hex_to_rgb(style.border)
    # 行底：略深/浅于背景，保证对比
    row_bg = _mix_rgb(bg, fg, 0.05)
    row_bg_cur = _mix_rgb(bg, accent, 0.14)
    section_bg = _mix_rgb(bg, accent, 0.08)

    idx_box_w = max(42, int(46 * scale))
    # 预估高度
    y = pad
    y += _text_size(d0, title, font_title)[1] + 6
    if subtitle:
        for _ in _wrap_text(d0, subtitle, font_sub, content_w):
            y += _text_size(d0, "测", font_sub)[1] + 2
        y += 6
    y += 10  # bar
    for row in rows:
        rtype = str(row.get("type") or "row")
        if rtype == "section":
            y += section_gap + 22 * scale
            continue
        label = str(row.get("label") or "")
        # 标题可能折行
        title_lines = _wrap_text(d0, label, font_body, content_w - idx_box_w - row_pad_x * 2 - 8)
        meta_h = _text_size(d0, "测", font_meta)[1] + 2
        y += row_pad_y * 2 + sum(
            _text_size(d0, ln or " ", font_body)[1] + 2 for ln in title_lines
        ) + meta_h + row_gap
    if footer:
        y += 20 + _text_size(d0, "测", font_foot)[1] * 2
    if style.show_brand:
        y += 12 + _text_size(d0, "hapi", font_foot)[1]
    y += pad
    height = min(max(int(y), 140), 4500)

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
            draw.text((pad, y), line, font=font_sub, fill=sub_fg)
            y += _text_size(draw, line or " ", font_sub)[1] + 2
        y += 6
    draw.rectangle((pad, y, pad + min(140, content_w // 3), y + 4), fill=accent)
    y += 14

    for row in rows:
        rtype = str(row.get("type") or "row")
        if rtype == "section":
            y += max(4, section_gap // 2)
            label = str(row.get("label") or "")
            count = row.get("count")
            if count is None:
                detail = str(row.get("detail") or "").strip()
                count_txt = detail if detail else ""
            else:
                count_txt = f"{count}"
            # 分组条
            sec_h = max(28, int(30 * scale))
            _draw_rounded_rect(
                draw,
                (pad, y, width - pad, y + sec_h),
                radius=6,
                fill=section_bg,
                outline=None,
            )
            # 左侧色条
            draw.rectangle((pad, y + 4, pad + 4, y + sec_h - 4), fill=accent)
            tx = pad + 14
            ty = y + (sec_h - _text_size(draw, "测", font_meta)[1]) // 2
            for line in _wrap_text(draw, label, font_meta, content_w - 90)[:1]:
                draw.text((tx, ty), line, font=font_meta, fill=accent)
            if count_txt:
                badge = f"{count_txt} 个" if not str(count_txt).endswith("个") else str(count_txt)
                bw, bh = _text_size(draw, badge, font_meta)
                bx = width - pad - bw - 12
                by = y + (sec_h - bh) // 2
                draw.text((bx, by), badge, font=font_meta, fill=sub_fg)
            y += sec_h + 8
            continue

        label = str(row.get("label") or "")
        idx = row.get("index") or 0
        sid = str(row.get("sid_short") or "")
        status = str(row.get("status") or "")
        status_key = str(row.get("status_key") or "")
        flavor = str(row.get("flavor") or "")
        model = str(row.get("model") or "")
        pending = int(row.get("pending") or 0)
        is_current = bool(row.get("is_current"))
        # 兼容旧 payload：从 detail 拼 meta
        if not status and row.get("detail"):
            status = str(row.get("detail"))

        title_max_w = content_w - idx_box_w - row_pad_x * 2 - 10
        title_lines = _wrap_text(draw, label, font_body, title_max_w) or [""]
        meta_bits = []
        if status:
            meta_bits.append(status)
        if flavor or model:
            meta_bits.append(f"{flavor}:{model}" if flavor else model)
        if pending:
            meta_bits.append(f"待审 {pending}")
        if is_current:
            meta_bits.append("当前")
        if not meta_bits and row.get("detail"):
            meta_bits.append(str(row.get("detail")))
        meta_line = "  ·  ".join(meta_bits)
        meta_h = _text_size(draw, meta_line or "测", font_meta)[1]
        title_h = sum(_text_size(draw, ln or " ", font_body)[1] + 3 for ln in title_lines)
        row_h = row_pad_y * 2 + title_h + 6 + meta_h

        fill = row_bg_cur if is_current else row_bg
        outline = accent if is_current else border
        _draw_rounded_rect(
            draw,
            (pad, y, width - pad, y + row_h),
            radius=8,
            fill=fill,
            outline=outline,
            width=2 if is_current else 1,
        )
        if is_current:
            draw.rectangle((pad + 2, y + 6, pad + 6, y + row_h - 6), fill=accent)

        # 序号块
        idx_txt = str(idx) if idx else "-"
        iw, ih = _text_size(draw, idx_txt, font_idx)
        ix = pad + row_pad_x + (idx_box_w - iw) // 2
        iy = y + row_pad_y
        _draw_rounded_rect(
            draw,
            (pad + row_pad_x, y + row_pad_y - 2, pad + row_pad_x + idx_box_w, y + row_pad_y + ih + 8),
            radius=6,
            fill=_mix_rgb(fill, accent, 0.22 if is_current else 0.12),
            outline=None,
        )
        draw.text((ix, iy + 2), idx_txt, font=font_idx, fill=accent if is_current else sub_fg)

        tx = pad + row_pad_x + idx_box_w + 12
        ty = y + row_pad_y
        for line in title_lines:
            draw.text((tx, ty), line, font=font_body, fill=fg)
            ty += _text_size(draw, line or " ", font_body)[1] + 3

        # 状态色点 + meta（meta 用更深的 sub_fg）
        sc = _status_color(status_key, accent, muted, fg)
        my = ty + 3
        dot_r = 4
        draw.ellipse((tx, my + meta_h // 2 - dot_r, tx + dot_r * 2, my + meta_h // 2 + dot_r), fill=sc)
        draw.text((tx + 14, my), meta_line, font=font_meta, fill=sub_fg)

        # 右上角 sid
        if sid:
            sw, sh = _text_size(draw, sid, font_meta)
            draw.text((width - pad - row_pad_x - sw, y + row_pad_y), sid, font=font_meta, fill=sub_fg)

        y += row_h + row_gap

    if footer:
        y += 8
        draw.line((pad, y, width - pad, y), fill=border, width=1)
        y += 12
        for line in _wrap_text(draw, footer, font_foot, content_w):
            draw.text((pad, y), line, font=font_foot, fill=accent)
            y += _text_size(draw, line or " ", font_foot)[1] + 2

    if style.show_brand:
        brand = "hapi connector"
        bw, bh = _text_size(draw, brand, font_foot)
        draw.text(
            (width - pad - bw, height - pad - bh), brand, font=font_foot, fill=sub_fg
        )

    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=True)
    return buf.getvalue(), width, height


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

    def _row_head(row: dict) -> str:
        rtype = str(row.get("type") or "row")
        label = str(row.get("label") or "")
        detail = str(row.get("detail") or "")
        if rtype == "section":
            if detail:
                return f"{label}  ·  {detail}" if not str(detail).startswith("(") else f"{label} {detail}"
            return label
        idx = row.get("index") or 0
        if idx:
            return f"{idx}.  {label}"
        return label

    for row in rows:
        rtype = str(row.get("type") or "row")
        head = _row_head(row)
        detail = str(row.get("detail") or "")
        f_head = font_body if rtype != "section" else font_sub
        for _ in _wrap_text(d0, head, f_head, content_w):
            y += _text_size(d0, "测", f_head)[1] + 2
        if detail and rtype != "section":
            for _ in _wrap_text(d0, detail, font_sub, content_w - 12):
                y += _text_size(d0, "测", font_sub)[1] + 2
        y += row_gap if rtype != "section" else (row_gap // 2)
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
    row_bg = _mix_rgb(bg, fg, 0.04)

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
        rtype = str(row.get("type") or "row")
        head = _row_head(row)
        detail = str(row.get("detail") or "")
        if rtype == "section":
            for line in _wrap_text(draw, head, font_sub, content_w):
                draw.text((pad, y), line, font=font_sub, fill=accent)
                y += _text_size(draw, line or " ", font_sub)[1] + 2
            y += row_gap // 2
            continue
        # 普通行：浅底条
        head_lines = _wrap_text(draw, head, font_body, content_w - 16)
        detail_lines = (
            _wrap_text(draw, detail, font_sub, content_w - 20) if detail else []
        )
        block_h = (
            10
            + sum(_text_size(draw, ln or " ", font_body)[1] + 2 for ln in head_lines)
            + sum(_text_size(draw, ln or " ", font_sub)[1] + 2 for ln in detail_lines)
        )
        _draw_rounded_rect(
            draw,
            (pad, y, width - pad, y + block_h),
            radius=6,
            fill=row_bg,
            outline=None,
        )
        yy = y + 6
        for line in head_lines:
            draw.text((pad + 10, yy), line, font=font_body, fill=fg)
            yy += _text_size(draw, line or " ", font_body)[1] + 2
        for line in detail_lines:
            draw.text((pad + 14, yy), line, font=font_sub, fill=muted)
            yy += _text_size(draw, line or " ", font_sub)[1] + 2
        y += block_h + row_gap

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
    """Pillow 对话卡：Markdown 子集；字号偏大、副文够深、无 emoji。"""
    scale = style.font_scale
    pad = style.padding
    width = style.width
    content_w = width - pad * 2
    line_extra = 4  # 行距

    # 手机聊天气泡里看：正文至少 ~16–18px 量级
    title_size = max(18, int(24 * scale))
    sub_size = max(13, int(15 * scale))
    body_size = max(15, int(17 * scale))
    code_size = max(13, int(14.5 * scale))
    h1_size = max(18, int(22 * scale))
    h2_size = max(16, int(19 * scale))
    foot_size = max(12, int(13 * scale))

    tmp = Image.new("RGB", (width, 100), _hex_to_rgb(style.bg))
    d0 = ImageDraw.Draw(tmp)

    # 标题/正文优先非等宽；代码等宽
    font_title = _load_font(title_size, False, style)
    font_sub = _load_font(sub_size, False, style)
    font_body = _load_font(body_size, False, style)
    font_code = _load_font(code_size, True, style)
    font_h1 = _load_font(h1_size, False, style)
    font_h2 = _load_font(h2_size, False, style)
    font_foot = _load_font(foot_size, False, style)

    title = str(data.get("title") or "Agent 消息")
    subtitle = str(data.get("subtitle") or "")
    body = str(data.get("body") or data.get("text") or "")
    footer = str(data.get("footer") or "")

    blocks = _parse_md_blocks(body)

    def measure_block(b) -> int:
        h = 0
        if b["type"] == "code":
            for line in _wrap_text(d0, b["text"], font_code, content_w - 24) or [""]:
                h += _text_size(d0, line or " ", font_code)[1] + line_extra
            return h + 24
        if b["type"] in ("h1", "h2", "h3"):
            f = font_h1 if b["type"] == "h1" else font_h2
            for line in _wrap_text(d0, b["text"], f, content_w):
                h += _text_size(d0, line or " ", f)[1] + line_extra
            return h + 12
        if b["type"] == "hr":
            return 18
        f = font_body
        prefix = ""
        if b["type"] == "li":
            prefix = "- "
        elif b["type"] == "quote":
            prefix = "| "
        text = prefix + b["text"]
        for line in _wrap_text(d0, text, f, content_w):
            h += _text_size(d0, line or " ", f)[1] + line_extra
        return h + 10

    y = pad
    y += _text_size(d0, title, font_title)[1] + 8
    if subtitle:
        for _ in _wrap_text(d0, subtitle, font_sub, content_w):
            y += _text_size(d0, "测", font_sub)[1] + line_extra
        y += 8
    y += 12  # bar
    for b in blocks:
        y += measure_block(b)
    if footer:
        y += 20
        for _ in _wrap_text(d0, footer, font_foot, content_w):
            y += _text_size(d0, "测", font_foot)[1] + line_extra
    if style.show_brand:
        y += 14 + _text_size(d0, "hapi", font_foot)[1]
    y += pad
    height = min(max(y, 160), 4500)

    bg = _hex_to_rgb(style.bg)
    fg = _hex_to_rgb(style.fg)
    accent = _hex_to_rgb(style.accent)
    muted = _hex_to_rgb(style.muted)
    # 副文再向正文靠一点，避免「发灰看不清」
    sub_fg = _mix_rgb(muted, fg, 0.35)
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
    y += _text_size(draw, title, font_title)[1] + 8
    if subtitle:
        for line in _wrap_text(draw, subtitle, font_sub, content_w):
            draw.text((pad, y), line, font=font_sub, fill=sub_fg)
            y += _text_size(draw, line or " ", font_sub)[1] + line_extra
        y += 8
    draw.rectangle((pad, y, pad + min(160, content_w // 3), y + 4), fill=accent)
    y += 14

    for b in blocks:
        if y > height - pad - 28:
            draw.text((pad, y), "...", font=font_body, fill=sub_fg)
            break
        if b["type"] == "code":
            lines = _wrap_text(draw, b["text"], font_code, content_w - 24) or [""]
            block_h = (
                sum(_text_size(draw, ln or " ", font_code)[1] + line_extra for ln in lines)
                + 20
            )
            _draw_rounded_rect(
                draw,
                (pad, y, width - pad, y + block_h),
                radius=8,
                fill=code_bg,
                outline=border,
                width=1,
            )
            yy = y + 10
            for line in lines:
                draw.text((pad + 12, yy), line, font=font_code, fill=fg)
                yy += _text_size(draw, line or " ", font_code)[1] + line_extra
            y += block_h + 12
            continue
        if b["type"] == "hr":
            draw.line((pad, y + 8, width - pad, y + 8), fill=border, width=1)
            y += 18
            continue
        if b["type"] in ("h1", "h2", "h3"):
            f = font_h1 if b["type"] == "h1" else font_h2
            for line in _wrap_text(draw, b["text"], f, content_w):
                draw.text((pad, y), line, font=f, fill=fg)
                y += _text_size(draw, line or " ", f)[1] + line_extra
            y += 10
            continue
        prefix = ""
        xoff = 0
        color = fg
        if b["type"] == "li":
            prefix = "- "
        elif b["type"] == "quote":
            prefix = ""
            color = sub_fg
            # 左侧强调条，高度按内容估
            q_lines = _wrap_text(draw, b["text"], font_body, content_w - 16) or [""]
            q_h = sum(
                _text_size(draw, ln or " ", font_body)[1] + line_extra for ln in q_lines
            )
            draw.rectangle((pad, y, pad + 4, y + max(q_h, 18)), fill=accent)
            xoff = 14
            for line in q_lines:
                draw.text((pad + xoff, y), line, font=font_body, fill=color)
                y += _text_size(draw, line or " ", font_body)[1] + line_extra
            y += 8
            continue
        text = prefix + b["text"]
        for line in _wrap_text(draw, text, font_body, content_w - xoff):
            draw.text((pad + xoff, y), line, font=font_body, fill=color)
            y += _text_size(draw, line or " ", font_body)[1] + line_extra
        y += 8

    if footer and y < height - pad:
        draw.line((pad, y + 6, width - pad, y + 6), fill=border, width=1)
        y += 14
        for line in _wrap_text(draw, footer, font_foot, content_w):
            draw.text((pad, y), line, font=font_foot, fill=accent)
            y += _text_size(draw, line or " ", font_foot)[1] + line_extra

    if style.show_brand:
        brand = "hapi connector"
        bw, bh = _text_size(draw, brand, font_foot)
        draw.text(
            (width - pad - bw, height - pad - bh), brand, font=font_foot, fill=sub_fg
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
