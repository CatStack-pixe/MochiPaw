# Linux Wayland 输入

Wayland 下，MochiPaw 优先连接已安装的 `mochi-paw-inputd` 输入服务；服务不可用时，使用当前用户的设备读取权限直接通过 evdev 接收输入。DEB、RPM 和 AppImage 都支持直接 evdev。X11 保持原有输入后端。

支持键盘、鼠标按键和相对鼠标移动。Wayland 不提供全局绝对鼠标坐标，因此悬停隐藏保持禁用。应用不会自动修改设备权限，也不会自动将用户加入用户组。

## 使用与状态

1. 在当前用户的本地 Wayland 桌面启动应用。会话检查需要 systemd-logind 和 `loginctl`，并要求当前用户的桌面会话处于活动、已解锁状态。
2. 打开「偏好设置 → 通用设置 → Linux 输入」，查看「服务已就绪」或「evdev 已就绪」。窗口可见时状态每三秒刷新。
3. 未就绪时，查看状态下面的具体错误。后端会在解锁桌面、接回输入设备或修复权限后自动重试，也可以点击「重试」立即检查。整个图形界面保持以普通用户运行。

可在普通用户终端检查会话和设备；`eventN` 只是示例，需要换成实际设备编号：

```sh
loginctl list-sessions
loginctl show-session SESSION_ID -p Active -p Remote -p Type -p LockedHint -p User
ls -l /dev/input/by-id/
getfacl /dev/input/eventN
```

键盘和鼠标可能对应不同的 `eventN`，单个复合设备也可能提供多个节点。只授予实际需要的键盘或鼠标节点访问权限。应用显示已就绪时，若只有键盘或只有鼠标响应，也应检查另一个设备的读取权限。

## 当前用户的设备权限

直接 evdev 以只读方式打开设备。短期验证时，可以请管理员为当前用户和指定设备增加只读 ACL。`getfacl` / `setfacl` 通常由发行版的 `acl` 软件包提供。

先备份该设备现有 ACL，再为普通用户增加读取权限；以下命令在该用户自己的终端运行，管理员权限仅用于修改指定设备的 ACL：

```sh
getfacl -p /dev/input/eventN > mochi-input-device.acl
sudo setfacl -m "u:$(id -un):r--" /dev/input/eventN
```

回到应用点击「重试」。需要撤销时，在设备仍为原设备且 ACL 未被其他管理员或会话管理器修改的前提下恢复备份：

```sh
sudo setfacl --restore=mochi-input-device.acl
```

这类 ACL 可能在重启、重新插拔或会话权限更新后失效，设备编号也可能改变。长期使用优先采用发行版提供的会话设备权限机制，或由管理员配置只匹配指定设备和指定用户的规则。设备读取权限同时允许该用户的其他进程读取相应设备事件，请按实际需要分配。[ACL 命令说明](https://man7.org/linux/man-pages/man1/setfacl.1.html)

某些发行版使用 `input` 组控制设备访问。将用户加入该组是范围更大的可选配置：它通常授予该用户及其所有应用读取多种输入设备的权限，权限也未必随锁屏撤销。若管理员选择此方式，先确认设备所属组，再执行：

```sh
sudo usermod -aG input "$(id -un)"
```

完成后彻底注销并重新登录，再启动应用；仅在旧进程中点击「重试」不会刷新进程已继承的用户组。直接 evdev 的会话检查仍会在桌面锁定或切换用户时停止该应用的输入读取；回到已解锁的活动会话后自动恢复，并丢弃暂停期间的旧输入。

## 使用已安装的输入服务

DEB / RPM 安装包包含输入服务；AppImage 本身不安装服务，但可以连接本机已有的服务。使用普通用户启动图形界面，并单独检查服务：

```sh
systemctl status mochi-paw-inputd.service
journalctl -u mochi-paw-inputd.service -b
```

如果服务已经安装但未启用，管理员可以手动启用它，然后在应用中点击「重试」：

```sh
sudo systemctl enable --now mochi-paw-inputd.service
```

服务仅向通过本地会话校验的客户端转发标准化事件。服务连接失败时，直接 evdev 仍需要当前用户自己的设备权限。

## 常见状态

| 状态或错误                           | 处理方式                                                           |
| ------------------------------------ | ------------------------------------------------------------------ |
| X11 已就绪                           | 当前使用 X11 内置输入后端，无需配置 Wayland evdev。                |
| 服务已就绪                           | 已连接安装的输入服务。                                             |
| evdev 已就绪                         | 正在使用当前用户可读取的输入设备。                                 |
| Permission denied / 设备读取权限不足 | 为所需设备配置当前用户的读取权限；如变更了用户组，注销并重新登录。 |
| 会话未活动、已锁定或会话检查失败     | 返回当前用户的本地桌面并解锁；检查 `loginctl` 和 systemd-logind。  |
| 未发现可用输入设备                   | 检查设备连接及 `/dev/input/event*`，连接键盘或鼠标后重试。         |
| 服务连接失败                         | 检查已安装服务的状态；或为直接 evdev 配置设备读取权限。            |

AppImage 支持不会绕过系统设备权限。偏好设置保留后端返回的具体错误，可据此区分设备权限、会话状态和服务连接问题。
