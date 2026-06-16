# BongoCat Agent 快速索引

本文档面向后续 Agent，用于在最少上下文内理解项目结构、入口、常改模块和跨端调用关系。原用户向 README 内容已被替换为此 Agent 索引。

## 项目概览

BongoCat 是一个基于 Vue 3 + Vite + Tauri 2 的跨平台桌面宠物应用，主功能是加载 Live2D 猫咪模型，并根据键盘、鼠标、手柄输入驱动猫咪动作。前端负责界面、状态、Live2D 渲染、菜单和偏好设置；Rust/Tauri 侧负责系统级输入监听、窗口行为、插件注册和跨平台差异。

| 项目项 | 说明 |
| --- | --- |
| 前端技术栈 | Vue 3、TypeScript、Vite、Pinia、Vue Router、Vue I18n、UnoCSS、antdv-next |
| 桌面框架 | Tauri 2 |
| 渲染核心 | `easy-live2d` + `pixi.js` |
| 状态持久化 | `@tauri-store/pinia`，在 `src/main.ts` 中注册 |
| 默认路由 | `/` 主猫窗口，`/preference` 偏好设置窗口 |
| 默认分支 | `master` |
| 包管理器 | `pnpm`，`preinstall` 会强制 only-allow pnpm |

## 快速命令

| 目的 | 命令 | 备注 |
| --- | --- | --- |
| 安装依赖 | `pnpm install` | 不要使用 npm/yarn 安装依赖 |
| Web 开发 | `pnpm dev` | 会先执行 `scripts/buildIcon.ts`，再启动 Vite |
| Tauri 开发 | `pnpm tauri dev` | Tauri 配置的 `beforeDevCommand` 会调用 `pnpm dev` |
| 前端构建 | `pnpm build` | 顺序执行 `build:*`，包含图标和 Vite 构建 |
| Tauri 构建 | `pnpm tauri build` | 读取 `src-tauri/tauri.conf.json` |
| 预览前端 | `pnpm preview` | 预览 `dist` |
| 修复 lint | `pnpm lint` | 执行 `eslint --fix src` |
| 发布 | `pnpm release` | 使用 `release-it` |

## 目录速览

| 路径 | 作用 | 常见修改场景 |
| --- | --- | --- |
| `src/main.ts` | Vue 应用入口，注册 router、pinia、i18n、全局样式 | 新增全局插件、状态持久化调整 |
| `src/App.vue` | 应用壳层，初始化 stores，处理主题、语言、窗口显示/隐藏事件和外链打开 | 全局初始化、异常处理、主题语言联动 |
| `src/router/index.ts` | Hash 路由定义 | 新增页面或窗口路径 |
| `src/pages/main/index.vue` | 主猫窗口，加载 Live2D、监听设备事件、显示按键贴图、右键菜单、拖拽缩放 | 猫咪动作、主窗口交互、模型加载流程 |
| `src/pages/preference/index.vue` | 偏好设置窗口壳层和侧边菜单 | 新增设置分类、调整设置页导航 |
| `src/pages/preference/components/*` | 各偏好设置页 | 修改猫咪、通用、模型、快捷键、关于页 |
| `src/components/*` | 通用 UI 组件 | 复用列表、快捷键输入、更新弹窗 |
| `src/composables/*` | 组合式业务逻辑 | 输入监听、模型控制、托盘菜单、窗口状态、快捷键 |
| `src/stores/*` | Pinia 状态 | 新增持久化配置项、迁移旧配置 |
| `src/utils/*` | 工具函数和 Live2D 封装 | 路径、平台、键盘、屏幕、Live2D 操作 |
| `src/plugins/*` | 前端侧 Tauri 插件调用封装 | 窗口插件、管理员状态插件 |
| `src/locales/*` | 多语言文案 | 新增或修改翻译 key |
| `src-tauri/src/lib.rs` | Rust/Tauri 主构建入口，注册插件和 commands | 新增 Tauri command、插件、窗口事件 |
| `src-tauri/src/core/*` | Rust 核心功能，设备/手柄监听、平台 setup、防默认行为 | 系统输入监听、平台初始化 |
| `src-tauri/src/plugins/*` | 自定义 Tauri 插件 | 窗口控制、管理员权限检查 |
| `src-tauri/assets/models/*` | 内置 Live2D 模型和按键资源 | 新增预设模型、调整模型资源 |
| `src-tauri/tauri.conf.json` | Tauri 主配置 | 窗口、资源、打包、更新源、安全策略 |
| `scripts/*` | 构建/发布辅助脚本 | 图标生成、发布流程 |

## 运行链路

1. `src/main.ts` 创建 Vue app，并注册 `router`、`pinia`、`i18n`。
2. `src/App.vue` 在 `onMounted` 中启动并初始化 `app`、`model`、`cat`、`general`、`shortcut` stores，然后恢复窗口状态。
3. 路由 `/` 渲染 `src/pages/main/index.vue`，调用 `useDevice()` 启动 Rust 侧输入监听，并通过 `useModel()` 加载当前 Live2D 模型。
4. Rust 侧 `src-tauri/src/lib.rs` 注册 `start_device_listening`、`start_gamepad_listing`、`stop_gamepad_listing` 等 commands。
5. `src-tauri/src/core/device.rs` 和 `src-tauri/src/core/gamepad.rs` 监听系统输入后 emit 事件到前端。
6. 前端通过 `useTauriListen()` 接收 `device-changed`、`gamepad-changed` 等事件，再更新 `modelStore.pressedKeys` 或 Live2D 参数。
7. `src/pages/main/index.vue` 根据 `pressedKeys` 叠加按键贴图，并用 `live2d` 工具驱动模型动作、表情、参数。

## 前端模块引用表

| 模块 | 文件 | 主要导出/职责 | 依赖/引用重点 |
| --- | --- | --- | --- |
| 应用入口 | `src/main.ts` | 创建 app，注册 Pinia、Router、I18n、样式 | `@tauri-store/pinia` 会持久化 stores |
| 应用壳 | `src/App.vue` | 初始化 stores、主题语言联动、窗口显示隐藏、外链处理 | `LISTEN_KEY.SHOW_WINDOW`、`LISTEN_KEY.HIDE_WINDOW` |
| 路由 | `src/router/index.ts` | `/`、`/preference` | 使用 `createWebHashHistory()` |
| 主窗口页面 | `src/pages/main/index.vue` | Live2D canvas、按键贴图、右键菜单、拖拽/缩放、窗口可见性 | `useDevice`、`useGamepad`、`useModel`、`live2d` |
| 偏好页壳 | `src/pages/preference/index.vue` | 侧边菜单、设置页切换、更新弹窗 | `useTray()` 在此初始化托盘 |
| 猫咪设置 | `src/pages/preference/components/cat/index.vue` | 猫咪窗口、透明度、缩放、置顶、穿透等配置 | 主要写入 `useCatStore()` |
| 通用设置 | `src/pages/preference/components/general/index.vue` | 自启、任务栏、托盘、主题、语言、更新检查 | 主要写入 `useGeneralStore()` |
| 模型设置 | `src/pages/preference/components/model/index.vue` | 模型选择、导入、行为/表情配置 | 主要写入 `useModelStore()` |
| 快捷键设置 | `src/pages/preference/components/shortcut/index.vue` | 全局快捷键配置 | 主要写入 `useShortcutStore()` |
| 更新弹窗 | `src/components/update-app/index.vue` | 检查和展示更新 | 监听 `LISTEN_KEY.UPDATE_APP` |
| 菜单逻辑 | `src/composables/useAppMenu.ts` | 右键菜单/托盘菜单的基础项和退出项 | 被主窗口和托盘复用 |
| 设备输入 | `src/composables/useDevice.ts` | 调用 Rust 监听设备，处理键盘/鼠标事件、鼠标跟随、自动释放 | `INVOKE_KEY.START_DEVICE_LISTENING`、`LISTEN_KEY.DEVICE_CHANGED` |
| 手柄输入 | `src/composables/useGamepad.ts` | 根据模型模式启动/停止手柄监听，映射按钮和摇杆参数 | `INVOKE_KEY.START_GAMEPAD_LISTING`、`LISTEN_KEY.GAMEPAD_CHANGED` |
| 模型控制 | `src/composables/useModel.ts` | 加载模型、生成行为快捷键、处理按下/释放、鼠标参数、轴参数 | `src/utils/live2d.ts` |
| 快捷键绑定 | `src/composables/useKeyPress.ts` | 注册/注销 Tauri global-shortcut | 回调只在 Pressed 状态触发 |
| 托盘 | `src/composables/useTray.ts` | 创建托盘、刷新托盘菜单、检查更新入口 | 由偏好页初始化 |
| 窗口状态 | `src/composables/useWindowState.ts` | 保存/恢复窗口位置和尺寸 | 写入 `appStore.windowState` |
| Tauri 监听 | `src/composables/useTauriListen.ts` | 包装 Tauri event listen/unlisten | 用于组件卸载清理监听 |
| Live2D 封装 | `src/utils/live2d.ts` | 初始化 Pixi、加载模型、动作/表情/参数、FPS、声音 | `easy-live2d`、`pixi.js` |
| 窗口插件前端封装 | `src/plugins/window.ts` | show/hide、置顶、任务栏可见、按 label emit | 调用 `plugin:custom-window|*` commands |
| 常量 | `src/constants/index.ts` | GitHub 链接、事件名、invoke command 名、语言、窗口 label | 改事件名时必须同步 Rust emit 和前端监听 |

## Store 引用表

| Store | 文件 | 关键状态 | 初始化/迁移注意 |
| --- | --- | --- | --- |
| `useAppStore` | `src/stores/app.ts` | `name`、`version`、`windowState` | `init()` 从 Tauri app API 读取应用名和版本 |
| `useCatStore` | `src/stores/cat.ts` | `model`、`window` | 含旧字段迁移逻辑，新增字段优先放到 `model` 或 `window` 分组 |
| `useGeneralStore` | `src/stores/general.ts` | `app`、`appearance`、`update` | `init()` 会补默认语言并迁移旧字段 |
| `useModelStore` | `src/stores/model.ts` | `models`、`currentModel`、`supportKeys`、`pressedKeys`、`shortcuts` | `supportKeys`、`pressedKeys` 被 `tauri.filterKeys` 排除持久化 |
| `useShortcutStore` | `src/stores/shortcut.ts` | `visibleCat`、`visiblePreference`、`mirrorMode`、`penetrable`、`alwaysOnTop` | 新增全局快捷键时同步设置页和菜单逻辑 |

## Rust/Tauri 模块引用表

| 模块 | 文件 | 职责 | 前端对应 |
| --- | --- | --- | --- |
| Tauri 入口 | `src-tauri/src/main.rs` | 调用 `bongo_cat_lib::run()` | 无直接对应 |
| 应用构建 | `src-tauri/src/lib.rs` | setup、commands、plugins、窗口关闭行为、单实例处理 | `src/App.vue`、`src/plugins/*`、`src/composables/*` |
| 设备监听 | `src-tauri/src/core/device.rs` | 使用 `rdev` 监听键盘、鼠标，emit `device-changed` | `src/composables/useDevice.ts` |
| 手柄监听 | `src-tauri/src/core/gamepad.rs` | 使用 `gilrs` 监听按钮和轴，emit `gamepad-changed` | `src/composables/useGamepad.ts` |
| 平台 setup | `src-tauri/src/core/setup/mod.rs` | 选择并调用平台 setup | `src-tauri/src/core/setup/common.rs`、`macos.rs` |
| macOS setup | `src-tauri/src/core/setup/macos.rs` | 将主窗口转为 NSPanel、隐藏 Dock、转发窗口事件 | `useWindowState` 和窗口显示逻辑 |
| 防默认行为 | `src-tauri/src/core/prevent_default.rs` | 自定义 Tauri 插件，处理默认行为 | `src-tauri/src/lib.rs` 注册 |
| 文件工具 | `src-tauri/src/utils/fs_extra.rs` | command `copy_dir` | `INVOKE_KEY.COPY_DIR` |
| 自定义窗口插件 | `src-tauri/src/plugins/window/src/lib.rs` | 注册 `custom-window` commands | `src/plugins/window.ts` |
| 窗口命令分发 | `src-tauri/src/plugins/window/src/commands/mod.rs` | 定义 `main`/`preference` label，按平台导出命令 | `WINDOW_LABEL` |
| Windows 窗口命令 | `src-tauri/src/plugins/window/src/commands/windows.rs` | show/hide、强置顶循环、任务栏可见性 | `setAlwaysOnTop`、`setTaskbarVisibility` |
| macOS 窗口命令 | `src-tauri/src/plugins/window/src/commands/macos.rs` | NSPanel 显隐、层级、Dock 可见性 | `showWindow`、`hideWindow` |
| Linux 窗口命令 | `src-tauri/src/plugins/window/src/commands/linux.rs` | show/hide、置顶、任务栏可见性 | `setAlwaysOnTop`、`setTaskbarVisibility` |
| 管理员状态插件 | `src-tauri/src/plugins/admin-status/*` | 检测管理员权限/权限命令 | `src/plugins/adminStatus.ts` |

## 事件和命令映射

| 类型 | 名称 | 定义位置 | 发送/调用方 | 接收/实现方 | 用途 |
| --- | --- | --- | --- | --- | --- |
| Event | `show-window` | `src/constants/index.ts` | `src/plugins/window.ts` | `src/App.vue` | 按窗口 label 显示窗口 |
| Event | `hide-window` | `src/constants/index.ts` | `src/plugins/window.ts` | `src/App.vue` | 按窗口 label 隐藏窗口 |
| Event | `device-changed` | `src/constants/index.ts` / Rust 字符串 | `src-tauri/src/core/device.rs` | `src/composables/useDevice.ts` | 键盘、鼠标事件 |
| Event | `gamepad-changed` | `src/constants/index.ts` / Rust 字符串 | `src-tauri/src/core/gamepad.rs` | `src/composables/useGamepad.ts` | 手柄按钮和轴事件 |
| Event | `update-app` | `src/constants/index.ts` | `src/composables/useTray.ts` | `src/components/update-app/index.vue` | 打开/触发更新检查 |
| Event | `start-motion` | `src/constants/index.ts` | 模型行为 UI | `src/pages/main/index.vue` | 播放 Live2D motion |
| Event | `set-expression` | `src/constants/index.ts` | 模型行为 UI | `src/pages/main/index.vue` | 设置 Live2D expression |
| Invoke | `start_device_listening` | `src/constants/index.ts` / Rust command | `src/composables/useDevice.ts` | `src-tauri/src/core/device.rs` | 启动全局设备监听 |
| Invoke | `start_gamepad_listing` | `src/constants/index.ts` / Rust command | `src/composables/useGamepad.ts` | `src-tauri/src/core/gamepad.rs` | 启动手柄监听 |
| Invoke | `stop_gamepad_listing` | `src/constants/index.ts` / Rust command | `src/composables/useGamepad.ts` | `src-tauri/src/core/gamepad.rs` | 停止手柄监听 |
| Invoke | `copy_dir` | `src/constants/index.ts` / Rust command | 模型上传/导入相关 UI | `src-tauri/src/utils/fs_extra.rs` | 复制模型目录 |
| Plugin command | `plugin:custom-window|show_window` | `src/plugins/window.ts` | 前端窗口封装 | `src-tauri/src/plugins/window/src/commands/*` | 显示当前窗口 |
| Plugin command | `plugin:custom-window|hide_window` | `src/plugins/window.ts` | 前端窗口封装 | `src-tauri/src/plugins/window/src/commands/*` | 隐藏当前窗口 |
| Plugin command | `plugin:custom-window|set_always_on_top` | `src/plugins/window.ts` | 前端窗口封装 | `src-tauri/src/plugins/window/src/commands/*` | 设置置顶 |
| Plugin command | `plugin:custom-window|set_taskbar_visibility` | `src/plugins/window.ts` | 前端窗口封装 | `src-tauri/src/plugins/window/src/commands/*` | 设置任务栏/Dock 可见性 |

## 常见改动入口

| 需求 | 优先看这些文件 | 注意事项 |
| --- | --- | --- |
| 新增设置项 | `src/stores/*`、`src/pages/preference/components/*`、`src/locales/*` | store 新字段会自动持久化，注意旧字段迁移 |
| 修改猫咪主窗口行为 | `src/pages/main/index.vue`、`src/composables/useModel.ts`、`src/composables/useDevice.ts` | 不要绕过 `modelStore.pressedKeys`，否则按键贴图和手部状态可能不同步 |
| 修改模型加载逻辑 | `src/composables/useModel.ts`、`src/utils/live2d.ts`、`src/stores/model.ts` | 模型目录需包含 `.model3.json` |
| 新增预设模型 | `src-tauri/assets/models/*`、`src/stores/model.ts` | 模型模式目前为 `standard`、`keyboard`、`gamepad` |
| 修改键盘/鼠标监听 | `src-tauri/src/core/device.rs`、`src/composables/useDevice.ts` | Rust emit 的事件结构必须与 TS 类型一致 |
| 修改手柄监听 | `src-tauri/src/core/gamepad.rs`、`src/composables/useGamepad.ts` | 轴和按钮名称来自 `gilrs` 的 Debug 字符串 |
| 修改窗口置顶/穿透/任务栏 | `src/plugins/window.ts`、`src-tauri/src/plugins/window/src/commands/*`、`src/pages/main/index.vue` | 平台实现不同，macOS 主窗口使用 NSPanel |
| 修改托盘菜单 | `src/composables/useTray.ts`、`src/composables/useAppMenu.ts` | 托盘在偏好页中通过 `useTray()` 初始化 |
| 修改右键菜单 | `src/pages/main/index.vue`、`src/composables/useAppMenu.ts` | Windows 置顶时弹菜单会临时取消置顶 |
| 修改更新逻辑 | `src/components/update-app/index.vue`、`src-tauri/tauri.conf.json` | 更新 endpoint 在 Tauri 配置的 `plugins.updater.endpoints` |
| 新增窗口 | `src-tauri/tauri.conf.json`、`src/router/index.ts`、`src/constants/index.ts`、窗口插件 commands | 同步 label、路由 URL、show/hide 逻辑 |
| 新增 Tauri command | `src-tauri/src/lib.rs`、对应 Rust 模块、`src/constants/index.ts` | 需加入 `generate_handler![]` 并在前端 `invoke()` |
| 新增多语言 | `src/locales/*.json`、`src/locales/index.ts`、`src/constants/index.ts` | 所有语言文件尽量保持 key 完整 |

## 模型资源约定

| 资源 | 路径/命名 | 说明 |
| --- | --- | --- |
| 模型根目录 | `src-tauri/assets/models/{mode}` | `{mode}` 为 `standard`、`keyboard`、`gamepad` 或用户导入目录 |
| 模型配置 | `*.model3.json` | `src/utils/live2d.ts` 会在模型目录下查找第一个 `.model3.json` |
| 背景图 | `resources/background.png` | 主窗口会自动检测并作为背景显示 |
| 封面图 | `resources/cover.png` | 偏好页模型列表/上传相关组件使用 |
| 左手按键图 | `resources/left-keys/*.png` | 文件名去扩展名后作为支持的 key |
| 右手按键图 | `resources/right-keys/*.png` | 文件名去扩展名后作为支持的 key |
| 动作/表情 | 模型 JSON 及相关 motion/expression 文件 | `useModel()` 会读取 motions/expressions 并自动生成行为快捷键 |

## 配置文件索引

| 文件 | 用途 | 修改提示 |
| --- | --- | --- |
| `package.json` | 前端依赖、脚本、lint-staged、git hooks | 包管理器固定为 pnpm |
| `vite.config.ts` | Vite 构建配置 | 修改别名、插件、构建行为时查看 |
| `uno.config.ts` | UnoCSS 配置 | 图标和原子类样式相关 |
| `eslint.config.ts` | ESLint 配置 | 代码风格由 `@antfu/eslint-config` 管理 |
| `tsconfig.json` / `tsconfig.node.json` | TypeScript 配置 | 路径别名和类型检查 |
| `src-tauri/tauri.conf.json` | Tauri 主配置 | 窗口、资源、bundle、updater、安全策略 |
| `src-tauri/Cargo.toml` | Rust crate 依赖 | Tauri 插件和平台依赖 |
| `Cargo.toml` | Rust workspace 配置 | release profile、workspace dependencies |
| `.release-it.ts` | 发布配置 | release 流程相关 |
| `.github/workflows/*` | GitHub Actions | release、同步、升级链接相关 |

## Agent 协作注意

- 修改事件名、command 名、窗口 label 时，必须同步 `src/constants/index.ts`、前端调用点和 Rust emit/command 注册点。
- 修改持久化 store 字段时，优先保留旧字段迁移逻辑，避免老用户配置丢失。
- `supportKeys` 和 `pressedKeys` 是运行时状态，不应持久化；它们已在 `src/stores/model.ts` 的 `tauri.filterKeys` 中排除。
- 主窗口 `/` 是透明、无装饰、置顶的特殊窗口；偏好窗口 `/preference` 是常规设置窗口。
- macOS 主窗口使用 NSPanel，窗口行为不要只按普通 Tauri WebviewWindow 理解。
- Windows 的置顶逻辑使用循环 `SetWindowPos`，改动时注意线程停止条件。
- 模型文件读取依赖 Tauri `assetProtocol` 和 `convertFileSrc()`，不要直接把本地路径当浏览器 URL。
- 新增 UI 文案时同步所有 `src/locales/*.json`，否则语言切换可能出现缺失 key。
- 涉及发布或更新地址时检查 `src-tauri/tauri.conf.json` 的 updater endpoints 和 `.github/workflows/*`。
