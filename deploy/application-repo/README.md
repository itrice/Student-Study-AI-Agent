# 应用仓库 CI/CD 模板

本目录不包含业务应用。将以下内容复制到具体应用仓库后，填写应用自己的契约、Dockerfile 和 Kubernetes 清单。

必须由应用仓库提供：

- `.platform-ci.json`
- 测试命令
- `Dockerfile`
- `deploy/k8s/overlays/production`
- `scripts/smoke-test.sh`

应用清单中的镜像字段必须使用：

```text
__PLATFORM_IMAGE__
```

生产 Kubernetes 资源必须由应用仓库声明，包括 Namespace、Deployment、Service、Ingress、PVC、ConfigMap 和 Secret 名称。

真实 Secret、数据库、附件和 `.env` 不得进入 Git。
