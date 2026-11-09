# NeoRead 的 BabelDOC 适配

使用 BabelDOC 0.6.4（AGPL-3.0），上游源码：
https://github.com/funstory-ai/BabelDOC/tree/v0.6.4

NeoRead 修改了 BabelDOC 的两个缓存位置：

- `babeldoc/const.py`：资产缓存读取 `NEOREAD_BABELDOC_CACHE`。
- `babeldoc/translator/cache.py`：翻译缓存写入一次性工作目录 `NEOREAD_BABELDOC_WORK`。

`worker.py` 通过固定版本的段落钩子注入已保存译文，不调用在线翻译。
`positions.py` 将排版后的字形与最终 PDF 核验，生成句子坐标；适配源码随运行时一同保留。
`layout.py` 通过固定版本的排版钩子保存原栏位、标题轴线与参考行距，逐段适配字号，不使用整篇文档的统一缩放。无法清晰放入原框的译文阻止新 PDF 发布。
`formulas.py` 区分正文符号与公式，在源文字逐符号验证后组合线性数学及向量片段；无法还原时按精确原句边界局部保留，并汇总已有译文的写入覆盖情况。
`prepare-babeldoc.mjs` 包含补丁的完整步骤；`requirements.lock` 包含依赖与哈希。
运行时 `site/` 保留 Python 源码和各包的许可证，`python/` 保留 CPython 及其许可证。
BabelDOC 的许可证原文位于 `site/babeldoc-0.6.4.dist-info/licenses/LICENSE`。
PyMuPDF/MuPDF 也涉及 AGPL 授权。正式分发应提供满足相关许可证的对应源码，
并确认 NeoRead 整体分发方式符合许可证；本次开发验证不产生公开发行包。
