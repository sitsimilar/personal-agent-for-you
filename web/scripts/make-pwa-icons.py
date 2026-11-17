# -*- coding: utf-8 -*-
"""个人信息管家 · PWA 图标生成器（P1-9）
=====================================
产出 `web/public/icons/` 下四张 PNG（任意尺寸档 + maskable 档）与一张
`apple-touch-icon-180.png`（iOS「添加到主屏」用的图标，iOS 不读 manifest 的 icons）。

几何与配色**复用** `desktop/scripts/make-icon.py` 的品牌标 C「切分」：
靛蓝 #5B54D9 圆角方 + 一道渐细白色斜槽贯穿。区别只在依赖——
打包脚本用 numpy 做贝塞尔布点，这里只用 PIL（构建机不一定装 numpy），
贝塞尔与法线偏移在纯 Python 里算完再交给 `ImageDraw.polygon`。
改几何必须与 `make-icon.py` 同步（两处常量同源，见该文件注释）。

maskable 档为什么要单独出一份
------------------------------
Android 的 maskable 图标会被系统裁成圆形/水滴/方圆形，安全区只有中心 **80%**。
若直接复用「圆角方出血」版：圆角会被系统再裁一次，接缝处露毛边；且圆角本身白送一圈。
所以 maskable 档改成「整块实心品牌色铺满 + 不做圆角」，槽按同一比例满画——
两端渐细到 2.2，被裁掉的端头本就在安全区之外，怎么裁都干净。

用法
----
    python web/scripts/make-pwa-icons.py
"""
import math
import os

from PIL import Image, ImageDraw

# ---------------------------------------------------------------- 几何（viewBox 0 0 100 100）
VB = 100.0
BRAND = "#5B54D9"
RADIUS = 0.224  # 圆角 22.4%，与 make-icon.py 一致

# 与 make-icon.py 的 ICON_SLOT 完全一致（≥128px 用常规几何）
ICON_SLOT = dict(
    spine=(((-7.0, 92.0), (31.0, 80.0), (76.0, 44.0), (107.0, 18.0))),
    w0=7.8, w1=2.2,
)
# ≤32px 用 compact 几何（本脚本不产出 ≤32px，保留常量以便与源头对齐）
ICON_SLOT_C = dict(
    spine=(((-7.0, 90.0), (33.0, 78.0), (76.0, 45.0), (107.0, 22.0))),
    w0=11.0, w1=5.5,
)

OUT_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "public", "icons")

# 输出清单：文件名 -> (像素, 是否 maskable 版)
TARGETS = {
    "icon-192.png": (192, False),
    "icon-512.png": (512, False),
    "maskable-192.png": (192, True),
    "maskable-512.png": (512, True),
}
# iOS 只认 apple-touch-icon，且不读 manifest；180 是 Apple 官方推荐档
APPLE_ICON = ("apple-touch-icon-180.png", 180)


def _bezier(p0, c1, c2, p3, n=240):
    pts = []
    for i in range(n):
        t = i / (n - 1)
        mt = 1.0 - t
        x = (mt ** 3 * p0[0] + 3 * mt ** 2 * t * c1[0]
             + 3 * mt * t ** 2 * c2[0] + t ** 3 * p3[0])
        y = (mt ** 3 * p0[1] + 3 * mt ** 2 * t * c1[1]
             + 3 * mt * t ** 2 * c2[1] + t ** 3 * p3[1])
        pts.append((x, y))
    return pts


def _band(spine, w0, w1):
    """沿 spine 的渐窄带（法线对称），返回闭合多边形顶点。"""
    n = len(spine)
    left, right = [], []
    for i, p in enumerate(spine):
        prev = spine[max(0, i - 1)]
        nxt = spine[min(n - 1, i + 1)]
        dx, dy = nxt[0] - prev[0], nxt[1] - prev[1]
        length = math.hypot(dx, dy) or 1e-9
        nx, ny = -dy / length, dx / length
        w = (w0 + (w1 - w0) * (i / (n - 1))) / 2.0
        left.append((p[0] + nx * w, p[1] + ny * w))
        right.append((p[0] - nx * w, p[1] - ny * w))
    return left + right[::-1]


def _hex2rgba(h, a=255):
    h = h.lstrip("#")
    return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16), a)


def render(px, maskable=False):
    """px×px 的 RGBA 图标。maskable=True 时整块实心铺满（系统负责裁形）。"""
    ss = 6 if px >= 128 else 12           # 超采样倍数，抗锯齿靠它
    S = int(px * ss)

    if maskable:
        # 满出血实心方：不做圆角（圆角会被系统裁形再切一次，接缝会出毛边）。
        # 槽按同一比例满画——两端渐细到 2.2，被裁掉的部分本就在安全区外。
        canvas = Image.new("RGBA", (S, S), _hex2rgba(BRAND))
        cut = _slot_mask(S, S, 0, ss)
        white = Image.new("RGBA", (S, S), (255, 255, 255, 255))
        white.putalpha(cut)
        canvas.alpha_composite(white)
        return canvas.resize((px, px), Image.LANCZOS)

    canvas = Image.new("RGBA", (S, S), _hex2rgba(BRAND))
    mask = Image.new("L", (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, S - 1, S - 1], radius=RADIUS * S, fill=255)
    canvas.putalpha(mask)
    cut = _slot_mask(S, S, 0, ss)
    white = Image.new("RGBA", (S, S), (255, 255, 255, 255))
    white.putalpha(cut)
    canvas.alpha_composite(white)
    return canvas.resize((px, px), Image.LANCZOS)


def _slot_mask(S, size, offset, ss):
    """在 size×size 区域内按 viewBox 比例画渐细槽，返回 L 通道蒙版。"""
    k = size / VB
    slot = ICON_SLOT_C if S <= 32 * ss else ICON_SLOT
    spine = _bezier(*slot["spine"])
    poly = [(offset + x * k, offset + y * k) for x, y in _band(spine, slot["w0"], slot["w1"])]
    cut = Image.new("L", (S, S), 0)
    ImageDraw.Draw(cut).polygon(poly, fill=255)
    return cut


def make():
    os.makedirs(OUT_DIR, exist_ok=True)
    for name, (px, maskable) in TARGETS.items():
        path = os.path.join(OUT_DIR, name)
        render(px, maskable).save(path, "PNG", optimize=True)
        print(f"OK  {path}  ({os.path.getsize(path) // 1024 or 1} KB)")
    # apple-touch-icon 用满出血版（iOS 自己裁圆角，不做 maskable 留白）
    name, px = APPLE_ICON
    path = os.path.join(OUT_DIR, name)
    render(px).save(path, "PNG", optimize=True)
    print(f"OK  {path}  ({os.path.getsize(path) // 1024 or 1} KB)")


if __name__ == "__main__":
    make()
