# Eclesiar 助手（Eclesiar Helper）

一个给 [Eclesiar](https://app.eclesiar.com/)（多人在线经济 / 政治模拟游戏）用的油猴（Tampermonkey）脚本：右下角一个可拖动的悬浮球，点开是一块面板，把全服汇率、各国商品价格、工业地区与税负摊成几张可排序的表，并能一键跳到游戏对应页面。

当前版本 **v0.2.3**

> 非官方工具，与 Eclesiar 官方无关。只读公开行情、只在本地计算；不改游戏数据、不自动下单。请遵守游戏规则。

## 安装

1. 浏览器安装 [Tampermonkey](https://www.tampermonkey.net/)（Violentmonkey 也可以）。
2. 打开下面的安装地址，三选一，装的是同一份脚本：
   - 推荐（jsDelivr）：<https://cdn.jsdelivr.net/gh/Billdex/eclesiar-helper@main/eclesiar-helper.user.js>
   - 国内镜像（JSDMirror）：<https://cdn.jsdmirror.com/gh/Billdex/eclesiar-helper@main/eclesiar-helper.user.js>
   - 备用（GitHub raw，能直连时用）：<https://raw.githubusercontent.com/Billdex/eclesiar-helper/main/eclesiar-helper.user.js>
3. 打开 <https://app.eclesiar.com/> 并刷新，右下角出现金色悬浮球即生效。

也可以下载 `eclesiar-helper.user.js` 拖进浏览器窗口安装。脚本只匹配 `https://app.eclesiar.com/*`。

## 更新

- 自动更新走 jsDelivr：油猴定期只拉几 KB 的元数据比对版本号，版本变大才下载脚本本体。
- 「设置」页打开时会并行检查 jsDelivr / JSDMirror / 备用域名 / GitHub raw 四个源，取最高版本；有新版本才出现「安装更新」，下方另有三个手动安装链接。
- CDN 有缓存，刚发版后的一段时间里可能仍读到旧版本号，过一会儿再检查即可。镜像只作手工兜底，不参与自动更新。
- 覆盖安装不会清掉本地设置与已保存的密钥。

## 功能一览

| 能力 | 说明 |
| --- | --- |
| 悬浮球与面板 | 可以拖到方便的位置，插件会记住；点击展开面板，`Alt + E` 同样能开合，`Esc` 收起 |
| 数据面板 | 汇率、商品、工业、税费几类行情放在同一个面板里，打开就能横向对比，不必在游戏里一页页翻；都支持排序，税费页还能按国名或法币搜索 |
| 一键跳转 | 每行右侧的箭头会直接带你到游戏里对应的市场；如果你不在那个国家，市场页上还会列出它的地区，点一下就能过去 |
| 市场页标注 | 在游戏自己的商品市场里，价格下方会补一行折算后的金价，并提示比全球最低价贵多少，方便判断这单值不值得买 |
| 设置 | 可以生成一枚专用密钥，让插件查询不占用你游戏内的每日额度；也能在这里检查更新、复位悬浮球 |

数据都来自游戏公开接口，只在本地计算，不含手续费；报价随时会变。插件不会替你下单或操作游戏，唯一的例外是跳转落地后替你点一次游戏的分类 / 品质筛选。

## 分享给朋友

直接发**安装地址**，不要发仓库首页（对方打开仓库只会看到源码）。可以照抄：

> 先装油猴插件：<https://www.tampermonkey.net/>
> 再点这个安装：<https://cdn.jsdelivr.net/gh/Billdex/eclesiar-helper@main/eclesiar-helper.user.js>
> （国内打不开就换镜像：<https://cdn.jsdmirror.com/gh/Billdex/eclesiar-helper@main/eclesiar-helper.user.js>）
> 装完刷新 <https://app.eclesiar.com/>，右下角出现金色圆球就是生效了。
> 社区自制插件，不改游戏数据、不自动操作，只做行情计算。

仓库地址 <https://github.com/Billdex/eclesiar-helper> 只作为「看代码 / 提问题」的补充。

## 许可

MIT。仅供学习与个人辅助使用。
