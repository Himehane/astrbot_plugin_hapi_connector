"""可移植 CJK 字体解析（不自动下载、不往插件里塞大字体）。

原则：
1. 插件体积保持轻量——**不**在运行时强行下载字体到缓存。
2. 解析顺序（显式 > 随包 > 环境兜底）：
   a. 配置 `card_font_path`（用户指定的 ttf/otf/ttc）
   b. 插件目录 `assets/fonts/*`（发布者可选放入，默认只有 README）
   c. 常见系统路径（各 OS 若已装 Noto / 雅黑 / PingFang 等则用，没有就跳过）
3. 全部找不到时返回 None / 抛错，调用方**回退纯文本**，绝不出方块字。
"""

from __future__ import annotations

import os
from functools import lru_cache
from pathlib import Path
from typing import Any

try:
    from astrbot.api import logger
except ImportError:  # pragma: no cover
    import logging

    logger = logging.getLogger("hapi_connector.font_manager")

_PLUGIN_ROOT = Path(__file__).resolve().parent
_BUNDLED_DIR = _PLUGIN_ROOT / "assets" / "fonts"

# 系统兜底：有就用，没有跳过。不是「依赖开发者本机」，而是「用户机器上若系统已装则免费用」。
_SYSTEM_SANS = (
    # Linux（发行版包常见路径）
    "/usr/share/fonts/google-noto-sans-cjk-vf-fonts/NotoSansCJK-VF.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/truetype/noto/NotoSansSC-Regular.otf",
    "/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/google-droid-sans-fonts/DroidSansFallbackFull.ttf",
    "/usr/share/fonts/wqy-zenhei-fonts/wqy-zenhei.ttc",
    "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc",
    "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",
    "/usr/share/fonts/truetype/arphic/uming.ttc",
    # macOS
    "/System/Library/Fonts/PingFang.ttc",
    "/System/Library/Fonts/STHeiti Light.ttc",
    "/System/Library/Fonts/Hiragino Sans GB.ttc",
    "/Library/Fonts/Arial Unicode.ttf",
    # Windows
    "C:\\Windows\\Fonts\\msyh.ttc",
    "C:\\Windows\\Fonts\\msyh.ttf",
    "C:\\Windows\\Fonts\\msyhbd.ttc",
    "C:\\Windows\\Fonts\\simhei.ttf",
    "C:\\Windows\\Fonts\\simsun.ttc",
    "C:\\Windows\\Fonts\\Deng.ttf",
)

_SYSTEM_MONO = (
    "/usr/share/fonts/google-noto-sans-mono-cjk-vf-fonts/NotoSansMonoCJK-VF.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansMonoCJK-Regular.ttc",
    "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
    "/usr/share/fonts/TTF/DejaVuSansMono.ttf",
    "C:\\Windows\\Fonts\\consola.ttf",
    "/System/Library/Fonts/Menlo.ttc",
)


def bundled_dir() -> Path:
    return _BUNDLED_DIR


def plugin_root() -> Path:
    return _PLUGIN_ROOT


def resolve_user_font(path_raw: str | None) -> Path | None:
    if not path_raw:
        return None
    s = str(path_raw).strip()
    if not s:
        return None
    p = Path(s).expanduser()
    if not p.is_absolute():
        p = (_PLUGIN_ROOT / p).resolve()
    if p.is_file() and p.stat().st_size > 1024:
        return p
    return None


def _first_existing(paths: list[Path | str]) -> Path | None:
    for raw in paths:
        p = Path(raw)
        try:
            if p.is_file() and p.stat().st_size > 1024:
                return p
        except OSError:
            continue
    return None


def _scan_dir(directory: Path, prefer_mono: bool) -> Path | None:
    if not directory.is_dir():
        return None
    try:
        names = sorted(directory.iterdir(), key=lambda p: p.name.lower())
    except OSError:
        return None
    mono_hit = None
    sans_hit = None
    any_hit = None
    for p in names:
        if not p.is_file():
            continue
        if p.suffix.lower() not in (".ttf", ".otf", ".ttc", ".otc"):
            continue
        try:
            if p.stat().st_size <= 1024:
                continue
        except OSError:
            continue
        low = p.name.lower()
        any_hit = any_hit or p
        if "mono" in low or "code" in low:
            mono_hit = mono_hit or p
        if any(
            k in low
            for k in (
                "cjk",
                "sc",
                "cn",
                "noto",
                "sourcehan",
                "wqy",
                "droid",
                "yahei",
                "pingfang",
                "heiti",
                "simhei",
                "simsun",
            )
        ):
            sans_hit = sans_hit or p
    if prefer_mono:
        return mono_hit or sans_hit or any_hit
    return sans_hit or mono_hit or any_hit


def resolve_font_path(
    *,
    mono: bool = False,
    user_path: str | None = None,
    allow_download: bool = False,  # 保留参数兼容旧调用；**忽略**，永不自动下载
) -> Path | None:
    path, _src = resolve_font_path_with_source(
        mono=mono, user_path=user_path, allow_download=allow_download
    )
    return path


def resolve_font_path_with_source(
    *,
    mono: bool = False,
    user_path: str | None = None,
    allow_download: bool = False,
) -> tuple[Path | None, str | None]:
    """返回 (path, source)。source: user | bundled | system | None。"""
    _ = allow_download

    user = resolve_user_font(user_path)
    if user is not None:
        return user, "user"

    hit = _scan_dir(_BUNDLED_DIR, prefer_mono=mono)
    if hit is not None:
        return hit, "bundled"

    if mono:
        m = _first_existing(list(_SYSTEM_MONO))
        if m is not None:
            return m, "system"
        s = _first_existing(list(_SYSTEM_SANS))
        return (s, "system") if s is not None else (None, None)

    s = _first_existing(list(_SYSTEM_SANS))
    return (s, "system") if s is not None else (None, None)


def ensure_default_fonts(*, allow_download: bool = False) -> dict[str, Any]:
    """探测可用字体状态（不下载）。"""
    _ = allow_download
    sans = (
        _scan_dir(_BUNDLED_DIR, prefer_mono=False)
        or _first_existing(list(_SYSTEM_SANS))
    )
    mono = (
        _scan_dir(_BUNDLED_DIR, prefer_mono=True)
        or _first_existing(list(_SYSTEM_MONO))
        or sans
    )
    status: dict[str, Any] = {
        "bundled_dir": str(_BUNDLED_DIR),
        "sans": str(sans) if sans else None,
        "mono": str(mono) if mono else None,
        "downloaded": False,
        "auto_download": False,
        "error": None,
    }
    if sans is None:
        status["error"] = (
            "未找到可用中文字体。"
            f"请将 NotoSansSC-Regular.otf（或其它 CJK 字体）放到 {_BUNDLED_DIR}，"
            "或在配置中设置 card_font_path。"
            "未配置时出卡会回退纯文本，避免方块字。"
        )
    return status


@lru_cache(maxsize=32)
def _load_truetype(path_str: str, size: int, index: int):
    from PIL import ImageFont  # type: ignore

    return ImageFont.truetype(path_str, size=size, index=index)


def load_image_font(
    size: int,
    *,
    mono: bool = False,
    user_path: str | None = None,
    allow_download: bool = False,
):
    """加载 Pillow ImageFont；失败抛 RuntimeError（含修复提示）。"""
    try:
        from PIL import ImageFont  # type: ignore
    except ImportError as e:
        raise RuntimeError("未安装 Pillow") from e

    path = resolve_font_path(
        mono=mono, user_path=user_path, allow_download=False
    )
    if path is None:
        # 等宽找不到时再试非等宽 CJK，至少保证中文
        if mono:
            path = resolve_font_path(
                mono=False, user_path=user_path, allow_download=False
            )
    if path is None:
        st = ensure_default_fonts()
        raise RuntimeError(st.get("error") or "无可用字体")

    last_err: Exception | None = None
    for idx in (0, 1, 2, 3, 4):
        try:
            return _load_truetype(str(path), int(size), idx)
        except Exception as e:
            last_err = e
            if path.suffix.lower() not in (".ttc", ".otc"):
                break
    raise RuntimeError(f"无法加载字体 {path}: {last_err}")


def _source_label(src: str | None) -> str:
    return {
        "user": "配置路径",
        "bundled": "插件 assets/fonts",
        "system": "系统字体",
    }.get(src or "", "未找到")


def font_status(
    *, user_path: str | None = None, allow_download: bool = False
) -> dict[str, Any]:
    """WebUI / meta 用：路径 + 来源，方便面板展示「当前用了哪套字体」。"""
    _ = allow_download
    sans_path, sans_src = resolve_font_path_with_source(
        mono=False, user_path=user_path
    )
    mono_path, mono_src = resolve_font_path_with_source(
        mono=True, user_path=user_path
    )
    # mono 找不到时 load 会回落 sans；状态里也体现这一点
    if mono_path is None and sans_path is not None:
        mono_path, mono_src = sans_path, sans_src

    user = resolve_user_font(user_path)
    ok = sans_path is not None
    return {
        "ok": ok,
        "bundled_dir": str(_BUNDLED_DIR),
        "sans": str(sans_path) if sans_path else None,
        "sans_name": sans_path.name if sans_path else None,
        "sans_source": sans_src,
        "sans_source_label": _source_label(sans_src),
        "mono": str(mono_path) if mono_path else None,
        "mono_name": mono_path.name if mono_path else None,
        "mono_source": mono_src,
        "mono_source_label": _source_label(mono_src),
        "user_font": str(user) if user else None,
        "user_font_name": user.name if user else None,
        "active_label": (
            f"{_source_label(sans_src)} · {sans_path.name}" if sans_path else "未找到中文字体"
        ),
        "downloaded": False,
        "auto_download": False,
        "error": None
        if ok
        else (
            "未找到可用中文字体。"
            f"请将字体放到 {_BUNDLED_DIR}，或配置 card_font_path。"
            "未配置时出卡会回退纯文本。"
        ),
        "hint": (
            f"解析顺序：card_font_path → {_BUNDLED_DIR} → 系统 CJK。"
            "不会自动下载。"
        ),
    }


def clear_font_cache_meta() -> None:
    _load_truetype.cache_clear()


# ──── 可选：用户显式安装到插件目录（非自动） ────

# 仅 Noto Sans SC 一份，足够画中文；不塞 16MB mono
_FONT_PACK = {
    "id": "noto_sans_sc",
    "label": "中文字体 Noto Sans SC",
    "filename": "NotoSansSC-Regular.otf",
    "approx_mb": 8,
    "license": "SIL OFL",
    "urls": [
        "https://cdn.jsdelivr.net/gh/googlefonts/noto-cjk@main/Sans/OTF/SimplifiedChinese/NotoSansSC-Regular.otf",
        "https://github.com/googlefonts/noto-cjk/raw/main/Sans/OTF/SimplifiedChinese/NotoSansSC-Regular.otf",
    ],
    "min_bytes": 1_000_000,
}


def installable_items() -> list[dict[str, Any]]:
    """WebUI 勾选项：字体 + Pillow（均可单独选）。不含 Chromium。"""
    bundled = _scan_dir(_BUNDLED_DIR, prefer_mono=False)
    font_path = _BUNDLED_DIR / _FONT_PACK["filename"]
    font_present = font_path.is_file() and font_path.stat().st_size >= _FONT_PACK["min_bytes"]
    if not font_present and bundled is not None:
        font_present = True  # 目录里已有其它可用 CJK

    try:
        import PIL  # noqa: F401

        pillow_ok = True
        pillow_ver = getattr(PIL, "__version__", "?")
    except ImportError:
        pillow_ok = False
        pillow_ver = None

    return [
        {
            "id": "font_noto_sc",
            "group": "font",
            "label": _FONT_PACK["label"],
            "desc": f"下载到插件 assets/fonts/（约 {_FONT_PACK['approx_mb']}MB，{_FONT_PACK['license']}）",
            "target": str(_BUNDLED_DIR / _FONT_PACK["filename"]),
            "installed": font_present,
            "detail": str(bundled) if bundled else None,
        },
        {
            "id": "dep_pillow",
            "group": "dep",
            "label": "Pillow（出卡引擎）",
            "desc": "pip install Pillow — 低延迟出卡，不依赖浏览器",
            "target": "pip:Pillow",
            "installed": pillow_ok,
            "detail": f"v{pillow_ver}" if pillow_ok else None,
        },
    ]


def download_font_to_bundled(*, force: bool = False) -> dict[str, Any]:
    """用户勾选后：把 Noto Sans SC 下到 assets/fonts/。"""
    import urllib.request

    _BUNDLED_DIR.mkdir(parents=True, exist_ok=True)
    dest = _BUNDLED_DIR / _FONT_PACK["filename"]
    if dest.is_file() and dest.stat().st_size >= _FONT_PACK["min_bytes"] and not force:
        clear_font_cache_meta()
        return {
            "ok": True,
            "skipped": True,
            "path": str(dest),
            "bytes": dest.stat().st_size,
            "message": f"已存在 {dest.name}，跳过下载",
        }

    tmp = dest.with_suffix(dest.suffix + ".part")
    last_err: str | None = None
    for url in _FONT_PACK["urls"]:
        try:
            logger.info("用户请求下载字体: %s → %s", url, dest)
            req = urllib.request.Request(
                url,
                headers={"User-Agent": "astrbot-plugin-hapi-connector/font-install"},
            )
            with urllib.request.urlopen(req, timeout=180) as resp:
                data = resp.read()
            if len(data) < int(_FONT_PACK["min_bytes"]):
                last_err = f"体积异常 {len(data)} B from {url}"
                continue
            tmp.write_bytes(data)
            tmp.replace(dest)
            clear_font_cache_meta()
            return {
                "ok": True,
                "skipped": False,
                "path": str(dest),
                "bytes": dest.stat().st_size,
                "message": f"已下载到 {dest}",
            }
        except Exception as e:
            last_err = str(e)
            logger.warning("字体下载失败 (%s): %s", url, e)
            try:
                if tmp.exists():
                    tmp.unlink()
            except OSError:
                pass
    return {
        "ok": False,
        "skipped": False,
        "path": str(dest),
        "error": last_err or "下载失败",
        "message": f"字体下载失败: {last_err}",
    }


def install_pip_package(spec: str) -> dict[str, Any]:
    """用户勾选后：pip install 指定包。"""
    import subprocess
    import sys

    cmd = [sys.executable, "-m", "pip", "install", "--upgrade", spec]
    try:
        proc = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=300,
            check=False,
        )
        out = (proc.stdout or "")[-2000:]
        err = (proc.stderr or "")[-2000:]
        ok = proc.returncode == 0
        return {
            "ok": ok,
            "cmd": " ".join(cmd),
            "returncode": proc.returncode,
            "stdout_tail": out,
            "stderr_tail": err,
            "message": f"{'已安装' if ok else '安装失败'}: {spec}",
        }
    except Exception as e:
        return {
            "ok": False,
            "cmd": " ".join(cmd),
            "error": str(e),
            "message": f"pip 执行失败: {e}",
        }


def install_selected(ids: list[str], *, force_font: bool = False) -> dict[str, Any]:
    """按勾选 id 安装；可多选，逐项执行。"""
    wanted = [str(x).strip() for x in (ids or []) if str(x).strip()]
    allowed = {x["id"] for x in installable_items()}
    unknown = [x for x in wanted if x not in allowed]
    if unknown:
        return {
            "ok": False,
            "error": f"未知选项: {', '.join(unknown)}",
            "results": [],
        }
    if not wanted:
        return {"ok": False, "error": "未勾选任何项", "results": []}

    results: list[dict[str, Any]] = []
    for item_id in wanted:
        if item_id == "font_noto_sc":
            r = download_font_to_bundled(force=force_font)
            results.append({"id": item_id, **r})
        elif item_id == "dep_pillow":
            r = install_pip_package("Pillow>=10.0,<12")
            results.append({"id": item_id, **r})

    all_ok = all(r.get("ok") or r.get("skipped") for r in results)
    return {
        "ok": all_ok,
        "results": results,
        "items": installable_items(),
        "message": "所选项目已处理" if all_ok else "部分项目失败，见 results",
    }
