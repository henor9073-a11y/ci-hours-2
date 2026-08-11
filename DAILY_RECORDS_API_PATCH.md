# 每日记录日历要加的两个接口

因为我拿不到 Render 上真正在跑的那份 `server.js`（GitHub 上的 main 分支是旧的，缺了一大截），
不敢直接给你一整份文件覆盖——那样会把 `/api/memory`、`/api/schedule` 这些正在用的接口全删了。

所以这次是"补丁"式的：你去 Render 的 Shell 里，或者你本地保存的那份真正在跑的 `server.js`，
手动加下面这两段。不管这个文件现在长什么样，只要是 Express 写的，跟着下面两步做就行。

## 第一步：顶部加一行 import

跟其他 `import ... from './lib/xxx.js'` 放在一起，加这行：

```js
import { getDailySummariesByMonth, getTranscriptById } from './lib/transcripts.js';
```

（如果已经有一行在从 `./lib/transcripts.js` 导入东西了，就把 `getDailySummariesByMonth` 和
`getTranscriptById` 加进那一行现有的花括号里，不用重复写一行新的 import。）

## 第二步：加两个路由

找到其他 `app.get('/api/...')` 写在一起的地方，加这两个：

```js
app.get('/api/daily-records', (req, res) => {
  const month = req.query.month || new Date().toISOString().slice(0, 7);
  res.json(getDailySummariesByMonth(month));
});

app.get('/api/daily-records/:id', (req, res) => {
  const x = getTranscriptById(req.params.id);
  if (!x || x.category !== 'daily_summary') return res.status(404).json({ error: '找不到' });
  res.json(x);
});
```

放在 `app.listen(...)` 之前的任何位置就行，不需要放在特定顺序。

## 部署

跟平时一样：这份改完的 `server.js` 传到 GitHub（连同这次一起的 `lib/transcripts.js`、
`public/index.html`），Render 手动 Deploy。

## 部署完之后

去网页看一下新加的"日程""每日记录""健康"三个标签页正常不正常。"每日记录"那个日历现在
应该还是空的——之前存的那条"8月7日进展汇总"因为已经是 `daily_summary` 分类了，应该会
直接出现在 8 月的日历里。
