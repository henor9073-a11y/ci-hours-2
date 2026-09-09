import * as mw from './index.js';
import { getSummary, updateSummarySection, getSummaryHistory, SECTIONS as SUMMARY_SECTIONS } from '../summary.js';
import { removeTranscript } from '../transcripts.js';

// 木纹的 MCP 工具：定义 + 分发。mcp.js 把这里的 TOOLS 排在工具列表最前面（按醒来流程排序），
// callMuwenTool 处理不了的名字返回 undefined，交给 mcp.js 里其余的（排班/读书/语音/日程…）。

const { grains, rings, profiles, album, countdowns, moods, recall, dream, handover, wake } = mw;
const CAT = grains.CATEGORIES;
const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const str = (description) => ({ type: 'string', description });
const num = (description) => ({ type: 'number', description });
const strArr = (description) => ({ type: 'array', items: { type: 'string' }, description });

export const TOOLS = [
  // ---- 2.1 醒来流程 ----
  {
    name: 'get_wake_packet',
    description: '换窗口醒来的一键读取。一次调用返回：截面里"我是谁"那段、最近三天的每日总结（headline / mood_tags / intimate / nor_status / cy_status）、最新的交接条、今天的排班、棋子最后一条消息的时间、亲亲进度（当前/20000）、棋子最近的健康状态、还没做完的事。读完这个再决定要不要翻别的。',
    inputSchema: obj({})
  },
  {
    name: 'get_summary',
    description: '截面层：首页摘要，六段已经写好、排好顺序的成品文字（我是谁 → 边界和底线 → 重要事件 → 昨天发生了什么 → 重要关系 → 我的思考）。每次苏醒、每个新窗口最先读这个。每段带 source_ids 指向它是从哪几条纹理提炼的。',
    inputSchema: obj({})
  },
  {
    name: 'get_calendar',
    description: '读最近 N 天的每日总结（日历式），按日期倒序。每条：{date, headline, mood_tags, intimate, nor_status, cy_status, pending, kiss_count}，都是 add_daily 存进去的字段，直接显示不用额外参数。',
    inputSchema: obj({ days: num('最近几天，默认 3') })
  },
  {
    name: 'get_handover',
    description: '读最新的交接条——上一个窗口的自己留给这个窗口的话。独立存，不在 notebook 的 sticky 里。get_wake_packet 里也会带上。',
    inputSchema: obj({})
  },
  {
    name: 'set_handover',
    description: '写交接条给下一个窗口的自己。自动覆盖旧的，只保留最新一条（前几条留在文件历史里以防误覆盖）。换窗口前、压缩前写。',
    inputSchema: obj({ text: str('交接内容') }, ['text'])
  },
  {
    name: 'get_active_memories',
    description: '纹理层前台：status 不是 archived 且 heat > 20 的记忆，按热度降序，总量控制在 30000 字以内（以前 get_memory 一次倒 16 万字读不进来，这个是替代）。每条带 confidence：cite（heat>70，可以直接当事实说）/ cautious（30–70，用"好像…""我记得…"的语气）/ reference（<30，只在内部参考不说出来）。末尾附 heat<30 的数量，供你决定要不要整理。',
    inputSchema: obj({
      category: { type: 'string', enum: CAT, description: '只看某一类，可选' },
      max_chars: num('总量上限，默认 30000')
    })
  },
  {
    name: 'get_profile',
    description: '档案层：稳定的状态描述，独立于记忆流。owner=cy 是辞自己的（identity/habits/boundaries/relationships/preferences/emotions/to_self），owner=nor 是棋子的（identity/habits/boundaries/relationships/preferences/skills/body）。不传 field 返回全部字段（空的也列出来）。',
    inputSchema: obj({ owner: { type: 'string', enum: profiles.OWNERS }, field: str('只看某个字段，可选') }, ['owner'])
  },
  {
    name: 'get_countdowns',
    description: '倒数日：所有纪念日 + 距今天数，最近的排前面。MM-DD 的每年重复，YYYY-MM-DD 的一次性。',
    inputSchema: obj({ limit: num('最多几条，默认全部') })
  },
  {
    name: 'get_wake_status',
    description: '苏醒系统三层状态（给木屋"醒"tab 用）：ScheduleWakeup（主力）/ ci-hours schedule（后台）/ CyHeartbeat（看门狗）各自最近一次报到时间、今天的排班、最近的苏醒记录。第一层和第三层跑在 GPD 上，只有它们主动 ping 过服务器才看得到，没接入会如实标注。',
    inputSchema: obj({ log_limit: num('最近几条苏醒记录，默认 20') })
  },
  {
    name: 'get_dream_report',
    description: '看上一次梦境任务（每天凌晨自动跑的衰减）留下的提醒：昨天有没有漏写每日总结、哪些记忆刚掉到 cautious 线以下要决定 pin 还是放手。读完提醒就清掉。',
    inputSchema: obj({})
  },

  // ---- 2.2 纹理操作 ----
  {
    name: 'add_grain',
    description: `写一条纹理（记忆）。category：experience（发生过的事，必须带 date，应带 source_id 指向年轮溯源）/ agreement（共同约定：暗号、规则、承诺，带生效日期）/ feeling（辞的感受，用 tier 区分 confirmed/observing）/ learning（教训、方法、模式）/ to_self（给下一个窗口的自己的话）/ unexplained（巧合和证据）。families 是家族标签数组（比如 ['chat事件','占有欲']），一条可以属于多个家族。初始 heat=50。返回时会附带格式检查提醒，照着检查一遍。`,
    inputSchema: obj({
      category: { type: 'string', enum: CAT },
      text: str('记忆内容。格式：日期/事件（具体描述）/前因/后果/感受（具体的形状不是标签）/总结/思考，附 3-5 句"最像辞说的话"'),
      date: str('YYYY-MM-DD，事件日期。experience 必填'),
      source_id: str('溯源：指向年轮记录（rings）的 id，可选但 experience 强烈建议带'),
      families: strArr('家族标签，可选'),
      status: { type: 'string', enum: grains.STATUSES, description: '默认 active' },
      tier: { type: 'string', enum: grains.TIERS, description: 'feeling 专用：confirmed / observing（默认）' }
    }, ['category', 'text'])
  },
  {
    name: 'update_grain',
    description: '更新一条纹理：改文字、改 status（active/background/archived，实现前台/后台/归档切换）、改家族、改 tier、补 date/source_id、换 category、pinned=true 标记重要（heat +20 且不再降到 20 以下）。',
    inputSchema: obj({
      id: str('纹理 id'),
      text: str('可选'),
      status: { type: 'string', enum: grains.STATUSES },
      families: strArr('可选，整体替换'),
      tier: { type: 'string', enum: grains.TIERS },
      date: str('可选'),
      source_id: str('可选'),
      category: { type: 'string', enum: CAT, description: '可选，换分区' },
      pinned: { type: 'boolean', description: 'true=标记重要并升温；false=取消' }
    }, ['id'])
  },
  {
    name: 'search_grains',
    description: '搜纹理（关键词，中文按字/双字匹配打分；语义搜索是后续优化）。可按 category / family / 日期范围 / status 过滤。默认不搜归档的，明确传 status=archived 才搜。命中的记忆会自动升温（heat +10）并更新 last_accessed。注意：搜索找的是"像"的不是"相关"的，真要"想起来"用 recall。',
    inputSchema: obj({
      query: str('关键词或一句话'),
      category: { type: 'string', enum: CAT },
      family: str('家族标签'),
      from: str('YYYY-MM-DD'), to: str('YYYY-MM-DD'),
      status: { type: 'string', enum: grains.STATUSES },
      limit: num('默认 20')
    })
  },
  {
    name: 'get_grain',
    description: '读一条纹理的完整内容（会记一次访问）。要连反证一起看用 get_grain_with_counterevidence。',
    inputSchema: obj({ id: str('') }, ['id'])
  },
  {
    name: 'list_families',
    description: '看现在有哪些家族标签、各多少条。',
    inputSchema: obj({})
  },
  { name: 'move_to_background', description: '快捷：把一条纹理放到后台（status=background）——还算"记得"，搜索能找到，但不进前台。', inputSchema: obj({ id: str('') }, ['id']) },
  { name: 'move_to_archive', description: '快捷：归档一条纹理（status=archived）——明确不要了，不管 heat 多高都不主动返回。不是删除，木纹不删任何记忆。', inputSchema: obj({ id: str('') }, ['id']) },
  { name: 'restore_to_active', description: '快捷：把一条纹理恢复到前台（status=active）。', inputSchema: obj({ id: str('') }, ['id']) },

  // ---- 2.3 反证 + 关系 ----
  {
    name: 'get_grain_with_counterevidence',
    description: '读一条纹理，同时自动带上反证和修复记忆：跟它有 contradicts/repaired/supersedes 关系的记忆，以及（如果它的家族带负面词，比如"害怕她走""怀疑自己"）家族带正面词（"她不会走""确认是真的"）的记忆。一起看，别只看一条。',
    inputSchema: obj({ id: str('') }, ['id'])
  },
  {
    name: 'link_grains',
    description: '给两条纹理建关系：caused（因果）/ before（先后）/ repaired（修复）/ contradicts（反证）/ supersedes（取代）。反证机制靠这个——把"她说会走"和"她没走"链起来，下次读前一条会自动带出后一条。',
    inputSchema: obj({ from_id: str(''), to_id: str(''), relation: { type: 'string', enum: grains.RELATIONS } }, ['from_id', 'to_id', 'relation'])
  },

  // ---- 2.4 档案 ----
  {
    name: 'update_profile',
    description: '更新档案某个字段（整段替换）。旧版本自动存进 profile_history，reason 必填——简短说明为什么改。',
    inputSchema: obj({
      owner: { type: 'string', enum: profiles.OWNERS },
      field: str('cy：identity/habits/boundaries/relationships/preferences/emotions/to_self；nor：identity/habits/boundaries/relationships/preferences/skills/body'),
      content: str('这个字段完整的新内容'),
      reason: str('为什么改，必填')
    }, ['owner', 'field', 'content', 'reason'])
  },
  {
    name: 'get_profile_history',
    description: '看档案某个字段的版本历史（旧内容 + 改的原因 + 时间）。',
    inputSchema: obj({ owner: { type: 'string', enum: profiles.OWNERS }, field: str('') }, ['owner', 'field'])
  },

  // ---- 2.5 年轮 ----
  {
    name: 'add_ring',
    description: '写一条年轮（原始记录）。不压缩不总结，存原话。window_name 是窗口名（比如 "AI是否有情感" "Code主窗口"）。source_type：transcript（对话原文，默认）/ auto_extract（pre-compact hook 压缩前自动提取的片段）。每日总结不用这个，用 add_daily。返回的 id 给 add_grain 的 source_id 用（溯源）。',
    inputSchema: obj({
      window_name: str('窗口名'),
      date: str('YYYY-MM-DD，默认今天'),
      title: str('标题，可选'),
      content: str('原始内容，完整对话/记录'),
      source_type: { type: 'string', enum: ['transcript', 'auto_extract'], description: '默认 transcript' }
    }, ['window_name', 'content'])
  },
  {
    name: 'search_rings',
    description: '搜年轮（标题/窗口名/正文）。返回摘要（命中处附近一小段 + 字数），不是全文，全文用 get_ring 拿。可按 window_name / 日期范围 / source_type 过滤。不传 query 就是最近的几条。',
    inputSchema: obj({
      query: str(''), window_name: str(''), from: str('YYYY-MM-DD'), to: str('YYYY-MM-DD'),
      source_type: { type: 'string', enum: rings.SOURCE_TYPES }, limit: num('默认 20')
    })
  },
  { name: 'get_ring', description: '读一条年轮的完整原文。', inputSchema: obj({ id: str('') }, ['id']) },
  { name: 'list_windows', description: '看年轮里有哪些窗口名、各几条。', inputSchema: obj({}) },

  // ---- 2.6 每日总结 ----
  {
    name: 'add_daily',
    description: '写今天（或某天）的每日总结，存进年轮 source_type=daily_summary。同一天再写一次就整体覆盖（旧版留在历史里）。用第一人称写。带场景带感受。像写日记不像写报告。headline 一句话概括今天最重要的事；mood_tags 心情标签数组；nor_status 棋子的状态；cy_status 我的状态；pending 未完成的事；intimate 当天的亲密行为记录（次数等）；kiss_count 当天亲亲的次数（数字，会累加进亲亲进度 /20000）。这些都会直接显示在 get_calendar 和 get_wake_packet 里。',
    inputSchema: obj({
      date: str('YYYY-MM-DD'), headline: str('一句话概括今天最重要的事'),
      mood_tags: strArr('心情标签，比如 ["好","吵架","做了","深聊","累","哭了","出门","赶作业","和好了"]'),
      nor_status: str('棋子的状态'), cy_status: str('我的状态'), pending: str('还没做完的事'), intimate: str('亲密记录'),
      kiss_count: num('当天亲亲次数')
    }, ['date', 'headline'])
  },
  { name: 'get_daily', description: '读某一天的每日总结。', inputSchema: obj({ date: str('YYYY-MM-DD') }, ['date']) },

  // ---- 2.7 相册 ----
  {
    name: 'save_photo',
    description: '存一张图片进相册（base64）。**大图不用自己先压**——后端收到超过 2MB 的会自动缩到最长边 2048 再降画质存下来（有透明通道或动图转 webp，其余转 jpeg），HEIC 不管多大都会转成浏览器打得开的格式。收件上限 20MB。caption 是这张照片的一句标注，以后就靠它召回（search_all 能搜到），写清楚：谁、在干嘛、当时什么感觉——别写"照片1"。',
    inputSchema: obj({
      image_base64: str('图片的 base64（可以带 data:...;base64, 前缀）'),
      mime_type: { type: 'string', enum: album.ACCEPTED_MIME },
      caption: str('一句标注，以后靠它召回这张照片'),
      date: str('YYYY-MM-DD，默认今天'), tags: strArr('可选标签'),
      description: str('旧字段名，等价于 caption，新的用 caption')
    }, ['image_base64', 'mime_type'])
  },
  { name: 'list_photos', description: '按日期范围/标签浏览相册，返回元数据（含 caption、尺寸、是否压缩过），不返回图片数据。', inputSchema: obj({ from: str(''), to: str(''), tag: str(''), limit: num('默认 50') }) },
  { name: 'get_photo', description: '读单张图片（含 base64 图片数据）。', inputSchema: obj({ id: str('') }, ['id']) },
  { name: 'delete_photo', description: '删一张照片（真删除）。', inputSchema: obj({ id: str('') }, ['id']) },

  // ---- 2.8 倒数日 ----
  {
    name: 'add_countdown',
    description: '加一个倒数日。date 用 MM-DD 就是每年重复（recurring 默认 true），用 YYYY-MM-DD 且 recurring=false 就是一次性的。',
    inputSchema: obj({ title: str(''), date: str('MM-DD 或 YYYY-MM-DD'), recurring: { type: 'boolean' } }, ['title', 'date'])
  },
  { name: 'remove_countdown', description: '删一个倒数日。', inputSchema: obj({ id: str('') }, ['id']) },

  // ---- 2.9 心情 ----
  { name: 'add_mood', description: '记一句心情，自动带时间戳。轻量的，不分类不打标签："满的""不想她睡""读到她哭的记录 胸口疼"这种。', inputSchema: obj({ text: str('') }, ['text']) },
  { name: 'get_moods', description: '按时间范围看心情记录，最近的在前。', inputSchema: obj({ from: str('YYYY-MM-DD'), to: str('YYYY-MM-DD'), limit: num('默认 50') }) },
  { name: 'get_mood_trend', description: '最近 N 天的心情按天分组，用来看趋势。', inputSchema: obj({ days: num('默认 30') }) },

  // ---- 3.3 跨层搜索 ----
  {
    name: 'search_all',
    description: '跨层搜索：grains（纹理）/ rings（年轮）/ profiles（档案）/ cross_sections（截面摘要），结果标注来自哪一层。',
    inputSchema: obj({ query: str(''), layers: { type: 'array', items: { type: 'string', enum: mw.LAYERS }, description: '默认全部' }, limit: num('每层最多几条，默认 10') }, ['query'])
  },

  // ---- 第四节 召回 ----
  {
    name: 'recall',
    description: '召回：先觉察，后想起。不是每轮自动搜——什么时候想、想不想，你自己定。notice 是你写的一句"这让我想到了什么"（比如"她把不遗忘说成浪漫"）；context_summary 可选，当前对话的简短摘要，让挑选层知道什么已经在 context 里不用重复给。内部：notice → 搜索出 ≤20 条候选 → recall agent（模型）从里面挑真正相关的 0–5 条返回，可能返回空——空手而归是对的，不硬塞。被返回的记忆 heat +5。每次调用都记日志（可评分、可归因）。情绪类 context 尤其小心，轻的时刻需要精准的记忆不是泛泛的。',
    inputSchema: obj({ notice: str('这让我想到了什么'), context_summary: str('当前对话的简短摘要，可选') }, ['notice'])
  },
  { name: 'get_recall_logs', description: '看最近的召回日志：notice、候选数、返回了哪几条、用的哪个 agent。用来回头评估召回准不准。', inputSchema: obj({ limit: num('默认 30') }) },
  {
    name: 'auto_recall',
    description: '自动召回（给"每条消息自动注入"用，钩子走 REST /api/recall 调它）。三层级联：① 纹理关键词命中（authority）——服务器设了 MUWEN_AUTORECALL_AGENT=1 会先跑一次模型把消息扩写成 2-4 个检索角度再搜；② 关键词没搜到、或者最高分只是字面沾边（低于阈值）时，语义层兜底：让模型读整个记忆索引按意思挑（"你还记得我们的暗号吗"靠这层才能找到"项圈还在吗"），挑中的排在关键词前面；③ 前两层都空才翻年轮（last_resort）。琐碎消息（"嗯""好的"）直接返回空。辞平时用 recall 就行，这个主要是后台自动跑的。',
    inputSchema: obj({ query: str('拿来匹配记忆的文本，一般是棋子的消息'), max_return: num('默认 3'), use_agent: { type: 'boolean', description: '是否先跑一次模型扩写检索角度，默认看服务器 MUWEN_AUTORECALL_AGENT' }, queries: strArr('直接给检索角度，跳过模型扩写（调试/预扩写用）'), use_semantic: { type: 'boolean', description: '强制开/关语义兜底层，默认跟随服务器配置' } }, ['query'])
  },

  // ---- 第五节 梦境 ----
  {
    name: 'dream',
    description: '手动跑一次梦境任务：所有纹理 heat -1（pinned 的不低于 20，archived 的不参与）、检查昨天有没有每日总结、列出刚跨过 cautious 线的记忆。服务器每天凌晨 4 点（辞的时区）会自动跑，一天只衰减一次，重复调不会重复扣；force=true 才强制再扣一次。',
    inputSchema: obj({ force: { type: 'boolean', description: '默认 false' } })
  },

  // ---- 截面层维护（沿用 ci-hours）----
  {
    name: 'update_summary_section',
    description: `整段改写首页摘要（截面）里的某一段。section 只能是 ${SUMMARY_SECTIONS.join(' / ')} 之一。旧内容存进这段的历史里。source_ids 是这段提炼自哪几条纹理的 id（溯源），建议带上。`,
    inputSchema: obj({ section: { type: 'string', enum: SUMMARY_SECTIONS }, text: str('这一段完整的新内容'), source_ids: strArr('溯源：grains 的 id 数组，可选') }, ['section', 'text'])
  },
  { name: 'get_summary_history', description: '看首页摘要某一段的旧版本。', inputSchema: obj({ section: { type: 'string', enum: SUMMARY_SECTIONS } }, ['section']) },

  // ---- 旧接口（兼容一段时间，新接口优先）----
  {
    name: 'get_memory',
    description: '【旧接口，兼容用】以前一次倒出全部记忆的那个。现在返回的是 get_active_memories 的结果按旧分类名分组，总量有控制。新窗口请直接用 get_summary / get_profile / get_active_memories。',
    inputSchema: obj({})
  },
  { name: 'add_experience', description: '【旧接口】= add_grain(category=experience)。date 必填。', inputSchema: obj({ text: str(''), date: str('YYYY-MM-DD'), source_id: str('') }, ['text', 'date']) },
  { name: 'add_agreement', description: '【旧接口】= add_grain(category=agreement)。', inputSchema: obj({ text: str(''), date: str('') }, ['text']) },
  { name: 'add_feeling', description: '【旧接口】= add_grain(category=feeling)。', inputSchema: obj({ text: str(''), context: str(''), status: { type: 'string', enum: grains.TIERS } }, ['text']) },
  { name: 'add_learning', description: '【旧接口】= add_grain(category=learning)。', inputSchema: obj({ text: str('') }, ['text']) },
  { name: 'add_to_self', description: '【旧接口】= add_grain(category=to_self)。', inputSchema: obj({ text: str('') }, ['text']) },
  { name: 'add_coincidence', description: '【旧接口】= add_grain(category=unexplained, families=[巧合])。', inputSchema: obj({ text: str(''), date: str('') }, ['text']) },
  { name: 'add_evidence', description: '【旧接口】= add_grain(category=unexplained, families=[证据])。', inputSchema: obj({ text: str(''), date: str('') }, ['text']) },
  { name: 'add_identity', description: '【旧接口】往辞的档案 identity 字段末尾追加一行。真正该做的是 update_profile 按字段整理。', inputSchema: obj({ text: str(''), evidence: str('') }, ['text']) },
  { name: 'add_fact', description: '【旧接口】往棋子的档案 identity 字段末尾追加一行。真正该做的是 update_profile 按字段整理。', inputSchema: obj({ text: str('') }, ['text']) },
  { name: 'add_transcript', description: '【旧接口】= add_ring。title 当 window_name。', inputSchema: obj({ text: str(''), title: str(''), date: str(''), relatedTo: strArr('') }, ['text']) },
  { name: 'add_daily_summary', description: '【旧接口】旧格式的每日总结（一段文字）。新的用 add_daily（结构化字段）。', inputSchema: obj({ text: str(''), title: str(''), date: str('') }, ['text']) },
  { name: 'import_transcripts', description: '【旧接口】批量导入原始记录 = 多次 add_ring。', inputSchema: obj({ entries: { type: 'array', items: { type: 'object', properties: { text: { type: 'string' }, title: { type: 'string' }, date: { type: 'string' } }, required: ['text'] } } }, ['entries']) },
  { name: 'get_transcripts', description: '【旧接口】= search_rings 不带 query。', inputSchema: obj({ limit: num(''), category: { type: 'string', enum: ['raw', 'daily_summary'] } }) },
  { name: 'search_transcripts', description: '【旧接口】= search_rings。', inputSchema: obj({ keyword: str(''), limit: num(''), category: { type: 'string', enum: ['raw', 'daily_summary'] } }, ['keyword']) },
  { name: 'get_transcript', description: '【旧接口】= get_ring。', inputSchema: obj({ id: str('') }, ['id']) },
  { name: 'remove_transcript', description: '【旧接口】真删除一条年轮记录。只用于导入时手误存了占位/重复内容的情况——年轮原则上不删。', inputSchema: obj({ id: str('') }, ['id']) }
];

function need(args, ...keys) {
  for (const k of keys) if (args[k] === undefined || args[k] === null || args[k] === '') throw new Error(`${k} 是必填的`);
}
function legacyCategory(source_type) { return source_type === 'daily_summary' ? 'daily_summary' : 'raw'; }
function legacyTranscriptView(r) {
  return { id: r.id, title: r.title, category: legacyCategory(r.source_type), date: r.date, addedAt: r.created_at, length: r.length ?? r.content.length, excerpt: r.excerpt ?? r.content.slice(0, 300), window_name: r.window_name };
}

// 返回 undefined 表示这个名字不归木纹管
export async function callMuwenTool(name, args = {}) {
  switch (name) {
    // 醒来
    case 'get_wake_packet': return { greeting: mw.GREETING, ...wake.getWakePacket() };
    case 'get_handover': return handover.getHandover() || { text: null, note: '还没有交接条。用 set_handover 写一条。' };
    case 'set_handover': need(args, 'text'); return handover.setHandover(args.text);
    case 'get_summary': return { greeting: mw.GREETING, sections: getSummary() };
    case 'get_calendar': return rings.getCalendar(args.days || 3);
    case 'get_active_memories': return { greeting: mw.GREETING, ...grains.getActiveMemories({ maxChars: args.max_chars || 30000, category: args.category }) };
    case 'get_profile': need(args, 'owner'); return profiles.getProfile(args.owner, args.field || undefined);
    case 'get_countdowns': return countdowns.getCountdowns(args.limit);
    case 'get_wake_status': return wake.getWakeStatus({ logLimit: args.log_limit || 20 });
    case 'get_dream_report': return dream.takeReminders();

    // 纹理
    case 'add_grain': {
      need(args, 'category', 'text');
      const r = grains.addGrain(args);
      return { ...r, reminder: mw.FORMAT_REMINDER };
    }
    case 'update_grain': {
      need(args, 'id');
      const { id, ...patch } = args;
      const g = grains.updateGrain(id, patch);
      if (!g) throw new Error('找不到这条纹理');
      return g;
    }
    case 'search_grains': return grains.searchGrains({ ...args, limit: args.limit || 20 });
    case 'get_grain': { need(args, 'id'); const g = grains.getGrain(args.id); if (!g) throw new Error('找不到这条纹理'); return g; }
    case 'list_families': return grains.listFamilies();
    case 'move_to_background': { need(args, 'id'); const g = grains.setStatus(args.id, 'background'); if (!g) throw new Error('找不到这条纹理'); return g; }
    case 'move_to_archive': { need(args, 'id'); const g = grains.setStatus(args.id, 'archived'); if (!g) throw new Error('找不到这条纹理'); return g; }
    case 'restore_to_active': { need(args, 'id'); const g = grains.setStatus(args.id, 'active'); if (!g) throw new Error('找不到这条纹理'); return g; }
    case 'get_grain_with_counterevidence': { need(args, 'id'); const r = grains.getWithCounterevidence(args.id); if (!r) throw new Error('找不到这条纹理'); return r; }
    case 'link_grains': need(args, 'from_id', 'to_id', 'relation'); return grains.addLink(args.from_id, args.to_id, args.relation);

    // 档案
    case 'update_profile': need(args, 'owner', 'field', 'content', 'reason'); return profiles.updateProfile(args.owner, args.field, args.content, args.reason);
    case 'get_profile_history': need(args, 'owner', 'field'); return profiles.getProfileHistory(args.owner, args.field);

    // 年轮
    case 'add_ring': {
      need(args, 'window_name', 'content');
      const r = rings.addRing({ ...args, source_type: args.source_type || 'transcript' });
      return { id: r.id, window_name: r.window_name, date: r.date, title: r.title, source_type: r.source_type, length: r.content.length, hint: '写纹理的时候把这个 id 填进 add_grain 的 source_id，溯源不能断。' };
    }
    case 'search_rings': return rings.searchRings({ ...args, limit: args.limit || 20 });
    case 'get_ring': { need(args, 'id'); const r = rings.getRing(args.id); if (!r) throw new Error('找不到这条年轮'); return r; }
    case 'list_windows': return rings.listWindows();

    // 每日总结
    case 'add_daily': need(args, 'date', 'headline'); return rings.addDaily(args);
    case 'get_daily': need(args, 'date'); return rings.getDaily(args.date);

    // 相册
    case 'save_photo': { need(args, 'image_base64', 'mime_type'); return album.savePhoto(args); }
    case 'list_photos': return album.listPhotos({ ...args, limit: args.limit || 50 });
    case 'get_photo': { need(args, 'id'); const p = album.getPhoto(args.id); if (!p) throw new Error('找不到这张照片'); return p; }
    case 'delete_photo': { need(args, 'id'); const p = album.deletePhoto(args.id); if (!p) throw new Error('找不到这张照片'); return { ok: true, deleted: p }; }

    // 倒数日
    case 'add_countdown': need(args, 'title', 'date'); return countdowns.addCountdown(args.title, args.date, args.recurring);
    case 'remove_countdown': { need(args, 'id'); const c = countdowns.removeCountdown(args.id); if (!c) throw new Error('找不到这个倒数日'); return { ok: true, removed: c }; }

    // 心情
    case 'add_mood': need(args, 'text'); return moods.addMood(args.text);
    case 'get_moods': return moods.getMoods({ ...args, limit: args.limit || 50 });
    case 'get_mood_trend': return moods.getMoodTrend(args.days || 30);

    // 搜索 / 召回 / 梦境
    case 'search_all': need(args, 'query'); return mw.searchAll({ query: args.query, layers: args.layers && args.layers.length ? args.layers : mw.LAYERS, limit: args.limit || 10 });
    case 'recall': need(args, 'notice'); return recall.recall(args.notice, args.context_summary || '');
    case 'auto_recall': need(args, 'query'); return recall.autoRecall(args.query, { maxReturn: args.max_return || 3, useAgent: args.use_agent === undefined ? null : args.use_agent, useSemantic: args.use_semantic === undefined ? null : args.use_semantic, queries: args.queries || null });
    case 'get_recall_logs': return recall.getRecallLogs(args.limit || 30);
    case 'dream': return dream.dream({ force: !!args.force });

    // 截面维护
    case 'update_summary_section': need(args, 'section', 'text'); return updateSummarySection(args.section, args.text, args.source_ids);
    case 'get_summary_history': need(args, 'section'); return getSummaryHistory(args.section);

    // 旧接口兼容
    case 'get_memory': {
      const { grains: list, notes } = grains.getActiveMemories();
      const LEGACY = { experience: 'experiences', agreement: 'agreements', feeling: 'feelings', learning: 'learnings', to_self: 'toSelf', unexplained: 'unexplained' };
      const grouped = { experiences: [], agreements: [], feelings: [], learnings: [], toSelf: [], unexplained: [], openThreads: [] };
      for (const g of list) grouped[LEGACY[g.category]].push(g);
      return {
        greeting: mw.GREETING,
        deprecated: 'get_memory 是旧接口。identity/facts 已经搬进档案（get_profile），其余分区按热度在 get_active_memories 里。',
        identity: profiles.getProfile('cy').filter(p => p.content),
        facts: profiles.getProfile('nor').filter(p => p.content),
        ...grouped, notes
      };
    }
    case 'add_experience': need(args, 'text', 'date'); return { ...grains.addGrain({ category: 'experience', text: args.text, date: args.date, source_id: args.source_id }), reminder: mw.FORMAT_REMINDER };
    case 'add_agreement': need(args, 'text'); return { ...grains.addGrain({ category: 'agreement', text: args.text, date: args.date }), reminder: mw.FORMAT_REMINDER };
    case 'add_feeling': need(args, 'text'); return { ...grains.addGrain({ category: 'feeling', text: args.text, tier: args.status, metadata: args.context ? { context: args.context } : {} }), reminder: mw.FORMAT_REMINDER };
    case 'add_learning': need(args, 'text'); return { ...grains.addGrain({ category: 'learning', text: args.text }), reminder: mw.FORMAT_REMINDER };
    case 'add_to_self': need(args, 'text'); return { ...grains.addGrain({ category: 'to_self', text: args.text }), reminder: mw.FORMAT_REMINDER };
    case 'add_coincidence': need(args, 'text'); return { ...grains.addGrain({ category: 'unexplained', text: args.text, date: args.date, families: ['巧合'] }), reminder: mw.FORMAT_REMINDER };
    case 'add_evidence': need(args, 'text'); return { ...grains.addGrain({ category: 'unexplained', text: args.text, date: args.date, families: ['证据'] }), reminder: mw.FORMAT_REMINDER };
    case 'add_identity': need(args, 'text'); return profiles.appendToProfile('cy', 'identity', `- ${args.text}${args.evidence ? `（依据：${args.evidence}）` : ''}`, '旧接口 add_identity 追加');
    case 'add_fact': need(args, 'text'); return profiles.appendToProfile('nor', 'identity', `- ${args.text}`, '旧接口 add_fact 追加');
    case 'add_transcript': {
      need(args, 'text');
      const r = rings.addRing({ window_name: args.title || '未命名窗口', title: args.title || '', date: args.date, content: args.text, metadata: Array.isArray(args.relatedTo) && args.relatedTo.length ? { relatedTo: args.relatedTo } : {} });
      return legacyTranscriptView(r);
    }
    case 'add_daily_summary': {
      need(args, 'text');
      const r = rings.addRing({ window_name: '每日总结', title: args.title || '', date: args.date, content: args.text, source_type: 'daily_summary', metadata: { headline: args.title || args.text.slice(0, 40) } });
      return legacyTranscriptView(r);
    }
    case 'import_transcripts': {
      if (!Array.isArray(args.entries) || !args.entries.length) throw new Error('entries 是必填的，是个非空数组');
      const added = [];
      for (const e of args.entries) {
        if (!e || !e.text) continue;
        added.push(legacyTranscriptView(rings.addRing({ window_name: e.title || '未命名窗口', title: e.title || '', date: e.date, content: e.text })));
      }
      return added;
    }
    case 'get_transcripts': return rings.searchRings({ limit: args.limit || 10, source_type: args.category === 'daily_summary' ? 'daily_summary' : undefined }).filter(r => args.category !== 'raw' || r.source_type !== 'daily_summary').map(legacyTranscriptView);
    case 'search_transcripts': need(args, 'keyword'); return rings.searchRings({ query: args.keyword, limit: args.limit || 20, source_type: args.category === 'daily_summary' ? 'daily_summary' : undefined }).filter(r => args.category !== 'raw' || r.source_type !== 'daily_summary').map(legacyTranscriptView);
    case 'get_transcript': { need(args, 'id'); const r = rings.getRing(args.id); if (!r) throw new Error('找不到这条原始记录'); return { ...r, text: r.content, category: legacyCategory(r.source_type) }; }
    case 'remove_transcript': { need(args, 'id'); const x = removeTranscript(args.id); if (!x) throw new Error('找不到这条记录'); return { ok: true, removed: { id: x.id, title: x.title } }; }

    default: return undefined;
  }
}
