# Deployer Agent
为了自动化部署，我create了一个deployer的agent，其实当前只是codex里面的一个会话session。但是目的是相同的。

### 创建单独的deployer用户，权限控制，避免AI进行瞎搞，删除重要文件。

1. 创建新用户

推荐使用 adduser 命令，它会自动为您创建家目录并引导设置密码。
在终端中运行以下命令（将 deployer 替换为您想设置的用户名，例如 project_admin 或 shishi）：
```bash
sudo adduser deployer
```

2. 赋予 sudo 权限（允许部署人员执行管理员命令）
    实施部署人员通常需要安装中间件（如 Docker、Nginx）或修改系统配置，因此需要将他们加入 sudo 组：
```bash
sudo usermod -aG sudo deployer
```

3. 配置 SSH 密钥登录（强烈推荐，比密码更安全）
   提供 SSH 公钥（id_rsa.pub），然后配置到服务器中：
    切换到新用户
   ```bash
   su - deployer
   ```
   创建 .ssh 目录并配置公钥：
```bash
mkdir -p ~/.ssh
chmod 700 ~/.ssh
echo "这里粘贴部署人员的 SSH 公钥内容" >> ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys
```

### Deployer agent 配置
创建ssh-key：创建成功后，把public key粘贴到上面的命令，并执行。
```powershell
ssh-keygen -t rsa -b 4096 -C "your_email@example.com"
```
本地就可以通过命令使用deployer访问服务器了，
```powershell
ssh -i .\.ssh\id_rsa_agent_deployer deployer@192.168.1.66
```

### 权限目录隔离

#### 一、 赋予 deployer 的 Docker 使用权限
在 Ubuntu 中，默认只有 root 用户和 docker 组的用户才能运行 Docker 命令。如果不做配置，deployer 执行 docker 命令时会报错 Permission denied。
请使用有 sudo 权限的账号运行以下命令：
```bash
# 1. 将 deployer 用户加入 docker 用户组
sudo usermod -aG docker deployer

# 2. 刷新用户组（或者让实施人员重新登录 SSH 即可生效）
sudo su - deployer -c "id"
```
验证方法：
让实施人员连接后直接运行 docker ps，如果能正常列出容器且不提示 sudo，说明 Docker 权限配置成功。
#### 二、 指定特定目录的访问与操作权限
假设您要给实施人员指定的项目部署目录为 /var/www/my-project（请根据实际情况修改路径）。
为了实现“只有 deployer 组或他本人能完全控制该目录，而无法乱动系统其他目录”的效果，请执行以下命令：

1. 创建目标目录（如果尚未创建）
```bash
sudo mkdir -p /var/www/student-start-ai-agent
```

2. 将目录的所有权移交给 deployer

```bash
sudo chown -R deployer:deployer /var/www/student-start-ai-agent
```

3. 设置严格的目录权限

```bash
# 赋予 deployer 读写执行权限，其他无关用户（others）没有任何权限
sudo chmod 750 /var/www/student-start-ai-agent
```


#### 三、 进阶安全：限制其 SSH 登录后默认进入该目录

为了让实施人员一连上 SSH 就直接进入工作目录，省去到处切换的麻烦，可以修改他的环境配置文件：
1. 打开 deployer 的环境配置文件：
   
```bash
    sudo nano /home/deployer/.bashrc
```

2. 移动到文件最底部，添加一行：
   
```text
cd /var/www/student-start-ai-agent
```

1. 保存并退出（Ctrl+O 回车，Ctrl+X 退出）。这样他每次登录进来，脚下就是指定的项目目录。

#### ⚠️ 安全合规提示（防范越权）

由于您在第一步中授予了 deployer 用户 sudo 权限（或他属于 docker 组），由于 Docker 的特性，拥有 Docker 权限的用户可以通过挂载根目录轻易获取宿主机的 root 权限。
• 如果需要绝对的安全隔离（即完全不允许他接触系统级文件）：请移除他的 sudo 权限（sudo deluser deployer sudo），并且不要让他运行任意的 docker run -v /:/host 挂载命令。
请问该项目的中间件（如 Nginx、MySQL）是通过 Docker 容器来部署，还是直接通过 Ubuntu 系统服务（apt 安装）来运行？如果是后者，我们可能还需要额外为他配置特定系统服务的重启权限。