# D:\browse 工具集合

本目录用于存放本地浏览器辅助工具。目前主要可用项目是 `tools2`：一个可加载到 Chrome、Edge 等 Chromium 浏览器中的本地扩展，用于自动浏览招聘搜索列表页、提取岗位详情、保存 Markdown，并可结合简历与 DeepSeek 进行岗位匹配评分。

## 目录结构

```text
D:\browse
├─ tools2\   Search Detail Auto Browser 浏览器扩展
├─ tools3\   预留目录，目前为空
└─ tools4\   预留目录，目前为空
```

## tools2：Search Detail Auto Browser

`tools2` 是当前主工具，扩展版本见 `tools2/manifest.json`。它的主要能力包括：

- 在搜索列表页按顺序打开或切换详情页。
- 支持 BOSS 直聘、智联招聘和通用站点配置。
- 按站点分别保存 CSS 选择器、浏览条数、等待参数和下一条模式。
- 提取岗位详情并下载为 Markdown 文件。
- 支持导入简历文本、Markdown、TXT 或 PDF。
- 支持通过 DeepSeek API 对岗位与简历进行 0-100 分匹配评分。
- 支持达到评分阈值后自动点击“立即沟通”。

### 安装

1. 打开 Chrome 或 Edge 的扩展管理页。
2. 开启“开发者模式”。
3. 点击“加载已解压的扩展程序”。
4. 选择扩展目录：

```text
D:\browse\tools2
```

安装后，浏览器工具栏会出现“自动浏览搜索详情”扩展入口。

### 基本使用

1. 打开目标招聘搜索列表页。
2. 点击扩展图标，进入弹窗。
3. 点击“设置”，选择站点类型：BOSS 直聘、智联招聘或通用站点。
4. 配置“左侧列表项 CSS 选择器”和可选的“详情区域 CSS 选择器”。
5. 设置浏览条数、起始序号、等待时间、自动/手动下一条等参数。
6. 保存设置后回到弹窗，点击“开始”。

扩展运行时会在页面右下角显示进度。当前页可识别的列表项浏览完成后，会提示手动翻页；翻页完成后可继续处理剩余条数。

### 常用选择器参考

BOSS 直聘列表项可先尝试：

```text
.job-card-wrapper, .job-card-box
```

BOSS 直聘详情区域可先尝试：

```text
.job-detail-container, .job-detail-box, .job-detail
```

智联招聘列表项可先尝试：

```text
.joblist-box__item, .joblist-box__iteminfo, .job-item, a[href*='jobs.zhaopin.com'], a[href*='/jobdetail/']
```

智联招聘详情区域可先尝试：

```text
.job-detail, .job-detail-container, .job-detail__container, .position-detail, .job-intro, .detail-container, .summary-plane, .describtion, .description
```

通用站点如果列表项本身就是链接，可以先使用默认值：

```text
a[href]
```

### 输出文件

默认开启“保存到本地”时，扩展会把岗位详情保存为 Markdown。下载位置是浏览器默认下载目录下的子文件夹：

- BOSS 直聘：`boss-jobs/`
- 智联招聘：`zhaopin-jobs/`
- 其他站点：`job-details/`

文件名格式：

```text
岗位名称-企业名称-薪资区间.md
```

### 简历匹配评分

在 `tools2` 设置页中可以：

1. 粘贴简历 Markdown / 文本，或上传 `.pdf`、`.md`、`.txt` 文件。
2. 填写 DeepSeek API Key。
3. 在扩展弹窗点击“评分当前岗位”。

扩展会把岗位信息和简历内容发送给 DeepSeek，并返回匹配分、匹配等级、优势、差距、建议和证据摘要。

启用“达标自动沟通”后，自动浏览时会先评分；当分数达到配置阈值时，扩展会尝试点击页面上的“立即沟通”。

## 开发与维护

当前扩展是静态浏览器扩展项目，不需要单独构建。修改 `tools2` 下的 HTML、CSS 或 JS 文件后，在浏览器扩展管理页点击刷新即可加载最新代码。

关键文件：

- `tools2/manifest.json`：扩展声明、权限、入口脚本。
- `tools2/popup.html`、`tools2/popup.js`、`tools2/popup.css`：浏览器弹窗。
- `tools2/options.html`、`tools2/options.js`、`tools2/options.css`：独立设置页。
- `tools2/content.js`、`tools2/content.css`：注入目标网页的运行逻辑和浮层样式。
- `tools2/background.js`：后台服务、下载、标签页切换、DeepSeek 调用。
- `tools2/vendor/pdfjs/`：PDF 简历解析依赖。

## 注意事项

- 扩展不能在 `chrome://`、`edge://` 等浏览器内部页面运行。
- 扩展依赖目标页面 DOM 和 CSS 选择器，网站改版后可能需要更新选择器。
- 某些网站会限制脚本点击或自动化行为，请控制访问频率。
- DeepSeek API Key 存在本地浏览器扩展存储中，请勿把个人密钥提交到代码或文档。
- 使用自动浏览、自动沟通等功能时，请遵守目标网站的使用条款。
