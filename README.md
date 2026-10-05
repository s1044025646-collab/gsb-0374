# 分块位向量 rank/select 索引与位置查询后端

静态零一位向量的位置查询服务：TypeScript + Node.js + SQLite，仅 API 与 CLI，Windows 本地运行，无 Docker / WSL / 外部服务依赖。

## 定义与约定

- 位置（下标）从 **0** 开始；位值仅为 `0` 或 `1`。
- `rank(b, k)` = 前 `k` 位（区间 `[0, k)`）中位值 `b` 的个数，`k ∈ [0, N]`。`rank(b, 0) = 0`，`rank(b, N)` 为全向量中 `b` 的总数。
- `select(b, j)` = 第 `j` 次出现（`j` 从 0 开始）的下标；不存在时返回 `-1`（JSON 中 `result: -1`），绝不用位置 0 冒充未找到。
- 空向量合法：任何 `select` 返回 `-1`，`k` 只允许为 0。
- 不变式：`rank(b, select(b, j) + 1) = j + 1`（测试中对随机向量全枚举验证）。

## 位序与字节序

- 位 `i` 存放在第 `i >> 5` 个 32 位字的第 `i & 31` 位（**字内 LSB 优先**：位 0 是最低有效位）。
- 快照十六进制为字的**小端字节序**：字节 `t` 对应位 `8t .. 8t+7`，字节内同样是 LSB 为更小的下标。
- 最后一个不足 32 位的字，超出有效长度的填充位一律为 0，且**不计入**零位统计（零位由 `k - rank(1, k)` 推导，select(0) 扫描时把无效位强制置 1 再取反）。
- 全部位运算使用无符号右移 `>>>` 与 `Uint32Array`，第 31 位不会被当成负数。

## 索引结构

- 每字 32 位，每个大块 8 字 = 256 位。
- `blockSums[b]`：第 `b` 个大块之前的一位总数（含末尾哨兵 = 全部一位数）。
- `wordSums[w]`：字 `w` 在其大块内的局部一位前缀和。
- `rank(1, k)` = `blockSums[k>>8] + wordSums[字] + popcount(字 & ((1<<(k&31))-1))`，只读两个累计值和一个字。
- `select`：先在 `blockSums` 上二分定位大块（取最后一个“累计值 ≤ j”的大块，连续空大块累计值相等时仍能正确落块），再在大块内逐字、字内逐位（清除最低位）定位。`select(0)` 用 `块起始位 - blockSums` 推导零的累计。
- 索引空间：原始位 `N/8` 字节 + 大块数组 `4·(⌈N/256⌉+1)` + 字数组 `4·⌈N/32⌉` 字节（约 1.17 倍原始位，无压缩）。

## 构建、测试、启动、演示

```powershell
npm install
npm run build     # tsc -> dist/
npm test          # 编译并运行全部测试
npm run demo      # 101001 演示 + 跨 32/256 位边界长向量
npm start         # 启动 HTTP API（默认端口 0 = 自动选空闲端口）
```

数据目录为项目内 `data/`，数据库文件 `data/bitvector.db`（可用环境变量 `BV_DB` 覆盖），端口用 `--port` 或环境变量 `PORT` 指定。

## CLI

```
node dist/src/cli.js <command>
  serve [--port N]                启动 HTTP API
  import <name> <bits>            导入位串并建索引（同名产生新版本）
  import-hex <name> <len> <hex>   导入快照（有效长度 + 十六进制）
  build <ref>                     从库存原始字节重建索引并输出统计
  rank <ref> <bit> <k> [--explain]
  select <ref> <bit> <j> [--explain]
  range <ref> <from> <to>         查看区间位串（展示截断不影响数据长度）
  stats <ref>                     块统计（每块累计/块内一位数/有效位数）
  export <ref>                    导出快照 {format,length,hex}
  list                            列出全部版本
  demo
```

`ref` 可以是数字 `id`、`name`（最新版本）或 `name@version`。修改位串即再次 `import`，自动产生新版本；旧版本查询仍对应旧数据；重启后直接从 SQLite 重放原始字节重建索引，无需重新输入。

## HTTP API（JSON）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/vectors` | 列出全部版本 |
| POST | `/vectors` | `{name, bits}` 导入位串 |
| POST | `/vectors/import` | `{name, length, hex}` 导入快照 |
| GET | `/vectors/:ref` | 元信息 + 预览（截断标记独立于数据长度） |
| POST | `/vectors/:ref/rank` | `{bit, k}` 或 `{queries:[...]}`，加 `explain:true` 得解释 |
| POST | `/vectors/:ref/select` | `{bit, j}` 或批量，同样支持 `explain` |
| GET | `/vectors/:ref/range?from=&to=` | 查看区间（上限 4096 位） |
| GET | `/vectors/:ref/stats` | 块统计 |
| GET | `/vectors/:ref/snapshot` | 导出 `{format:"bv1", length, hex}` |

### 查询解释（explain）

`rank` 解释包含：大块下标、大块累计值、块内字下标、局部累计值、字的十六进制、有效位掩码、掩码内 popcount 与最终结果。`select` 解释包含：二分步数、命中大块、块内剩余次数、选中字、有效字（填充位置 1 后）、字内位下标。解释步骤有上限，大输入不会无限展开。

### 错误码

`INVALID_BITS` `INVALID_BIT` `INVALID_INDEX` `INVALID_LENGTH` `OUT_OF_RANGE`（负数、小数、越界 k 一律拒绝）`CORRUPT_SNAPSHOT`（长度不符 / 非法字符 / 末字节填充位非零）`NOT_FOUND` `TOO_MANY` `BAD_JSON` `BAD_REQUEST`。HTTP 返回 `{error:{code,message}}`，CLI 输出 `error CODE: message` 并以非零码退出。

## 快照格式

`{format:"bv1", length, hex}`：`length` 为有效位长度，`hex` 为小端字节，字节数必须等于 `ceil(length/8)`，末字节填充位必须为 0。导入时重新从原始字节构建全部累计计数，**不信任**任何外部给出的索引数据。

## SQLite 持久化

表 `vectors(id, name, version, length, data BLOB, index_version, report, created_at)`：保存原始字节、有效长度、索引版本与构建报告。同名再导入版本号 +1，按 `id` 或 `name@version` 查询旧数据。

## 实测结果（本机，Node v25.5.0，Windows）

- `101001`：`rank(1,4)=2`、`rank(0,4)=2`、`select(1,2)=5`、`select(0,0)=1` ✔
- 长向量 `n=700`（跨 32 位与 256 位边界）：3 个大块，一位 236 个，全量 rank 扫描 1ms。
- 一千万位随机向量（`n=10,000,000`，一位约 370 万）：建索引 302ms，索引 2,656,272 字节（3.9 万大块）；10 万次随机 rank 25ms，10 万次随机 select 187ms。
- 测试：11 项核心测试（含 40 组随机短向量全枚举 rank/select 对照独立扫描基准、不变式 `rank(b,select(b,j)+1)=j+1`、全零/全一/空串/交替/连续空大块/末尾不完整字/快照损坏）+ 端到端 API 测试，全部通过。

## 限制

- 静态索引：修改位串只能整体重建（产生新版本），不支持单比特增量更新。
- 无压缩（非压缩比竞赛），索引约为原始位的 1.17 倍。
- `node:sqlite` 在 Node 25 仍为实验特性（启动时有 ExperimentalWarning，不影响功能）。
- 区间展示上限 4096 位、批量查询上限 1000 条、解释步骤上限 64 步。
