# 控制面板（只读 · 带密钥门）

给控制角色（主对话 / 需求分析 / 主管 / 归档）看的本地单页面板。
每次请求现读三份文档，文档一改，刷新即最新：

- `需求清单与进度-20261014/需求清单与进度.md`
- `bug待修复单-20261014.md`
- `变动日志.md`

默认从仓库的 `docs/` 读；在原机器上用 `--docs <DSH_HOME>\dsh_orb`（或环境变量 `DSH_DASHBOARD_DOCS`）指回原目录。

## 启停

```bat
dashboard\start.cmd                      :: 首次会自动生成钥匙与端口
dashboard\start.cmd --docs D:\某个目录     :: 换数据源目录
dashboard\stop.cmd                       :: 只结束 dashboard.pid 里记的那个进程
```

不用脚本时：

```bat
node server.mjs --init     :: 生成 dashboard-keys.json；已有时重新生成钥匙（轮换）
node server.mjs            :: 启动
node server.mjs --print    :: 打印地址、端口、钥匙掩码，不启服务
```

打开 `http://127.0.0.1:<端口>/?k=<你的钥匙>`，或用请求头 `x-dsh-key: <你的钥匙>`。

## 钥匙

- 四把各自独立的 32 位十六进制随机串，权限相同，只决定页面顶部显示的身份。
- 完整值只在 `dashboard/dashboard-keys.json`（已被 `.gitignore` 挡住，不入库）。生成时去掉 ACL 继承、只留当前用户。
- 页面和命令行输出只显示前 6 位。

## 边界

- 只监听 `127.0.0.1`，Host 头只认 `127.0.0.1` / `localhost`。
- 只有 `GET /`：其它方法 405，其它路径 404；没有任何写入接口。
- 钥匙不对一律 403，403 之前不读任何数据源。
- 页面零外链：样式内嵌，没有脚本、图片和链接。
- 端口被占用时启动失败并报错，不会自动换口；换口要删掉 `dashboard-keys.json` 里的 `port` 再跑 `--init`。
