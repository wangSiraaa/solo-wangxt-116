# 纯前端排练乐谱台

Vue 3 + TypeScript + OpenSheetMusicDisplay 的本地排练工具。没有后端：MusicXML 原文和独立排练标记保存在浏览器 IndexedDB，导出时原 XML 与标记 JSON 分开保存。

## 启动

```bash
npm install
npm run dev
```

生产构建与烟测：

```bash
npm run build
npm test
```

## 演奏路径原则

工具不会简单地按页面小节号 `1,2,3...` 前进，而是只从明确支持的 MusicXML 记号构造路径：

- `<repeat direction="forward|backward">` 前后反复；
- `<ending type="start|stop|discontinue" number="...">` 跳房，包括同一反复中的第 1、第 2 跳房；
- `<segno>`、`<coda>`、`<fine>`；
- 导航文字 `D.C.` / `D.S.` / `Da Capo` / `Dal Segno` / `To Coda` / `al Coda` / `al Fine`；
- `<sound tempo="...">` 和 `<metronome><per-minute>` 速度；
- `<time>` 拍号、`<divisions>` 和真实 `<duration>`，首个短小节按弱起处理。

若 Segno/Coda/Fine 缺失、跳房没有闭合、后反复无匹配起点、目标重复执行形成无限循环等，诊断面板和播放按钮会显示错误，不猜测跳转。无法识别但看起来像导航的文字、未参与路径构造的小节线元素会列警告，不会静默丢弃。

## 示例

内置“双跳房 · 变速 · 多声部共有小节”：

- 第 1 小节前有弱起，只演奏一次；
- 第 1 跳房后回到反复起点；
- 第 2 遍跳过第 1 房，进入第 2 房；
- 第 2 房开始速度从 ♩=90 改为 ♩=140；
- 高声部内同时有两个 Voice，低音声部共享同一书面小节和同一时间轴；
- 实际顺序不是页面顺序，路径表面会显示每次到达的书面小节、遍数、跳房编号与累计秒数。

## 节拍与光标

Web Audio 使用提前调度的振荡器生成节拍音，避免用 UI 定时器直接发声。脉冲按实际路径和每小节真实时长生成，弱起按末尾拍子编号，重拍加重。播放时 SVG 上的红色竖线随脉冲在当前小节内移动，蓝色底色标出当前跨声部共有小节。

## 数据与导出

- IndexedDB 数据库：`rehearsal-stand`，store：`projects`；
- 保存内容包含原始 MusicXML 字符串和独立 `RehearsalMarker[]`；
- 导出两个文件：
  - `*.musicxml`：原始 XML 文本，不注入标记、不规范化重写；
  - `*.rehearsal-markers.json`：独立标记、源文件名、XML SHA-256 和导出时间。
