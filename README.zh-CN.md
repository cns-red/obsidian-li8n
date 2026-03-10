# li8n — Obsidian 插件

**语言:** [English](README.md) | [简体中文](README.zh-CN.md)

在同一个 Markdown 文件中编写多语言内容版本，并通过全局语言切换器控制当前可见语言。

## Features

- 在同一笔记中维护多语言版本，避免重复文件。
- 支持四种等价语法：fenced-div、Hexo 标签、Markdown 注释、Obsidian 注释。
- 可通过 Ribbon、状态栏、命令面板或 `Alt+L` 全局切换语言。
- 支持每篇笔记的 frontmatter 覆盖：`lang: <code>` 或 `lang: ALL`。
- 无语言标记的笔记自动视为默认语言。
- 兼容 Reading mode、Live Preview、Source mode。

## Usage

### 安装

1. 可通过 BRAT 安装，或手动将 `main.js`、`manifest.json`、`styles.css` 复制到 `<vault>/.obsidian/plugins/li8n/`。
2. 在 **Settings → Community plugins** 中启用 **li8n**。

### 语法

以下语法可混用，效果等价：

```md
:::li8n zh-CN
这是中文版本。
:::

:::li8n en
This is the English version.
:::
```

```md
{% li8n zh-CN %}
这是中文版本。
{% endli8n %}
```

```md
[//]: # (li8n zh-CN)
这是中文版本。
[//]: # (endli8n)
```

```md
%% li8n zh-CN %%
这是中文版本。
%% endli8n %%
```

规则：
- 开始与结束标记必须独占一行，且行首不能有空格。
- 语言块外的文本始终可见。
- 语言代码大小写敏感，需与设置完全一致。

### Obsidian 插件发布后的 README 页面说明

发布到 Obsidian 社区插件目录后，插件详情页会读取仓库根目录 `README.md` 作为主要说明页面。建议始终维护英文 `README.md` 为完整主文档，再通过顶部语言导航链接到 `README.zh-CN.md` 等本地化文档。

### Translation Contribution Guide（翻译贡献指南）

新增或更新多语言 README 时，请遵循：

- 章节顺序保持一致：**Features → Usage → Settings → Build → Limitations**。
- 术语保持一致（必要时保留英文）：
  - **language block（语言块）**
  - **active language（当前激活语言）**
  - **default language（默认语言）**
  - **show all (`ALL`)（显示全部）**
- 若某术语暂无统一译法，请保留英文并在括号内补充中文。
- 新增语言版本时，需同步更新所有 README 顶部的语言导航。

## Settings

打开 **Settings → li8n**：

- **Active language**：当前全局显示语言。
- **Default language**：无标记笔记的默认语言。
- **Hide non-active blocks in editor**：折叠或弱化非当前语言内容。
- **Show language badges**：阅读模式显示语言标签。
- **Configured languages**：管理语言名称与代码。

## Build

```bash
git clone https://github.com/your-username/obsidian-li8n
cd obsidian-li8n
npm install
npm run dev
npm run build
```

构建产物为仓库根目录下的 `main.js`。

## Limitations

1. 语言块中极深层嵌套 Markdown 偶尔会出现归属判断偏差。
2. 暂不支持句内（inline）多语言片段切换。
3. 语言代码不做 ISO 标准校验。
4. 移动端编辑器块替换行为为尽力支持，可能有细微差异。

## License

MIT
