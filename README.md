# 金币争夺战 · Coin Rush（多人同屏打地鼠）

React 19 + Vite 前端，Node.js + `ws` WebSocket 后端，单进程内存状态。

## 运行

```bash
npm install
npm run dev        # 开发：后端 :3001 + Vite 前端 :5173（/ws、/api 已代理）
npm run build && npm start   # 生产：后端同时托管 dist/，访问 http://localhost:3001
npm test           # 单元 + WebSocket 集成测试（node:test）
npx playwright install chromium && npm run test:e2e   # 浏览器端到端测试
npm run typecheck
```

用多个浏览器窗口（或隐身窗口）输入同一个房间号即可多人对战。

## 功能对照

| 需求 | 实现 |
| --- | --- |
| 大厅：房间号 + 昵称 | `src/App.tsx` `Lobby`，前后端都会校验输入 |
| 首人进入开 30s 准备，满 5 人立即进入 3s 倒计时，30s 到点以当前人数开局 | `server/game.ts` `Room.add` / `Room.tick` |
| 游戏视图：顶部 60s 倒计时、左侧积分榜、中央 5×5 | `Room` / `Clock` / `Board` 组件，手机端积分榜横排 |
| 满员明确拒绝，加入时广播 | 第 6 人收到 `ROOM_FULL` 错误并留在大厅提示；加入/离开/断线都会广播 `notice` |
| 高频点击节流 / 状态锁 | `src/hitGuard.ts`：按金币 ID 加锁 + 全局 150ms 节流 |
| 乐观更新与回滚 | 点击后立即播放碎裂动画；判定为抢到 → 飞出 `+1`，判定为失败 → 变灰抖动显示“慢了一步”。**分数只来自服务端状态** |
| 并发锁 | 见下文 |
| 独立 Game Loop | `server/index.ts` 中 50ms 一次的 `setInterval` 驱动所有房间的 `tick()`，负责刷新/过期金币和切换阶段，变化时主动广播 |
| 心跳保活 | 每 10s 发一次 ping，30s 没收到 pong 的“僵尸”连接会被断开并移出房间；连上后 60s 仍未加入房间的连接也会被清理 |

## 并发计分：同一枚金币绝不给两个人加分

每枚金币都有唯一的 `coinId`（UUID）。`Room.hit()` 实际上是一次**内存级 compare-and-swap**：

```ts
if (!this.coin || this.coin.id !== coinId || now >= this.coin.expiresAt + grace) return 拒绝;
this.coin = null;      // 消耗掉这枚金币
player.score++;
```

Node.js 在单线程上逐条处理 WebSocket 消息，而“检查 ID → 置空 → 加分”这三步之间没有任何 `await`、I/O 或回调，
所以这一段是天然的临界区。A、B 两人相差 10ms 的两个请求一定按先后顺序执行，后到的请求看到的是
`coin === null`（或者已经换成新的 ID），只能被拒绝。测试 `tests/server.test.ts` 会让两个真实客户端
对同一枚金币各连发 3 次请求，断言每枚金币恰好只被接受 1 次。

**横向扩展时**（多个进程共享同一个房间）就不能再靠单线程了，有两种做法：

- Redis：`SET coin:{coinId} {playerId} NX PX 5000`，返回 OK 的那个请求才能加分（`INCR`），可以用 Lua 脚本把两步合成一个原子操作；
- 数据库乐观锁：`UPDATE coins SET taken_by=? WHERE id=? AND taken_by IS NULL`，只有影响行数为 1 时才加分。

更简单的办法是按房间号做一致性哈希，把同一个房间固定路由到同一个进程上，这样仍然可以沿用内存锁。

前端还有一层防护（`HitGuard`）：同一枚金币第一次点击后立即在本地锁定，收到判定之前（判定之后也一样）
后续点击全部忽略；另外全局最多 150ms 发一次请求。即使连点 10 次，也只会发出 1 个请求。
如果判定迟迟没回来（比如断线），2s 后自动解锁。

## 网络延迟：前端看到金币的时间 ≠ 服务端生成金币的时间

服务端在 `spawnedAt` 时刻生成金币，客户端要过大约 RTT/2 才收到；玩家点击之后，请求还要再花 RTT/2 才能送达服务端。
而且各客户端的本地时钟本来就可能相差好几秒。处理方式如下：

1. **时钟同步**（`src/clock.ts`）：做法类似 NTP。客户端发出 `sync{clientTime}`，服务端回带 `serverTime`。
   用 `offset = serverTime − (t0 + RTT/2)` 估算时钟差，并在最近 8 个样本里选 RTT 最小的那个
   （RTT 越小，上下行不对称造成的误差越小）。连上时连发 4 次，之后每 5s 校正一次。界面右上角会显示实时延迟。
2. **统一用服务端时间渲染**：所有倒计时和金币剩余寿命（金币外圈的进度环）都按 `deadline / expiresAt − 服务端当前时间`
   计算，而不是按“收到消息之后过了多久”来算。这样每个玩家看到的截止时刻都一样，延迟高的玩家看到的进度环只是起点更靠后。
3. **本地按时消失**：客户端根据同步后的时钟，在 `expiresAt` 时刻自己把金币隐藏掉，不用等服务端的广播（广播本身也晚 RTT/2 才到）。
4. **服务端宽限窗口（延迟补偿）**：`hitGraceMs = 150`。客户端在 `expiresAt` 前看到并点中的金币，请求到达服务端时可能已经过了截止时间，
   所以服务端在 `expiresAt + 150ms` 内仍然接受。这个窗口远小于下一枚金币的最短刷新间隔（1s），所以不会和新金币冲突；
   而且判定依然以“谁的请求先到服务端”为准，不信任客户端上报的时间戳，避免有人伪造时间作弊。
5. **状态版本号**：每份快照都带递增的 `version`，客户端丢弃旧版本，避免 `hit_result` 和广播乱序时分数来回跳。

## 生命周期 / 健壮性

- 主动离开或断线都会立即释放名额并广播；房间空了就回收；单个房间最多 5 人，服务器最多 1000 个房间。
- 断线后前端自动重连（指数退避），重连成功后用 token 重新加入。本局已经开始时，服务端会拒绝重新加入（`ROUND_STARTED`），前端回到大厅并给出提示。
- 刷新页面后会用 sessionStorage 里记录的房间号和昵称自动重新加入。
- 每个连接每秒最多 40 条消息，超过 80 条直接断开；单条消息最大 4KB；客户端发送缓冲积压超过 1MB 时断开该连接。
- 本局结束后，任意玩家都可以点“再来一局”，所有人的分数清零，房间回到准备阶段。

## 目录

```
shared/protocol.ts   前后端共享的消息类型
server/game.ts       房间状态机 + 计分（纯逻辑、可注入时间，便于测试）
server/index.ts      HTTP/WS 服务、game loop、心跳、限流
src/useGame.ts       WS 客户端：重连、时钟同步、版本过滤、乐观特效
src/hitGuard.ts      点击锁 + 节流
src/clock.ts         时钟偏移估算
src/App.tsx          大厅 / 对战 / 结算界面
tests/               node:test 单元与集成测试，tests/e2e 为 Playwright 测试
```
