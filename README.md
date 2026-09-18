# range-planner — HTTP 字节范围响应规划 API

基于 **Node.js + Fastify + range-parser**，按照 [RFC 9110 §14](https://www.rfc-editor.org/rfc/rfc9110#section-14)
规划 `206 Partial Content` 字节范围响应。

服务**不传输真实资源字节**，而是根据资源总字节数（`size`）与 `Range` 请求头，
产出一份确定性的“响应规划”（HTTP 状态码、实体头、每段范围、multipart 边界与精确长度），
供真实源站 / 边缘节点 / 测试客户端直接套用。

- 解析闭区间 `bytes=0-499`、开放尾端 `bytes=500-`、后缀范围 `bytes=-500`
- 夹取越界端点（`bytes=900-99999` → 末字节 `size-1`）
- 丢弃不可满足的范围项；**全部**不可满足时返回 `416` 并带 `Content-Range: bytes */<size>`
- 合并重叠或相邻（中间间隔为 0 字节）的区间
- 单区间 → `206` 单段头规划；多区间 → 确定性 `multipart/byteranges` 边界与逐段头
- 防护：范围段数超过 **16**、或规划传输字节超过原资源 **2 倍** → `422`

---

## 一条命令启动

```bash
docker compose up --build
```

启动后服务监听（容器内外均为 3000 端口）：

- 基础地址：**http://localhost:3000**
- 规划接口：**http://localhost:3000/ranges/plan**
- 健康检查：**http://localhost:3000/healthz**

停止：`Ctrl+C`（后台运行则用 `docker compose down`）。

无 Docker 时的本地方式：

```bash
npm ci --omit=dev
npm start          # 同样监听 http://localhost:3000
```

---

## 接口

### `POST /ranges/plan`

请求：

| 位置 | 字段 | 说明 |
| --- | --- | --- |
| Header | `Range` | 必填，RFC 9110 字节范围，仅支持 `bytes` 单位 |
| JSON Body | `size` | 必填，资源总字节数，非负整数（≤ `2^53-1`） |
| JSON Body | `contentType` | 可选，资源媒体类型，默认 `application/octet-stream`（用于 `Content-Type` 规划头） |

### `GET /ranges/plan?size=1000`

等价的便捷形式：`size` / `contentType` 走 query string，`Range` 仍走请求头。

---

## 快速示例

```bash
# 单区间（真实返回 206，且响应头带 Content-Range）
curl -i -X POST http://localhost:3000/ranges/plan \
  -H 'Range: bytes=0-499' \
  -H 'Content-Type: application/json' \
  -d '{"size":1000,"contentType":"video/mp4"}'

# 多区间 -> multipart/byteranges
curl -X POST http://localhost:3000/ranges/plan \
  -H 'Range: bytes=0-99,900-999' \
  -H 'Content-Type: application/json' \
  -d '{"size":1000}'

# 全部不可满足 -> 416 + Content-Range: bytes */1000
curl -i -X POST http://localhost:3000/ranges/plan \
  -H 'Range: bytes=5000-' -H 'Content-Type: application/json' -d '{"size":1000}'
```

---

## 响应规划结构

### 单区间 `206`

真实 HTTP 状态码为 **206**，并在实际响应头上回显 `Accept-Ranges: bytes` 与
`Content-Range`（可安全携带在 JSON 信封上）。实体头的完整规划位于 body：

```json
{
  "statusCode": 206,
  "kind": "single",
  "resourceSize": 1000,
  "requestedRange": "bytes=0-499",
  "rangeCountBeforeMerge": 1,
  "segments": [
    {
      "index": 0,
      "start": 0,
      "end": 499,
      "length": 500,
      "contentRange": "bytes 0-499/1000",
      "headers": {
        "Content-Range": "bytes 0-499/1000",
        "Accept-Ranges": "bytes",
        "Content-Type": "video/mp4",
        "Content-Length": "500"
      }
    }
  ],
  "headers": { "Content-Range": "bytes 0-499/1000", "Accept-Ranges": "bytes",
               "Content-Type": "video/mp4", "Content-Length": "500" },
  "contentLength": 500
}
```

### 多区间 `206`（multipart）

合并后仍多于一段时生成 `multipart/byteranges` 规划。`boundary` 由
`size | mediaType | 合并后区间序列` 的 SHA-256 派生，**相同输入永远得到相同边界**；
`contentLength` 精确等于“边界 + 逐段头 + 段体”的总字节数。

```json
{
  "statusCode": 206,
  "kind": "multipart",
  "segments": [
    { "index": 0, "start": 0, "end": 99, "length": 100,
      "contentRange": "bytes 0-99/1000",
      "multipartPrelude": "Content-Type: video/mp4\r\nContent-Range: bytes 0-99/1000\r\n\r\n",
      "headers": { "Content-Type": "video/mp4", "Content-Range": "bytes 0-99/1000" } },
    { "index": 1, "start": 900, "end": 999, "length": 100,
      "contentRange": "bytes 900-999/1000",
      "multipartPrelude": "Content-Type: video/mp4\r\nContent-Range: bytes 900-999/1000\r\n\r\n",
      "headers": { "Content-Type": "video/mp4", "Content-Range": "bytes 900-999/1000" } }
  ],
  "multipart": {
    "contentType": "multipart/byteranges; boundary=----rangeplanner<a5c0…32hex>",
    "boundary": "----rangeplanner<a5c0…>",
    "contentLength": 483,
    "overheadBytes": 283,
    "delimiter": "------rangeplanner<a5c0…>",
    "closingDelimiter": "------rangeplanner<a5c0…>--"
  },
  "headers": {
    "Accept-Ranges": "bytes",
    "Content-Type": "multipart/byteranges; boundary=----rangeplanner<a5c0…>",
    "Content-Length": "483"
  },
  "contentLength": 483
}
```

multipart 线格式（由 `delimiter` / `multipartPrelude` / `closingDelimiter` 拼接）：

```
--<boundary>\r\n
Content-Type: <mediaType>\r\n
Content-Range: bytes <start>-<end>/<size>\r\n
\r\n
<该段资源字节>
\r\n
--<boundary>\r\n
…（其余段）…
--<boundary>--\r\n
```

> 说明：本服务返回的是 JSON 规划，因此 multipart 的 `Content-Type`/`Content-Length`
> 只出现在 body 的 `headers` 中，避免与 JSON 信封自身的 `Content-Type` 冲突；
> HTTP 状态码、`Accept-Ranges` 与单段/416 的 `Content-Range` 会作为真实响应头回显。

---

## 状态码与错误

| 状态 | code | 触发条件 |
| --- | --- | --- |
| `206` | — | 至少有一个可满足范围 |
| `400` | `RANGE_HEADER_REQUIRED` | 缺少 / 为空的 `Range` 头 |
| `400` | `MALFORMED_RANGE` | Range 语法非法（非 `bytes=<spec>`、`a-b`、孤立 `-` 等） |
| `400` | `UNSUPPORTED_RANGE_UNIT` | 非 `bytes` 单位（如 `items=0-10`） |
| `400` | `SIZE_REQUIRED` / `INVALID_SIZE` | 缺少 `size` 或不是合法非负整数 |
| `400` | `INVALID_CONTENT_TYPE` | `contentType` 不是合法媒体类型（并拒绝 CRLF） |
| `416` | `RANGE_NOT_SATISFIABLE` | 没有任何范围与资源重叠；响应头带 `Content-Range: bytes */<size>` |
| `422` | `TOO_MANY_RANGES` | 可满足范围段数（合并前）超过 16 |
| `422` | `TRANSFER_TOO_LARGE` | 合并前各段字节总和超过 `size × 2` |

416 示例：

```
HTTP/1.1 416 Range Not Satisfiable
content-range: bytes */1000
accept-ranges: bytes
```
```json
{ "statusCode": 416, "error": "RANGE_NOT_SATISFIABLE",
  "message": "None of the requested byte ranges overlap the representation.",
  "contentRange": "bytes */1000", "requestedRange": "bytes=5000-", "resourceSize": 1000 }
```

---

## RFC 9110 行为细则

- **夹取**：`last-byte-pos ≥ size` 时取 `size-1`（`bytes=900-99999` → `900-(size-1)`）。
- **后缀超长**：后缀长度 ≥ 资源长度时覆盖整个资源
  （`bytes=-5000` 作用于 1000 字节资源 → `bytes 0-999/1000`，RFC §14.1.2.1）。
- **丢弃不可满足项**：多区间中如某项起点 ≥ `size` 或反转区间（`10-5`），仅丢弃该项，
  其余正常处理；若全部被丢弃则为 416。
- **合并**：对可满足、夹取后的区间按字节序扫描，重叠或相邻
  （`next.start === prev.end + 1`）即合并，输出与请求顺序无关、确定。
- **防护计数时机**：段数与字节数均在**合并前**按“可满足且已夹取”的区间统计，
  防止用大量重复 / 重叠区间绕过限制。`size = 0` 时任何范围都不可满足（416），
  字节倍率检查自动跳过。

---

## 必要配置

均为可选环境变量，默认值即可直接运行：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | 监听端口 |
| `HOST` | `0.0.0.0` | 绑定地址 |
| `MAX_RANGES` | `16` | 单请求允许的最大可满足范围段数（超出 422） |
| `MAX_BYTES_MULTIPLIER` | `2` | 规划字节相对资源大小的最大倍数（超出 422） |

Compose 中通过 `ports: ["3000:3000"]` 发布端口；如需改宿主机端口，例如 8080，
改为 `"8080:3000"` 即可（容器内仍为 `PORT=3000`）。

---

## 开发与测试

```bash
npm install
npm test     # node:test，35 个用例，覆盖解析/夹取/丢弃/合并 + 全部 HTTP 状态
npm run dev  # --watch 模式启动
```

## 目录结构

```
src/
  server.js     # 启动入口（listen）
  app.js        # Fastify 路由与错误处理
  ranges.js     # Range 头解析（range-parser）与区间合并
  planner.js    # 响应规划、422 防护、确定性 multipart 边界
  config.js     # 环境变量配置
  httpError.js  # 结构化错误
test/
  ranges.test.js
  http.test.js
Dockerfile
docker-compose.yml
```
