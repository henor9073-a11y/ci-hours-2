# 统一日历要加的两个接口

这份**替代**之前那份 `DAILY_RECORDS_API_PATCH.md`——那份是"日程"和"每日记录"分开两个标签页的旧设计。现在改成一个统一的"日历"标签，日程和每日总结用同一个月历显示，所以接口也合并成新的两个，请按这份来，不用管旧的那份了。

同样是"补丁"式的：不管 `server.js` 现在长什么样，只要是 Express 写的，跟着下面两步手动加。

## 第一步：顶部加两行 import

跟其他 `import ... from './lib/xxx.js'` 放在一起，加这两行（如果已经有从这两个文件导入东西的行，就把新的名字加进现有的花括号里，不用重复写一行）：

```js
import { getDailySummariesByMonth, getTranscriptById } from './lib/transcripts.js';
import { getScheduleByMonth, getScheduleForDate } from './lib/schedule.js';
```

## 第二步：加两个路由

找到其他 `app.get('/api/...')` 写在一起的地方，加这两个：

```js
app.get('/api/calendar', (req, res) => {
  const month = req.query.month || new Date().toISOString().slice(0, 7);
  const daily = getDailySummariesByMonth(month);
  const schedule = getScheduleByMonth(month);
  const byDate = {};
  const bucket = d => (byDate[d] = byDate[d] || { date: d, daily: [], schedule: [] });
  daily.forEach(x => bucket(x.date).daily.push(x));
  schedule.forEach(x => bucket(x.date).schedule.push(x));
  res.json(Object.values(byDate).sort((a, b) => a.date.localeCompare(b.date)));
});

app.get('/api/calendar/day', (req, res) => {
  const date = req.query.date;
  if (!date) return res.status(400).json({ error: 'date 必填' });
  const daily = getDailySummariesByMonth(date.slice(0, 7))
    .filter(x => x.date === date)
    .map(x => getTranscriptById(x.id));
  const schedule = getScheduleForDate(date);
  res.json({ date, daily, schedule });
});
```

放在 `app.listen(...)` 之前的任何位置就行，不需要放在特定顺序。

这两个新接口不会动到已经在用的 `/api/schedule`（加日程、完成、移除还是走原来那几个接口），所以不影响"棋子的生活"那部分本来能用的功能。

## 部署

这次一共要传这几个文件到 GitHub：
- `server.js`（改过的，加了上面两段）
- `lib/schedule.js`（新加了 `getScheduleByMonth` 和 `getScheduleForDate` 两个函数，其他没变）
- `lib/transcripts.js`（跟之前给的一样，已经有 `getDailySummariesByMonth`）
- `public/index.html`（改过的，日历标签页合并了日程和每日记录）

传完之后，Render 手动 Deploy。

## 部署完之后

去网页看一下，导航栏里"日程"和"每日记录"两个标签变成了一个"日历"。点进去先是当月的月历，有记录的日子会带小圆点——绿色圆点是那天有辞写的总结，紫色圆点是那天有日程。点某一天，下面会同时显示那天的总结和日程，日程还能标完成/移除。日历下面有个小表单，点了某天之后日期会自动填好，可以直接给那天加日程。
