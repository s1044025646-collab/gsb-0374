# 分块位向量 rank/select 索引与位置查询后端

纯本地运行的静态位向量查询服务：TypeScript + Node.js + SQLite（`node:sqlite`，无原生扩展、无 Docker、无外部服务）。只提供 API 与 CLI。

## 快速开始

```powershell
npm install        # 仅需 devDependencies: typescript, @types/node
npm run build      # 编译到 dist/
npm test           # 编译并运行全部测试
npm run demo       # 内置演示（101001 + 跨边界长向量）
npm start          # 启动 API（默认自动选择空闲端口）
node dist/cli.js serve 8080   # 指定端口
```

数据目录为项目内 `data/`（可用环境变量 `BV_DB` 覆盖），重启后无需重新输入数据。

## 概念与约定

- **下标**：位置从 0 开始。`rank(b,k)` 统计前 k 位即区间 `[0,k)` 中位值 b 的个数，`k ∈ [0, N]`；`select(b,j)` 返回第 j 次（j 从 0 起）出现的位置，不存在时返回 `null`（绝不用位置 0 冒充未找到）。
- **位序/字节序**：逻辑位 i 存放在第 `floor(i/32)` 个 32 位字中，字内低位在前（位 i 对应字内比特 `i % 32`，第 0 位是最低位）；快照字节同理（LSB-first）。所有计数用无符号运算（`>>> 0`），第 31 位不会被当作负数。
- **有效位**：最后一个不足 32 位的字、不足 8 位的字节，其填充位不算数据；`rank(0,k)` 由 `k - rank(1,k)` 推导，填充零永不计入。
- **索引结构**：每 32 位一个字，每 256 位（8 字）一个大块。保存：每大块之前的 1 累计、每大块之前的 0 累计（由有效长度推导）、每字在大块内的局部 1 累计。
- **索引空间**：原始字 4B/32 位 + 每字局部计数 4B + 每大块两个累计 8B/256 位，约为原始数据的 2.03 倍（未做压缩，本设计不追求压缩比）。

## 查询步骤

- **rank(b,k)**：读大块累计 `superOnes[k/256]` + 字局部累计 `wordOnes[k/32]` + 该字低 `k%32` 位的 popcount（掩码 `lowMask`）；b=0 时用 `k - ones`。
- **select(b,j)**：在大块累计数组上二分，取最后一个 `cum[s] <= j` 的大块（连续空块累计值相等时取最右，保证正确定位）；再在块内逐字比较 popcount，命中字内逐位定位。
- **解释**：`--explain` / API `explain:true` 返回所用大块号、大块累计、字局部累计、选中字的十六进制、有效位掩码、局部 popcount 及最终定位过程。批量请求超过 100 条时自动省略解释。展示截断（range）与查询结果分离，不改变数据长度。

## CLI

```
node dist/cli.js import <name> <bits|@file>   # 导入位串并建索引（同名自动升版本）
node dist/cli.js rank <name> <b> <k> [--explain] [--version=N]
node dist/cli.js select <name> <b> <j> [--explain]
node dist/cli.js batch <name> <ops.json>      # [{op:"rank",b,k}|{op:"select",b,j}]
node dist/cli.js range <name> <from> <to>     # 查看区间（仅展示截断）
node dist/cli.js stats <name>                 # 块统计
node dist/cli.js list                         # 全部向量与版本
node dist/cli.js export <name> [file]         # 导出快照 {format,length,hex}
node dist/cli.js load-snapshot <name> <file>  # 导入快照：校验长度/填充位并重建累计
node dist/cli.js serve [port]                 # 缺省端口 0 = 自动选空闲端口
node dist/cli.js demo
```

## HTTP API

- `POST /vectors` `{name, bits}` 或 `{name, snapshot}` → 构建并保存
- `GET /vectors` → 列表（含版本）
- `POST /vectors/:name/rank` `{b,k,explain?}`；`POST /vectors/:name/select` `{b,j,explain?}`
- `POST /vectors/:name/batch` `{ops:[...], explain?}`
- `GET /vectors/:name/range?from=&to=`；`GET /vectors/:name/stats`；`GET /vectors/:name/snapshot`
- 均可加 `?version=N` 查询旧版本数据（修改位串会创建新版本，旧查询仍对应旧数据）

**错误码**：`INVALID_BITS` `INVALID_BIT` `INVALID_K` `INVALID_J` `OUT_OF_RANGE` `NOT_FOUND` `BAD_SNAPSHOT` `LENGTH_MISMATCH` `PADDING_NOT_ZERO` `BAD_JSON` `BAD_OP` 等，非法位值、负数、小数索引、越界 k 一律拒绝（HTTP 400）。

## 快照格式

```json
{ "format": "bitvector-snapshot-v1", "length": 6, "hex": "25" }
```

导入时校验：hex 字节数必须等于 `ceil(length/8)`、末字节填充位必须为 0；累计计数一律重新计算，不信任外部给出的索引。

## SQLite 存储

表 `vectors(name, version, length, data BLOB, index_version, report, created_at)`，保存原始字节、有效长度、索引版本与构建报告；同名导入版本号递增，重启后直接查询。

## 实测结果（本机，Windows + Node 25）

- `101001`：`rank(1,4)=2`、`rank(0,4)=2`、`select(1,2)=5`、`select(0,0)=1` ✔
- 1,000,000 位随机向量：构建索引约 **13 ms**，`rank(1,1000000)=319588`；10,000 次批量 rank（含本机 HTTP 开销）约 **18 ms**；快照重导入并重建索引约 **9 ms**。
- 测试：12 项全部通过，覆盖全零/全一/空串/交替位/连续空大块/不完整尾字/快照损坏，并对 50 个随机短向量枚举全部合法 rank/select 与独立逐位扫描基准核对，验证 `rank(b, select(b,j)+1) = j+1`。

## 限制

- 静态索引：修改位串需整体重建（自动产生新版本），不支持单点增量更新。
- 索引未压缩，内存占用约为原始数据 2 倍；位向量整体驻留内存。
- `node:sqlite` 在 Node 25 仍打印 ExperimentalWarning，不影响功能。
- select 在命中大块内逐字扫描（最多 8 字），字内逐位（最多 32 位），未使用更高级的 select 加速结构。
