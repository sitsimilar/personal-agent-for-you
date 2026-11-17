# -*- coding: utf-8 -*-
"""个人信息管家 · Android 图标 / 启动图生成器
==========================================
Android 要的资源和 PWA 完全不同，但**图形只有一个源头**：
`web/public/icons/icon-512.png`（由 `web/scripts/make-pwa-icons.py` 按品牌标
C「切分」的几何出图）。这里只做「缩放 + 排版」，不重画几何——否则两处贝塞尔
参数迟早会漂，桌面图标 / 主屏图标 / APK 图标会出现肉眼可见的差异。

产出四类资源：

1. **legacy 方形图标** `mipmap-*/ic_launcher.png`：48/72/96/144/192（mdpi→xxxhdpi）。
   Android 7.1 以下与部分启动器只认它。
2. **圆形图标** `mipmap-*/ic_launcher_round.png`：同尺寸，按圆形裁切。
3. **自适应图标前景** `mipmap-*/ic_launcher_foreground.png`：108dp 画布
   （mdpi=108 … xxxhdpi=432），内容缩到 **62%** 居中。Android 的自适应图标
   安全区是中心 66/108，缩到 62% 保证任何裁形（圆形/水滴/方圆形）都不切到槽口。
   背景层由 `values/ic_launcher_background.xml` 铺纯品牌色。
4. **启动图** `drawable*/splash.png`：按 Capacitor 模板的 11 个尺寸逐一出图，
   品牌色铺底 + 居中标识（短边 26%）。

用法（在 `mobile/` 下）：
    python scripts/make-android-icons.py
"""
import os

from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
MOBILE_DIR = os.path.dirname(HERE)
REPO_ROOT = os.path.dirname(MOBILE_DIR)
RES_DIR = os.path.join(MOBILE_DIR, "android", "app", "src", "main", "res")
SRC_ICON = os.path.join(REPO_ROOT, "web", "public", "icons", "icon-512.png")

BRAND = (0x5B, 0x54, 0xD9)  # 与 web/desktop 品牌色同源

# 密度 -> legacy 边长（dp 48 × 倍数）
LAUNCHER_SIZES = {
    "mdpi": 48,
    "hdpi": 72,
    "xhdpi": 96,
    "xxhdpi": 144,
    "xxxhdpi": 192,
}
# 密度 -> 自适应图标画布边长（108dp × 倍数）
FOREGROUND_SIZES = {
    "mdpi": 108,
    "hdpi": 162,
    "xhdpi": 216,
    "xxhdpi": 324,
    "xxxhdpi": 432,
}
# Capacitor 模板自带的启动图尺寸（横向/纵向各 5 档 + drawable 兜底）
SPLASH_SIZES = {
    "drawable/splash.png": (480, 320),
    "drawable-port-mdpi/splash.png": (320, 480),
    "drawable-port-hdpi/splash.png": (480, 800),
    "drawable-port-xhdpi/splash.png": (720, 1280),
    "drawable-port-xxhdpi/splash.png": (960, 1600),
    "drawable-port-xxxhdpi/splash.png": (1280, 1920),
    "drawable-land-mdpi/splash.png": (480, 320),
    "drawable-land-hdpi/splash.png": (800, 480),
    "drawable-land-xhdpi/splash.png": (1280, 720),
    "drawable-land-xxhdpi/splash.png": (1600, 960),
    "drawable-land-xxxhdpi/splash.png": (1920, 1280),
}

# 自适应前景的内容占比（安全区 66/108 ≈ 0.611，取 0.62 刚好用满且不越界）
FOREGROUND_SCALE = 0.62
# 启动图里标识占短边的比例
SPLASH_LOGO_RATIO = 0.26


def load_logo(size):
    """载入品牌标并缩放到 size×size（LANCZOS，保持 alpha）。"""
    with Image.open(SRC_ICON) as im:
        logo = im.convert("RGBA")
    return logo.resize((size, size), Image.LANCZOS)


def write_png(image, rel_path):
    path = os.path.join(RES_DIR, rel_path)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    image.save(path, "PNG", optimize=True)
    return path


def make_launcher_icons():
    made = []
    for density, px in LAUNCHER_SIZES.items():
        logo = load_logo(px)
        made.append(write_png(logo, f"mipmap-{density}/ic_launcher.png"))

        # 圆形图标：用超采样蒙版裁圆，边缘才不毛
        ss = 4
        big = logo.resize((px * ss, px * ss), Image.LANCZOS)
        mask = Image.new("L", (px * ss, px * ss), 0)
        ImageDraw.Draw(mask).ellipse([0, 0, px * ss - 1, px * ss - 1], fill=255)
        round_icon = Image.new("RGBA", (px * ss, px * ss), (0, 0, 0, 0))
        round_icon.paste(big, (0, 0), mask)
        round_icon = round_icon.resize((px, px), Image.LANCZOS)
        made.append(write_png(round_icon, f"mipmap-{density}/ic_launcher_round.png"))
    return made


def make_adaptive_foreground():
    made = []
    for density, canvas_px in FOREGROUND_SIZES.items():
        inner = max(1, int(round(canvas_px * FOREGROUND_SCALE)))
        canvas = Image.new("RGBA", (canvas_px, canvas_px), (0, 0, 0, 0))
        logo = load_logo(inner)
        offset = (canvas_px - inner) // 2
        canvas.alpha_composite(logo, (offset, offset))
        made.append(write_png(canvas, f"mipmap-{density}/ic_launcher_foreground.png"))
    return made


def make_splash():
    made = []
    for rel_path, (w, h) in SPLASH_SIZES.items():
        canvas = Image.new("RGB", (w, h), BRAND)
        logo_px = max(64, int(round(min(w, h) * SPLASH_LOGO_RATIO)))
        logo = load_logo(logo_px)
        canvas.paste(logo, ((w - logo_px) // 2, (h - logo_px) // 2), logo)
        made.append(write_png(canvas, rel_path))
    return made


def main():
    if not os.path.exists(SRC_ICON):
        raise SystemExit(
            f"缺少源图标 {SRC_ICON}\n先跑：python web/scripts/make-pwa-icons.py")
    files = make_launcher_icons() + make_adaptive_foreground() + make_splash()
    print(f"生成 {len(files)} 个资源文件：")
    for f in files:
        print("  -", os.path.relpath(f, RES_DIR).replace("\\", "/"))


if __name__ == "__main__":
    main()
