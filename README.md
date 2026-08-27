# 新品排产助手 · 飞书多维表格插件

这是一个基于 Base JS SDK 的飞书多维表格边栏插件。

## 当前版本

- 自动读取当前多维表格中的数据表
- 允许选择一张表
- 点击按钮写入一条空白测试记录
- 已配置 GitHub Pages 自动部署
- 排产计算尚未接入，界面中会明确显示“待接入”

## 启用 GitHub Pages

进入仓库 `Settings → Pages`，在 `Build and deployment` 中将 `Source` 设为 `GitHub Actions`。
随后在 `Actions` 中查看 `Deploy Base Plugin`，部署成功后从 Pages 页面复制运行地址。

## 在飞书中测试

打开一张测试多维表格：

1. 打开“插件”。
2. 选择“自定义插件”。
3. 点击“新增插件”。
4. 粘贴 GitHub Pages 运行地址。
5. 打开插件，选择测试表并点击“写入一条空白测试记录”。

## 本地开发

```powershell
npm.cmd install
npm.cmd run dev
```

## 数据安全

当前版本不包含任何外部数据上传逻辑，也不包含 App ID、App Secret 或访问令牌。
请勿把公司真实数据、密码、令牌或密钥提交到公开仓库。
