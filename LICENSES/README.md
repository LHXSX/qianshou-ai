# 许可边界

本仓库使用多种许可证；仓库公开可读不等于每个目录都可商用。请先查看目标目录中的许可证和第三方声明。

| 目录 | 发布候选的授权边界 |
| --- | --- |
| `shanghai-v8/` | 胖墩自研部分按 [PolyForm Noncommercial 1.0.0](../shanghai-v8/LICENSE) 提供非商业使用；商业用途需另行取得书面授权。 |
| `pc/`、`guangzhou/` | 两份 DeepSeek Harness 基座保留各自根目录的上游 MIT `LICENSE`；千手对其衍生包有权授权的新增部分沿用包内 MIT 元数据，版权边界见各自根目录 `NOTICE`。vendored、native 和依赖保持嵌套许可证与 `THIRD_PARTY_NOTICES.md`。`pc/qianshou/` 原创源码及配置、`guangzhou/docs/qianshou/` 原创文档、`guangzhou/apps/qianshou-ios/` 与 `guangzhou/apps/qianshou-relay/` 的原创源码分别有 Apache-2.0 `LICENSE` 与 `NOTICE`；不覆盖第三方文本和其他目录。来源不明的组件仍须核对或排除。 |
| `windows-h3/`、`windows-h3-adapter/` | 候选包已给千手第一方源码加 Apache-2.0 与 NOTICE，并同步 H3 摘要清单；ComfyUI/KJNodes/T8 等 GPL 上游与补丁仍按各自许可证，详见目录内 NOTICE、锁文件和嵌套许可证。此为源码授权与离线校验，不代表 Windows 实机验收或安装包发布。 |
| `website/`、`mobile-preview-archive/` | 网站第一方代码与移动预览应用第一方代码分别有 Apache-2.0 `LICENSE`、`NOTICE`；项目所有者确认有权将随仓品牌／设计素材公开于此，但这些素材、下载物及移动账号包不受 Apache 授权覆盖，复用条款见各自 NOTICE。 |

`Apache-2.0.txt` 是已明确标出的第一方 Apache 范围所用的许可证文本，**不是整个仓库的根许可证**。DeepSeek Harness MIT、Cordis 等 vendored 项目的 MIT、native 子项目 BSD、依赖的 GPL/MPL/其他许可证，以及模型权重和媒体素材的条款均继续有效。混合文件中的上游代码不会因千手新增部分选择 Apache-2.0 而失去原许可。

广州手机外壳 `public/media/` 和移动预览 `design-kit/` 的部分 PNG 带 Grok Imagine 来源标记；项目所有者确认有权随本仓库公开这些设计图，具体归属与复用边界见各素材目录 README。发布或分发时须清晰注明 **Created with Grok**；这并非把图片纳入源码的 MIT/Apache 授权。

来源核对：`pc/qianshou/upstream.json` 记载 DeepSeek Harness `dsh-v0.1.6-alpha.2` 的来源、提交和归档 SHA-256。逐文件差异可帮助识别新文件，但“上游快照里没有”**不等于**“完全由千手原创”；广州也不能仅凭 `package.json` 版本号断定全部文件来源。对这些混合目录，发布前须以包元数据、上游版权声明和贡献记录逐项核对。
