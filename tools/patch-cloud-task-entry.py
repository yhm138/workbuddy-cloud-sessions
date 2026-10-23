#!/usr/bin/env python3
"""把桌面端的 DesktopCloudTaskEntry 特性开关从「硬编码 false」改成 true。

⚠️ 不推荐使用，仅作逆向记录保留。
实测三处全开会让客户端启动即闪退：开关背后是一条打包时未联调的代码路径
（云端会话列表接口 / CloudTaskSearcher 都没实现），renderer 直接抛错。
改完必须能还原，否则客户端打不开 —— 先用 `--check` 确认有备份再动手。

原理
----
WorkBuddy 客户端在打包时把这个开关写死成 false：

    createProductFeatureHook({ featureKey: `DesktopCloudTaskEntry`, resolve: () => !1 })
    desktopCloudTaskEntryEnabled = () => !1
    desktopCloudTaskEntryEnabled: m = !1

所以账号配置、服务端灰度都改不动它，只能改 app.asar 里的这 3 处字面量。
`!1` 与 `!0` 等长，可以直接原地替换，asar header 的 offset/size 全部不变。
客户端未启用 EnableEmbeddedAsarIntegrityValidation（fuses 里查不到），所以不做签名校验。

用法
----
    python tools/patch-cloud-task-entry.py --check     # 只看现状
    python tools/patch-cloud-task-entry.py --apply     # 打补丁
    python tools/patch-cloud-task-entry.py --restore   # 用 app.asar.wbbak 还原

改完要「托盘 → 退出 WorkBuddy」再重开，renderer 才会重新加载。
"""

import argparse
import os
import shutil
import sys

RES = os.environ.get("WORKBUDDY_RESOURCES_PATH", r"D:\Software\WorkBuddy\resources")
ASAR = os.path.join(RES, "app.asar")
BAK = os.path.join(RES, "app.asar.wbbak")

# (说明, 原始字节, 打补丁后的字节) —— 全部等长
PATCHES = [
    (
        "renderer 特性 hook（主开关）",
        b"featureKey:`DesktopCloudTaskEntry`,resolve:()=>!1",
        b"featureKey:`DesktopCloudTaskEntry`,resolve:()=>!0",
    ),
    (
        "main 侧全局搜索/元数据快照",
        b"desktopCloudTaskEntryEnabled=()=>!1",
        b"desktopCloudTaskEntryEnabled=()=>!0",
    ),
    (
        "侧栏分组参数默认值",
        b"desktopCloudTaskEntryEnabled:m=!1",
        b"desktopCloudTaskEntryEnabled:m=!0",
    ),
]


def report(data):
    patched = 0
    for label, old, new in PATCHES:
        n_old, n_new = data.count(old), data.count(new)
        state = "已启用" if n_new and not n_old else ("未启用" if n_old else "未找到")
        if n_new:
            patched += 1
        print(f"  [{state}] {label}  old={n_old} new={n_new}")
    return patched


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--restore", action="store_true")
    a = ap.parse_args()

    if not os.path.isfile(ASAR):
        sys.exit(f"找不到 {ASAR}")

    if a.restore:
        if not os.path.isfile(BAK):
            sys.exit(f"找不到备份 {BAK}，无法还原")
        shutil.copy2(BAK, ASAR)
        print(f"已用备份还原：{BAK} -> {ASAR}")
        with open(ASAR, "rb") as f:
            report(f.read())
        return

    with open(ASAR, "rb") as f:
        data = f.read()

    print(f"asar: {ASAR}  ({len(data):,} bytes)")
    patched = report(data)

    if a.check or not a.apply:
        print("\n（--check 模式，未写入）")
        return

    if patched == len(PATCHES):
        print("\n三处都已启用，无需再改。")
        return

    new = data
    for label, old, newpat in PATCHES:
        if new.count(old) == 1:
            new = new.replace(old, newpat)
            print(f"  替换：{label}")
        elif new.count(newpat) == 1:
            print(f"  跳过（已是启用态）：{label}")
        else:
            sys.exit(f"❌ 命中数异常，已中止：{label}")

    assert len(new) == len(data), "长度变化，会破坏 asar header"

    with open(ASAR, "r+b") as f:
        f.seek(0)
        f.write(new)
        f.truncate(len(new))

    print("\n写入完成，校验：")
    with open(ASAR, "rb") as f:
        report(f.read())
    print("\n请「托盘右键 → 退出 WorkBuddy」后重新打开客户端。")


if __name__ == "__main__":
    main()
