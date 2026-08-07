// Bark 推送——api.day.app 是公网服务，Render 服务器直接就能调，一次请求就发完。
// 单独抽成一个文件是因为现在不止 mcp.js 的 send_push/speak 用它了，
// 日程模块的定时检查（server.js 里的 cron）也要直接推，不经过 MCP 那条路。
const BARK_KEY = process.env.BARK_KEY;

export async function sendPush(title, body, sound) {
  if (!BARK_KEY) throw new Error('服务器没设置 BARK_KEY 环境变量，先在 Render 里加一个');
  let url = `https://api.day.app/${BARK_KEY}/${encodeURIComponent(title)}/${encodeURIComponent(body)}`;
  if (sound) url += `?sound=${encodeURIComponent(sound)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Bark 推送失败：${res.status} ${await res.text().catch(() => '')}`);
  return { ok: true };
}
