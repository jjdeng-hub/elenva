# 发布约定

ELENVA 只通过 GitHub Releases 发布，不发布 npm 包，也不提供便携包通道。

## 发布步骤

1. 修改 `package.json` 中的 `version`，并确认版本号使用 `X.Y.Z` 格式。
2. 提交版本号变更：

   ```bash
   git add package.json
   git commit -m "chore: bump version to X.Y.Z"
   ```

3. 创建并推送版本标签：

   ```bash
   git tag vX.Y.Z
   git push origin main
   git push origin vX.Y.Z
   ```

4. 在 GitHub 上基于 `vX.Y.Z` 创建 Release。GitHub 会自动生成对应的源码 zip 压缩包。

更新检查读取 GitHub Releases 的最新发布版本；设置页中的更新链接会指向该 Release。
