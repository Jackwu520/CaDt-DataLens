"""pack-desktop-wheel.py：把 docs/mcp-desktop/overlay 覆盖到上游基线 wheel 上，重新打出一个
本地版本号 wheel（0.8.9 → 0.8.9+p1），并重算 RECORD 校验。

为什么不用 python -m build：上游发布的是已构建 wheel（没有 pyproject / 源码树），
我们只做「替换若干 .py + 重算 RECORD」，zip 层操作足够且结果可复现。

用法（仓库根）：
    uv run python tools/pack-desktop-wheel.py
产物：docs/mcp-desktop/windows_mcp-0.8.9+p1-py3-none-any.whl
基线：docs/mcp-desktop/vendor/windows_mcp-0.8.9-py3-none-any.whl（上游原版，不允许改动）
"""

from __future__ import annotations

import base64
import hashlib
import os
import sys
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASE = os.path.join(ROOT, "docs", "mcp-desktop", "vendor", "windows_mcp-0.8.9-py3-none-any.whl")
OVERLAY = os.path.join(ROOT, "docs", "mcp-desktop", "overlay")
OUT = os.path.join(ROOT, "docs", "mcp-desktop", "windows_mcp-0.8.9+p3-py3-none-any.whl")
LOCAL_VERSION = "0.8.9+p3"


def overlay_files() -> dict[str, str]:
    """overlay 下的相对路径 → 本地绝对路径（相对路径即 wheel 内路径）。"""
    out: dict[str, str] = {}
    for dirpath, _dirnames, filenames in os.walk(OVERLAY):
        for name in filenames:
            if not name.endswith(".py"):
                continue
            full = os.path.join(dirpath, name)
            rel = os.path.relpath(full, OVERLAY).replace(os.sep, "/")
            out[rel] = full
    return out


def record_hash(data: bytes) -> str:
    digest = hashlib.sha256(data).digest()
    return "sha256=" + base64.urlsafe_b64encode(digest).decode("ascii").rstrip("=")


def main() -> int:
    if not os.path.isfile(BASE):
        print(f"缺少上游基线 wheel：{BASE}", file=sys.stderr)
        return 2
    patches = overlay_files()
    if not patches:
        print("overlay 为空，没什么可打包的", file=sys.stderr)
        return 2

    with zipfile.ZipFile(BASE) as base_zip:
        entries = [(info.filename, base_zip.read(info.filename)) for info in base_zip.infolist()]

    entry_map = {name: data for name, data in entries}
    dist_info = next(
        (name.split("/")[0] for name, _ in entries if name.endswith(".dist-info/METADATA")), None
    )
    if not dist_info:
        print("基线 wheel 里找不到 .dist-info", file=sys.stderr)
        return 3

    # 1) 覆盖打补丁的文件；overlay 里基线没有的路径视为**新增文件**（如 tools/find.py）
    added = False
    for rel, full in sorted(patches.items()):
        target = "windows_mcp/" + rel if not rel.startswith("windows_mcp/") else rel
        with open(full, "rb") as fh:
            data = fh.read()
        if target in entry_map:
            entry_map[target] = data
        else:
            added = True
            entry_map[target] = data
            print(f"新增文件：{target}")
    if not added:
        print("没有新增文件（只覆盖既有路径）")

    # 2) 版本号改成本地版本（wheel 文件名 + METADATA 的 Version 行）
    meta_name = f"{dist_info}/METADATA"
    metadata = entry_map[meta_name].decode("utf-8")
    metadata = "\n".join(
        f"Version: {LOCAL_VERSION}" if line.startswith("Version:") else line
        for line in metadata.split("\n")
    )
    entry_map[meta_name] = metadata.encode("utf-8")

    # 3) 重算 RECORD：除 RECORD 自身外每行 name,hash,size；RECORD 自己留空 hash/size
    record_lines: list[str] = []
    for name in sorted(entry_map):
        if name == f"{dist_info}/RECORD":
            continue
        data = entry_map[name]
        record_lines.append(f"{name},{record_hash(data)},{len(data)}")
    record_lines.append(f"{dist_info}/RECORD,,")
    entry_map[f"{dist_info}/RECORD"] = ("\n".join(record_lines) + "\n").encode("utf-8")

    # 4) 写产物：保持基线里的条目顺序，补上 overlay 新增但基线没有的条目
    order = [name for name, _ in entries]
    for name in entry_map:
        if name not in order:
            order.append(name)

    with zipfile.ZipFile(OUT, "w", zipfile.ZIP_DEFLATED) as out_zip:
        for name in order:
            info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            out_zip.writestr(info, entry_map[name])

    sha = hashlib.sha256(open(OUT, "rb").read()).hexdigest()
    print(f"已生成：{OUT}")
    print(f"覆盖文件 {len(patches)} 个：{', '.join(sorted(patches))}")
    print(f"版本：{LOCAL_VERSION}")
    print(f"SHA-256：{sha}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
