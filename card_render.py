"""结构化推送卡片渲染（可选依赖）。

设计原则：
1. 默认不依赖 Pillow；未安装时 render 不可用，调用方回退纯文本。
2. 不做完整 Markdown / 浏览器排版；只渲固定结构卡（list/pending/status…）。
3. 公式预留 formula_mode 接口，首版仅标注能力，不强制引入 math 引擎。

可选安装：
    pip install Pillow
或：
    pip install -r requirements-render.txt
"""

from __future__ import annotations

import io
import time
from dataclasses import dataclass, field, asdict
from typing import Any

try:
    from astrbot.api import logger
except ImportError:  # pragma: no cover - 本地单测 / 无 AstrBot 环境
    import logging

    logger = logging.getLogger("hapi_connector.card_render")

# ──── 可选依赖 ────

try:
    from PIL import Image, ImageDraw, ImageFont  # type: ignore

    _HAS_PILLOW = True
except ImportError:  # pragma: no cover
    Image = ImageDraw = ImageFont = None  # type: ignore
    _HAS_PILLOW = False


RENDER_MODES = ("text", "auto", "card")
FORMULA_MODES = ("off", "detect", "always")
CARD_KINDS = (
    "session_list",
    "pending",
    "status",
    "permission",
    "routes",
)
DENSITY_OPTIONS = ("comfortable", "compact")
PRESET_IDS = ("terminal_light", "terminal_dark", "clean", "compact")

DEFAULT_KINDS = ("session_list", "pending", "status", "permission")


@dataclass
class CardStyle:
    """用户可调设计 token（非任意 CSS）。"""

    preset: str = "terminal_light"
    width: int = 720
    padding: int = 24
    radius: int = 12
    bg: str = "#faf8f2"
    fg: str = "#1c1914"
    accent: str = "#1a7f4b"
    muted: str = "#6b665a"
    border: str = "#d4cfc0"
    font_scale: float = 1.0
    mono: bool = True
    show_brand: bool = True
    density: str = "comfortable"

    def resolved(self) -> "CardStyle":
        """返回规范化后的样式副本（夹紧范围、合法 preset）。"""
        preset = self.preset if self.preset in PRESETS else "terminal_light"
        dens = self.density if self.density in DENSITY_OPTIONS else "comfortable"
        width = max(400, min(1200, int(self.width or 720)))
        scale = float(self.font_scale or 1.0)
        if scale > 3:
            scale = scale / 100.0
        scale = max(0.75, min(1.5, scale))
        return CardStyle(
            preset=preset,
            width=width,
            padding=max(8, min(48, int(self.padding or 24))),
            radius=max(0, min(24, int(self.radius or 12))),
            bg=self.bg or "#faf8f2",
            fg=self.fg or "#1c1914",
            accent=self.accent or "#1a7f4b",
            muted=self.muted or "#6b665a",
            border=self.border or "#d4cfc0",
            font_scale=scale,
            mono=bool(self.mono),
            show_brand=bool(self.show_brand),
            density=dens,
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


def pillow_available() -> bool:
    return _HAS_PILLOW


def engine_status() -> dict[str, Any]:
    return {
        "pillow": _HAS_PILLOW,
        "formula_engine": False,  # 首版未接 KaTeX/Typst
        "engines": {
            "card": "pillow" if _HAS_PILLOW else None,
            "formula": None,
        },
        "install_hint": None
        if _HAS_PILLOW
        else "pip install Pillow  # 或 pip install -r requirements-render.txt",
    }


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


def style_from_config(cfg: dict[str, Any] | None) -> CardStyle:
    """从插件 config / 请求 patch 构建 CardStyle。

    策略：先取 preset 底色，再用用户显式 card_* 覆盖。
    """
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

    width = _int("card_width", int(base["width"]), 400, 1200)
    mono = base.get("mono", True)
    if "card_mono" in cfg and cfg.get("card_mono") is not None:
        mono = bool(cfg.get("card_mono"))
    show_brand = base.get("show_brand", True)
    if "card_show_brand" in cfg and cfg.get("card_show_brand") is not None:
        show_brand = bool(cfg.get("card_show_brand"))

    return CardStyle(
        preset=preset,
        width=width,
        padding=16 if density == "compact" else int(base.get("padding", 24)),
        radius=int(base.get("radius", 12)),
        bg=_color("card_bg", str(base["bg"])),
        fg=_color("card_fg", str(base["fg"])),
        accent=_color("card_accent", str(base["accent"])),
        muted=str(base["muted"]),
        border=str(base["border"]),
        font_scale=_float_scale(
            cfg.get("card_font_scale", float(base.get("font_scale", 1.0)) * 100
            if isinstance(base.get("font_scale"), float)
            else base.get("font_scale", 1.0)),
            float(base.get("font_scale", 1.0)),
        ),
        mono=bool(mono),
        show_brand=bool(show_brand),
        density=density,
    )


def style_to_public(style: CardStyle) -> dict[str, Any]:
    d = asdict(style)
    return d


def sample_payload(kind: str) -> dict[str, Any]:
    """WebUI 预览用固定样例，不打 HAPI。"""
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
    # session_list
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
    # auto：结构类出卡
    return kind in CARD_KINDS


def render_card(
    kind: str,
    data: dict[str, Any] | None = None,
    style: CardStyle | None = None,
    *,
    formula_mode: str = "off",
) -> RenderResult:
    """渲一张结构卡为 PNG。Pillow 不可用时 ok=False。"""
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
            error="未安装 Pillow，无法生成卡片。可选：pip install Pillow",
            kind=kind,
            fallback_text=fallback,
        )

    try:
        png, w, h = _draw_card_png(kind, data, style, formula_mode=formula_mode)
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
        "engine": engine_status(),
        "formula_subset": {
            "supported": [],
            "planned": ["$inline$", "$$block$$"],
            "note": "首版卡片不含公式引擎；formula_mode 仅预留，开启后仍回退源码文本。",
        },
    }


# ──── 绘制实现 ────


def _hex_to_rgb(h: str) -> tuple[int, int, int]:
    s = h.lstrip("#")
    if len(s) == 3:
        s = "".join(c * 2 for c in s)
    return int(s[0:2], 16), int(s[2:4], 16), int(s[4:6], 16)


def _load_font(size: int, mono: bool):
    """尽量找系统字体；失败用默认位图字体。"""
    candidates = []
    if mono:
        candidates.extend(
            [
                "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
                "/usr/share/fonts/TTF/DejaVuSansMono.ttf",
                "/usr/share/fonts/truetype/liberation/LiberationMono-Regular.ttf",
                "/System/Library/Fonts/Menlo.ttc",
                "C:\\Windows\\Fonts\\consola.ttf",
            ]
        )
    candidates.extend(
        [
            "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
            "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
            "/usr/share/fonts/truetype/noto/NotoSansSC-Regular.otf",
            "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc",
            "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
            "/System/Library/Fonts/PingFang.ttc",
            "C:\\Windows\\Fonts\\msyh.ttc",
            "C:\\Windows\\Fonts\\simhei.ttf",
        ]
    )
    for path in candidates:
        try:
            return ImageFont.truetype(path, size=size)
        except Exception:
            continue
    return ImageFont.load_default()


def _text_size(draw, text: str, font) -> tuple[int, int]:
    bbox = draw.textbbox((0, 0), text, font=font)
    return bbox[2] - bbox[0], bbox[3] - bbox[1]


def _wrap_text(draw, text: str, font, max_width: int) -> list[str]:
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    lines: list[str] = []
    for para in text.split("\n"):
        if not para:
            lines.append("")
            continue
        # 按字符贪心（中英混排够用）
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


def _draw_card_png(
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

    # 临时 draw 量高度
    tmp = Image.new("RGB", (width, 100), _hex_to_rgb(style.bg))
    d0 = ImageDraw.Draw(tmp)
    font_title = _load_font(title_size, style.mono)
    font_sub = _load_font(sub_size, style.mono)
    font_body = _load_font(body_size, style.mono)
    font_foot = _load_font(foot_size, style.mono)

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
    y += 2  # accent bar
    y += line_gap

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
        y += 10
        y += _text_size(d0, "hapi", font_foot)[1]

    y += pad
    height = max(y, 120)

    bg = _hex_to_rgb(style.bg)
    fg = _hex_to_rgb(style.fg)
    accent = _hex_to_rgb(style.accent)
    muted = _hex_to_rgb(style.muted)
    border = _hex_to_rgb(style.border)

    img = Image.new("RGB", (width, height), bg)
    draw = ImageDraw.Draw(img)
    # 外框
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

    # accent bar
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
        # 顶部分隔线
        draw.line((pad, y, width - pad, y), fill=border, width=1)
        y += 8
        for line in _wrap_text(draw, footer, font_foot, content_w):
            draw.text((pad, y), line, font=font_foot, fill=accent)
            y += _text_size(draw, line or " ", font_foot)[1] + 2

    if style.show_brand:
        brand = "hapi connector"
        bw, bh = _text_size(draw, brand, font_foot)
        draw.text((width - pad - bw, height - pad - bh), brand, font=font_foot, fill=muted)

    # formula_mode 占位：不绘制，仅保证参数被使用以免 lint
    _ = formula_mode

    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=True)
    return buf.getvalue(), width, height


def config_defaults() -> dict[str, Any]:
    """与 _conf_schema 默认值对齐，供 mock / 文档。"""
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
    }
