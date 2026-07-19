#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
compress-skin-assets.py — 皮肤图片压缩管线

对皮肤目录里的图片做三件事：
  1. 正式版：统一转成有损 WebP（q85，保留原尺寸），写回原目录
  2. 预览版：长边 768px、q75，写到 assets/skin-previews/，供大模型查看（避免上下文超 2MB）
  3. 原图备份到 assets/skin-originals/，并同步更新 manifest.json 的扩展名

已是有损 WebP 的文件自动跳过（--force 强制重压）；压缩后反而更大的保留原样。
生图工具经常把 WebP 数据存成 .png 后缀，本脚本按内容识别，不受后缀影响。

用法：
  python scripts/compress-skin-assets.py [--skin 目录] [--force]
  本机没有 Pillow 时，用 Codex 内置 Python 跑：
  %USERPROFILE%/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe scripts/compress-skin-assets.py
"""
import argparse
import os
import shutil
import sys
import time
from pathlib import Path

try:
    from PIL import Image
except ImportError:
    sys.exit("需要 Pillow：pip install pillow，或使用 Codex 内置 Python（见文件头注释）")

REPO = Path(__file__).resolve().parent.parent
DEFAULT_SKIN = REPO / "packages" / "client" / "public" / "assets" / "skins" / "default"
IMG_EXT = {".png", ".jpg", ".jpeg", ".webp"}
PROD_Q = 85      # 正式版质量
PREV_Q = 75      # 预览版质量
PREV_EDGE = 768  # 预览版长边像素


def webp_chunk(path: Path) -> str:
    """WebP 的 chunk 类型（VP8L=无损, VP8 =有损, VP8X=扩展）；非 WebP 返回空串"""
    try:
        head = path.read_bytes()[:16]
    except OSError:
        return ""
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return head[12:16].decode("ascii", "replace")
    return ""


def remove_retry(path: Path, tries: int = 6) -> bool:
    """Windows 上文件可能被杀软/索引短暂占用，重试删除"""
    for _ in range(tries):
        try:
            path.unlink()
            return True
        except PermissionError:
            time.sleep(0.5)
    return False


def main() -> None:
    ap = argparse.ArgumentParser(description="压缩皮肤图片为 WebP 并生成预览")
    ap.add_argument("--skin", default=str(DEFAULT_SKIN), help="皮肤目录")
    ap.add_argument("--force", action="store_true", help="强制重压缩所有图片")
    args = ap.parse_args()

    skin = Path(args.skin)
    backup_root = REPO / "assets" / "skin-originals"
    preview_root = REPO / "assets" / "skin-previews"
    manifest_path = skin / "manifest.json"
    manifest = manifest_path.read_text(encoding="utf-8") if manifest_path.exists() else ""
    manifest_dirty = False

    processed = kept = failed = 0
    total_before = total_after = 0

    for src in sorted(skin.rglob("*")):
        if not src.is_file() or src.suffix.lower() not in IMG_EXT:
            continue
        if src.suffix.lower() == ".webp" and not args.force and webp_chunk(src) != "VP8L":
            continue  # 已是有损 WebP，不重复有损压缩

        rel = src.relative_to(skin)
        out = rel.with_suffix(".webp")
        out_path = skin / out
        bak_path = backup_root / rel
        prev_path = preview_root / out
        bak_path.parent.mkdir(parents=True, exist_ok=True)
        prev_path.parent.mkdir(parents=True, exist_ok=True)

        before = src.stat().st_size
        try:
            im = Image.open(src)
            im.load()
        except Exception as exc:
            print(f"跳过 {rel}（无法解码：{exc}）")
            failed += 1
            continue

        tmp_path = out_path.with_name(out_path.name + ".tmp")
        im.save(tmp_path, "WEBP", quality=PROD_Q, method=6)
        pim = im.copy()
        pim.thumbnail((PREV_EDGE, PREV_EDGE), Image.LANCZOS)
        pim.save(prev_path, "WEBP", quality=PREV_Q, method=6)
        im.close()
        pim.close()

        after = tmp_path.stat().st_size
        if after >= before and not args.force:
            tmp_path.unlink()
            print(f"保留 {rel}（{before // 1024}KB，压缩无收益）")
            kept += 1
            continue

        shutil.copy2(src, bak_path)   # 先备份原图
        os.replace(tmp_path, out_path)  # 再换上压缩版
        if src != out_path and src.exists() and not remove_retry(src):
            print(f"警告：原文件被占用，未能删除 {src}")

        old_ref = f'"{rel.as_posix()}"'
        new_ref = f'"{out.as_posix()}"'
        if old_ref != new_ref and old_ref in manifest:
            manifest = manifest.replace(old_ref, new_ref)
            manifest_dirty = True

        processed += 1
        total_before += before
        total_after += after
        print(f"{rel}: {before // 1024}KB -> {after // 1024}KB（预览 {prev_path.stat().st_size // 1024}KB）")

    if manifest_dirty:
        manifest_path.write_text(manifest, encoding="utf-8")
        print("manifest.json 已同步更新")

    print(f"\n完成：处理 {processed}，保留 {kept}，失败 {failed}；"
          f"正式版合计 {total_before // 1024}KB -> {total_after // 1024}KB")
    print(f"预览图目录：{preview_root}（模型看图用这个，避免上下文超限）")


if __name__ == "__main__":
    main()