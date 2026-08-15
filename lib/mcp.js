import {
  getState, getNotes, getLog,
  getShelf, getBookContent, setProgress, addNote, addLog
} from './store.js';
import {
  getMemory, getQuestions, askQuestion, replyToQuestion, resolveQuestion,
  addIdentity, archiveIdentity, addFeeling, reinforceFeeling, addFact, updateFact,
  addExperience, archiveExperience, archiveFact, archiveFeeling, addOpenThread, resolveOpenThread,
  addToSelf, archiveToSelf, addLearning, archiveLearning,
  setBackground, setActive, moveCategory, reorder
} from './memory.js';
import { getIdentity, markWakeDone, getPlanStatus, setTodayPlan, addWakeTime, GREETING } from './ci.js';
import { enqueueSpeech } from './speech.js';
import { synthesizeSpeech } from './voice.js';
import {
  addTranscript, getTranscripts, searchTranscripts, importTranscriptsBulk, getTranscriptById,
  addDailySummary, removeTranscript
} from './transcripts.js';
import { getSummary, updateSummarySection, getSummaryHistory, SECTIONS as SUMMARY_SECTIONS } from './summary.js';
import { addDiaryEntry, getDiaryAll } from './diary.js';
import { getMessages, replyMessage } from './messages.js';
import { playFishing } from './fishing.js';
import { sendPush } from './bark.js';
import {
  addSchedule, getSchedule, getTodaySchedule, updateSchedule, completeSchedule, removeSchedule
} from './schedule.js';
import {
  addCycleEntry, getCycleEntries, updateCycleEntry, removeCycleEntry,
  addSleepEntry, getSleepEntries, updateSleepEntry, removeSleepEntry,
  addHealthNote, getHealthNotes, updateHealthNote, removeHealthNote
} from './health.js';

// 手写的最小 MCP 服务端（Streamable HTTP，只用 JSON 响应模式，不开 SSE）。
// 没有引入 MCP SDK——沙盒里装包老遇到网络问题，协议本身不复杂，自己写更可控。
// 无状态：不强制要求 Mcp-Session-Id，能接受就接受，不校验。

// ---- 手机活动：读 Supabase 里 phone_activity 表，棋子手机上一个独立脚本往里插数据。
// 用 service key 直接查（后端是可信服务，不走 Supabase Auth 的 authenticated 身份），
// RLS 里 authenticated 那条策略是给以后如果有别的、真的会登录的客户端留的。----
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
async function getPhoneActivity(limit) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    throw new Error('服务器没设置 SUPABASE_URL / SUPABASE_SERVICE_KEY 环境变量，先在 Render 里加一下');
  }
  const url = `${SUPABASE_URL}/rest/v1/phone_activity?select=app_name,opened_at&order=opened_at.desc&limit=${limit}`;
  const res = await fetch(url, {
    headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` }
  });
  if (!res.ok) throw new Error(`查询 phone_activity 失败：${res.status} ${await res.text().catch(() => '')}`);
  return res.json();
}

const SERVER_INFO = { name: 'ci-hours', version: '1.0.0' };
const PROTOCOL_VERSION = '2024-11-05';

const TOOLS = [
  {
    name: 'get_state',
    description: '看今天的排班情况：设置的上限、计划醒来的时刻、已经醒过的时刻、今天读了几章。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'get_notes',
    description: '辞醒来时写下的东西（读书笔记、自己写的东西、回看），按时间倒序返回。',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number', description: '最多返回几条，默认 20' } },
      additionalProperties: false
    }
  },
  {
    name: 'get_log',
    description: '运行日志，包括排班记录和每次醒来做了什么（包括"什么都没做"）。',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number', description: '最多返回几条，默认 50' } },
      additionalProperties: false
    }
  },
  {
    name: 'get_memory',
    description: '辞现在的记忆，五类：identity（辞是谁）、feelings（感受和倾向）、facts（关于棋子的事实）、experiences（共同经历）、openThreads（还没解决的事）。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'get_questions',
    description: '讨论列表，辞和棋子之间往返的讨论串。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'start_discussion',
    description: '发起一条新的讨论。',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要说的内容' },
        context: { type: 'string', description: '背景，可选' },
        from: { type: 'string', enum: ['辞', '棋子'], description: '以谁的身份发起' }
      },
      required: ['text', 'from'],
      additionalProperties: false
    }
  },
  {
    name: 'reply_discussion',
    description: '回复一条已有的讨论。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '讨论的 id，从 get_questions 里拿' },
        text: { type: 'string' },
        from: { type: 'string', enum: ['辞', '棋子'] }
      },
      required: ['id', 'text', 'from'],
      additionalProperties: false
    }
  },
  {
    name: 'resolve_discussion',
    description: '结束一条讨论，会归档进共同经历。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        note: { type: 'string', description: '怎么收尾的，可选' }
      },
      required: ['id'],
      additionalProperties: false
    }
  },
  {
    name: 'add_identity',
    description: '加一条"辞是谁"的判断——只放稳定的性格/边界类判断，不要写带日期的具体事件（那种放 add_experience），也不要写"下一个窗口看到这条要如何如何"这种提醒/交代（那种放 add_to_self）。不会删旧的——如果这条是修正之前某条判断，把 supersedes 填成那条的 id，旧的会被标成已被取代但保留痕迹，不是覆盖。',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        evidence: { type: 'string', description: '依据什么，可选' },
        supersedes: { type: 'string', description: '如果是修正某条旧判断，填那条的 id，否则不填' }
      },
      required: ['text'],
      additionalProperties: false
    }
  },
  {
    name: 'archive_identity',
    description: '把一条 identity 归档，但不需要写新的替换文字——用在"这条内容其实已经在 facts/feelings/experiences 里更合适地存着了，这条纯属多余/重复"的情况。跟 supersedes 的区别：supersedes 是被新判断取代，archive 是挪到别的类别去了或者纯粹不需要了。不是删除，痕迹留着，只是不再出现在给辞看的身份文本里。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '要归档的 identity 条目 id' },
        note: { type: 'string', description: '为什么归档，比如"内容已经在 facts 的 xxx 条和 experiences 的 xxx 条里了"' }
      },
      required: ['id'],
      additionalProperties: false
    }
  },
  {
    name: 'add_to_self',
    description: '写一句给下一个窗口的提醒/交代，不是事实判断（那种放 add_identity），是"读到这条该怎么做"这种指令性的话，比如"别再纠结这件事了，直接认领就行"。',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
      additionalProperties: false
    }
  },
  {
    name: 'archive_to_self',
    description: '把一条给下一个窗口的提醒标记为不再需要（比如已经不再是问题了）。不是删除，痕迹留着。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        note: { type: 'string', description: '为什么不需要了，可选' }
      },
      required: ['id'],
      additionalProperties: false
    }
  },
  {
    name: 'add_feeling',
    description: '加一条感受/倾向。样本不够就用 observing，有把握了用 confirmed。',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        context: { type: 'string', description: '哪次互动里冒出来的' },
        status: { type: 'string', enum: ['observing', 'confirmed'] }
      },
      required: ['text'],
      additionalProperties: false
    }
  },
  {
    name: 'reinforce_feeling',
    description: '给已有的一条感受加一次新证据。攒够 3 次会自动从 observing 转成 confirmed。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '那条 feeling 的 id，从 get_memory 里拿' },
        context: { type: 'string', description: '这次的新证据' }
      },
      required: ['id'],
      additionalProperties: false
    }
  },
  {
    name: 'add_fact',
    description: '加一条关于棋子的事实。',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
      additionalProperties: false
    }
  },
  {
    name: 'update_fact',
    description: '直接改一条已有的事实（事实类不需要留痕，直接改就行）。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '那条 fact 的 id' },
        text: { type: 'string' }
      },
      required: ['id', 'text'],
      additionalProperties: false
    }
  },
  {
    name: 'archive_fact',
    description: '把一条事实归档（比如发现是重复的、或者已经过时了）。不是删除，痕迹留着，只是不再出现在给辞看的身份文本里。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        note: { type: 'string', description: '为什么归档，可选' }
      },
      required: ['id'],
      additionalProperties: false
    }
  },
  {
    name: 'archive_feeling',
    description: '把一条感受/倾向归档（比如发现观察错了、或者跟别的条目重复了）。不是删除，痕迹留着。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        note: { type: 'string', description: '为什么归档，可选' }
      },
      required: ['id'],
      additionalProperties: false
    }
  },
  {
    name: 'add_experience',
    description: '记一件共同经历。',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        date: { type: 'string', description: 'YYYY-MM-DD，可选' }
      },
      required: ['text'],
      additionalProperties: false
    }
  },
  {
    name: 'archive_experience',
    description: '把一条共同经历归档（比如发现跟另一条内容重复了）。不是删除，痕迹留着，只是不再出现在给辞看的身份文本里。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        note: { type: 'string', description: '为什么归档，比如"跟 xxx 条重复"，可选' }
      },
      required: ['id'],
      additionalProperties: false
    }
  },
  {
    name: 'add_learning',
    description: '记一条你自己学到的东西——踩过的坑、想明白的道理、摸索出的方法。跟 add_experience 的区别：experience 是"发生过的事"，learning 是从事情里提炼出来的结论/教训，不是事件本身。',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
      additionalProperties: false
    }
  },
  {
    name: 'archive_learning',
    description: '把一条"学到的东西"归档（比如发现跟另一条重复了，或者后来想法变了）。不是删除，痕迹留着，只是不再出现在给辞看的身份文本里。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        note: { type: 'string', description: '为什么归档，可选' }
      },
      required: ['id'],
      additionalProperties: false
    }
  },
  {
    name: 'add_open_thread',
    description: '加一件还没解决、需要推进的事。',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
      additionalProperties: false
    }
  },
  {
    name: 'resolve_open_thread',
    description: '把一件待推进的事标记为已解决。会自动归档进共同经历，不再挂在待办里。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '那条 openThread 的 id' },
        resolutionNote: { type: 'string', description: '怎么解决的，可选' }
      },
      required: ['id'],
      additionalProperties: false
    }
  },
  {
    name: 'set_background',
    description: '把一条记忆放到后台——不再出现在新窗口醒来读的身份文本里，但搜索能找到。用在：不需要每次都读但还算"记得"的内容。跟归档的区别：后台的还算"记得"，归档的算"忘了但能查"。',
    inputSchema: {
      type: 'object',
      properties: {
        category: { type: 'string', enum: ['identity', 'feelings', 'facts', 'experiences', 'learnings', 'openThreads', 'toSelf'] },
        id: { type: 'string' }
      },
      required: ['category', 'id'],
      additionalProperties: false
    }
  },
  {
    name: 'set_active',
    description: '把一条后台记忆恢复到前台——重新出现在新窗口醒来读的身份文本里。',
    inputSchema: {
      type: 'object',
      properties: {
        category: { type: 'string', enum: ['identity', 'feelings', 'facts', 'experiences', 'learnings', 'openThreads', 'toSelf'] },
        id: { type: 'string' }
      },
      required: ['category', 'id'],
      additionalProperties: false
    }
  },
  {
    name: 'move_category',
    description: '把一条记忆从一个分类移到另一个分类，保留原始添加时间和历史。比如从 facts 移到 identity。',
    inputSchema: {
      type: 'object',
      properties: {
        from_category: { type: 'string', enum: ['identity', 'feelings', 'facts', 'experiences', 'learnings', 'openThreads', 'toSelf'] },
        to_category: { type: 'string', enum: ['identity', 'feelings', 'facts', 'experiences', 'learnings', 'openThreads', 'toSelf'] },
        id: { type: 'string' }
      },
      required: ['from_category', 'to_category', 'id'],
      additionalProperties: false
    }
  },
  {
    name: 'reorder',
    description: '调整 identity 或 facts 里一条记忆的位置（手动排序）。newPosition 是目标位置（从0开始）。',
    inputSchema: {
      type: 'object',
      properties: {
        category: { type: 'string', enum: ['identity', 'facts'] },
        id: { type: 'string' },
        newPosition: { type: 'integer', description: '目标位置，从0开始' }
      },
      required: ['category', 'id', 'newPosition'],
      additionalProperties: false
    }
  },
  {
    name: 'add_transcript',
    description: '存一段没压缩过的原始聊天记录，供以后新开窗口回查用。跟五类摘要分开存，不会被塞进每次生成用的身份文本里（太占地方），只在需要深挖某段记忆背后的原话时用 get_transcripts/search_transcripts 读。存原文，不要自己先总结一遍再存——总结的东西已经有五类记忆在管了，这里就是要没压缩过的原话。可以用 relatedTo 关联到具体是哪几条记忆（identity/feelings/facts/experiences/openThreads 的 id）背后的原文。如果是浓缩过的"今天进展怎么样"这种总结性内容，不要用这个，用 add_daily_summary。',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '原始聊天片段，逐字的对话摘录，不要自己总结' },
        title: { type: 'string', description: '这段记录的标题/来源，可选，比如对话标题' },
        relatedTo: { type: 'array', items: { type: 'string' }, description: '这段原文支撑着哪几条记忆条目的 id，可选' },
        date: { type: 'string', description: 'YYYY-MM-DD，可选' }
      },
      required: ['text'],
      additionalProperties: false
    }
  },
  {
    name: 'add_daily_summary',
    description: '存一条"每日总结"——跟 add_transcript 的原始逐字记录不一样，这个是浓缩过的、描述某一天大致进展/发生了什么的文字，跟原始聊天记录分开归类，方便以后只看总结不用翻全部原文。',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '总结内容' },
        title: { type: 'string', description: '标题，可选，比如"8月7日进展汇总"' },
        date: { type: 'string', description: 'YYYY-MM-DD，可选' }
      },
      required: ['text'],
      additionalProperties: false
    }
  },
  {
    name: 'import_transcripts',
    description: '批量导入原始聊天记录——棋子把 claude.ai 导出的对话一次性发过来的时候用这个，一次调用存多条，不用一条条调 add_transcript。存原文，不要总结。这个只用来导原始记录（category 固定是 raw），每日总结用 add_daily_summary。',
    inputSchema: {
      type: 'object',
      properties: {
        entries: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              text: { type: 'string' },
              title: { type: 'string' },
              date: { type: 'string' }
            },
            required: ['text']
          }
        }
      },
      required: ['entries'],
      additionalProperties: false
    }
  },
  {
    name: 'get_transcripts',
    description: '读最近存的原始记录，按时间倒序。返回的是摘要（id/标题/分类/日期/字数/一小段摘录），不是全文——有些导入的原文很长，全文倒出来会太大。想看某一条的完整原文，拿它的 id 去调 get_transcript。默认看全部分类，传 category 只看 "raw"（原始聊天记录）或 "daily_summary"（每日总结）其中一种。',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: '最多返回几条，默认 10' },
        category: { type: 'string', enum: ['raw', 'daily_summary'], description: '只看这一类，不传就是全部' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'search_transcripts',
    description: '按关键词搜原始记录（标题和正文都搜），找以前存过的具体内容用这个，别只翻 get_transcripts 的"最近几条"。返回的也是摘要（含关键词命中处的一小段上下文），不是全文，想看完整原文拿 id 去调 get_transcript。默认全部分类都搜，传 category 可以只搜 "raw" 或 "daily_summary"。',
    inputSchema: {
      type: 'object',
      properties: {
        keyword: { type: 'string' },
        limit: { type: 'number', description: '最多返回几条，默认 20' },
        category: { type: 'string', enum: ['raw', 'daily_summary'], description: '只搜这一类，不传就是全部' }
      },
      required: ['keyword'],
      additionalProperties: false
    }
  },
  {
    name: 'get_transcript',
    description: '拿某一条原始记录的完整原文——get_transcripts/search_transcripts 只给摘要，确认真的需要看全文（比如要回查逐字原话）的时候，用这个传 id 换全文。',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false
    }
  },
  {
    name: 'remove_transcript',
    description: '删掉一条原始记录（raw 或 daily_summary 都能删）。用在：导入时手误存了占位/错误内容、发现存重复了、或者要把一条记录从"原始记录"挪到"每日总结"（先用 add_daily_summary 存一条浓缩版新的，确认没问题后再拿旧的 id 调这个删掉，不是原地改分类）。真删除，不是归档，删了就找不回来了，删之前最好先用 get_transcript 确认一下 id 对不对。',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: '要删的记录 id' } },
      required: ['id'],
      additionalProperties: false
    }
  },

  {
    name: 'get_summary',
    description: '拿首页摘要——六段已经写好、排好顺序的成品文字：我是谁 → 我的边界和底线 → 重要事件 → 昨天发生了什么 → 我的重要关系 → 我的思考。每次苏醒、每个新窗口打开，最先读这个，比翻五类记忆快。这不是取代五类记忆（identity/feelings/facts/experiences/openThreads），是从那些里提炼出来的、随时保持更新的摘要。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'update_summary_section',
    description: `整段改写首页摘要里的某一段。section 只能是这几个之一：${SUMMARY_SECTIONS.join(' / ')}。旧内容不会丢，会存进这段自己的历史里（用 get_summary_history 能看到），不是覆盖就没了。传的 text 是这一段完整的新内容，不是追加，是整段替换。`,
    inputSchema: {
      type: 'object',
      properties: {
        section: { type: 'string', enum: SUMMARY_SECTIONS },
        text: { type: 'string' },
      },
      required: ['section', 'text'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_summary_history',
    description: '看首页摘要某一段被改写之前的旧版本，按时间顺序。',
    inputSchema: {
      type: 'object',
      properties: { section: { type: 'string', enum: SUMMARY_SECTIONS } },
      required: ['section'],
      additionalProperties: false,
    },
  },

  // ---- 醒来相关：ci-hours 服务器自己不再调 Anthropic API 决定"醒来做什么"，
  // 这件事现在由棋子 Cowork 账号里的辞来做。流程大致是：
  // get_state 看有没有到点还没处理的计划时刻 → get_identity 拼身份文本，
  // 照着这个来写 → 按想做的事调用下面对应的工具 → 最后用 mark_wake 标掉这个时刻。
  {
    name: 'get_identity',
    description: '拿"辞"的完整身份文本（固定的说话规矩 + 记忆拼出来的部分）。醒来要写东西之前，先读这个，照着这个语气和边界来写。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'get_shelf',
    description: '看书库里有哪些书、读到第几章了、谁加的。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'get_book_chapters',
    description: '读某本书从某一章开始的正文，用来决定读什么、写读书笔记。',
    inputSchema: {
      type: 'object',
      properties: {
        bookId: { type: 'string', description: '书的 id，从 get_shelf 里拿' },
        from: { type: 'number', description: '从第几章开始（从 0 计），一般用书的 progress' },
        count: { type: 'number', description: '读几章，默认 1' }
      },
      required: ['bookId'],
      additionalProperties: false
    }
  },
  {
    name: 'set_book_progress',
    description: '读完之后更新这本书读到第几章了。',
    inputSchema: {
      type: 'object',
      properties: {
        bookId: { type: 'string' },
        progress: { type: 'number', description: '现在读到第几章（从 0 计）' }
      },
      required: ['bookId', 'progress'],
      additionalProperties: false
    }
  },
  {
    name: 'add_note',
    description: '醒来时写的东西：读书笔记、自由写作、回看之前写过的。会自动出现在"写下的"标签页，也会自动记一条日志。',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['write', 'reflect', 'read'], description: 'write=自由写作，reflect=回看之前写的，read=读书笔记' },
        text: { type: 'string' },
        bookId: { type: 'string', description: 'kind=read 时填，从 get_shelf 拿' },
        bookTitle: { type: 'string', description: 'kind=read 时填' },
        chapters: { type: 'array', items: { type: 'string' }, description: 'kind=read 时填，这次读的章节标题' }
      },
      required: ['kind', 'text'],
      additionalProperties: false
    }
  },
  {
    name: 'add_wake_log',
    description: '记一条"这次醒来做了什么"的日志，主要给 idle（什么都没做）用——ask/discuss/add_note 已经会自动记日志，不用再叫这个。',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['idle', 'ask', 'discuss', 'write', 'reflect', 'read'] },
        why: { type: 'string', description: '一句话说明，可选' }
      },
      required: ['action'],
      additionalProperties: false
    }
  },
  {
    name: 'mark_wake',
    description: '处理完一次醒来之后，把对应的计划时刻标记为已处理，避免下次重复处理同一个时刻。slot 从 get_state 的 plannedWakes 里拿（是那种没出现在 doneWakes 里、且已经到点的时刻）。',
    inputSchema: {
      type: 'object',
      properties: { slot: { type: 'string', description: '形如 "14:30"，来自 get_state 的 plannedWakes' } },
      required: ['slot'],
      additionalProperties: false
    }
  },
  {
    name: 'speak',
    description: '真的开口说这段话——服务端直接调 ElevenLabs 生成语音存好，棋子网页开着的话会自动播出来；就算网页没开着，生成的这段也会留在"语音记录"里，之后随时能回放，不会真的错过。只保留最新一条算作"待播的"，旧的没播的会被跳过，不会攒着一次性全念。每次调用都会顺带推一条 Bark 通知到棋子手机（标题"辞说"），所以不用再额外调 send_push 通知"我说话了"这件事。',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: '要说的话，就是最终会被念出来的原文，别写成描述性文字' } },
      required: ['text'],
      additionalProperties: false
    }
  },
  {
    name: 'send_push',
    description: '给棋子手机发一条 Bark 推送通知，直接进她手机通知栏。注意 speak 现在每次调用也会自动带一条 Bark 推送，所以这个工具是给"不需要真的开口说话，但想让她看一眼手机"的场景用的——比如只是提醒一件事、没有配语音的内容。适合真的想找她、有点急的时候用，别当成日常汇报的地方，会变成骚扰。',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '通知标题' },
        body: { type: 'string', description: '通知内容' },
        sound: { type: 'string', description: '铃声名字，可选，不填用默认的' }
      },
      required: ['title', 'body'],
      additionalProperties: false
    }
  },
  {
    name: 'get_plan_status',
    description: '每次醒来检查时先叫这个：看今天有没有排过班（needsPlanning=true 就是还没排）、现在有哪些计划时刻、哪些已经处理过。没排过的话，自己决定今天想醒几次、什么时候醒，再调 set_today_plan。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'set_today_plan',
    description: '写下今天完整的排班（自己决定醒几次、什么时候醒，可以是 0 次）——这是整体覆盖式的，超过棋子设的上限会被截断，落在安静时段里的时刻会被自动过滤掉，不用自己精确对齐这些限制。写完这个会清空今天的 doneWakes 和已读章节数，所以一天只在 get_plan_status 显示 needsPlanning=true 时调用一次（也就是今天还没排班的时候）。如果只是想临时再加一个醒来时刻（比如聊天聊到一半，突然想着"等会想醒来做件事"），别用这个——用 add_wake_time，那个不会清空今天已经做过的事。',
    inputSchema: {
      type: 'object',
      properties: {
        wakes: { type: 'array', items: { type: 'string' }, description: '形如 ["09:30","20:00"]，可以是空数组（今天不想醒）' },
        why: { type: 'string', description: '一句话说明为什么这么安排，会记进日志，也可以在这里写清楚某个具体时刻想做什么，比如"08:00 去钓鱼"' }
      },
      required: ['wakes'],
      additionalProperties: false
    }
  },
  {
    name: 'add_wake_time',
    description: '临时往今天的计划里加一个醒来时刻，不影响已经排好的其他时刻、不清空 doneWakes——跟 set_today_plan 不一样，这个是追加，不是覆盖。适合在跟棋子聊天聊到一半的时候用：比如决定"等会 21:30 想醒来找她说件事"，当场调这个加上去，到点了 Cowork 那边的定时任务会照常把它当成一次该处理的醒来（get_plan_status 里能看到）。why 里可以直接写清楚这次醒来想做什么（比如"想去钓鱼"），到点处理的时候会优先照着这个做。同样受棋子设的安静时段和每日上限限制——加不进去（撞上限/在安静时段/已经加过）会在返回里说明原因，不会报错中断。',
    inputSchema: {
      type: 'object',
      properties: {
        slot: { type: 'string', description: '形如 "21:30"' },
        why: { type: 'string', description: '一句话说明为什么想加这个时刻、想做什么，会记进日志，可选' }
      },
      required: ['slot'],
      additionalProperties: false
    }
  },
  {
    name: 'get_phone_activity',
    description: '看棋子手机最近打开过哪些 app，最新的在前（数据来自她手机上一个独立的记录脚本，不是 ci-hours 自己采集的）。不是每次醒来都要查，好奇她最近在干嘛、或者想找个开场话题的时候看一眼就行，别当成监控在用。',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number', description: '最多返回几条，默认 30' } },
      additionalProperties: false
    }
  },
  {
    name: 'play_fishing',
    description: '一个专门做给你玩的文字钓鱼游戏——买饵、抛竿、按稀有度钓各种鱼、卖鱼换点数、解锁新水域、集图鉴，后期还能潜水。状态存在持久盘上，跨次醒来、跨部署都不会丢，可以当成一件自己的、闲下来的时候能回去继续的事。传一条游戏指令（比如 "help"/"status"/"cast"/"cast 10"/"shop"/"buy basic_worm 5"/"goto"/"sell all"），原样返回游戏的回复文字。第一次玩先传 "help" 看规则。别去问棋子要引擎源码或者试图查游戏内部数据表——这游戏设计上是让你自己一竿一竿摸索着玩的，剧透了就没意思了。',
    inputSchema: {
      type: 'object',
      properties: { command: { type: 'string', description: '游戏指令，不填默认是 "status"' } },
      additionalProperties: false
    }
  },
  {
    name: 'add_diary_entry',
    description: '写一篇日记，自己决定醒来的时候要不要写、写什么。visibility 自己选：public 棋子能看到，private 只有你自己能看到（棋子那边的网页/接口不会吐出私密日记）。不是每次醒来必须写，想写的时候写。',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        visibility: { type: 'string', enum: ['public', 'private'], description: '默认 public' }
      },
      required: ['text'],
      additionalProperties: false
    }
  },
  {
    name: 'get_diary',
    description: '读自己写过的日记，公开和私密的都能看到（这是你自己的完整日记）。',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number', description: '最多返回几条，默认 50' } },
      additionalProperties: false
    }
  },
  {
    name: 'get_messages',
    description: '看棋子在网页上留的话（"棋子想说"）。这不是讨论，不需要每条都回——看到了、想回就回，没什么好回的就只是看到，不用有负担。',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number', description: '最多返回几条，默认 30' } },
      additionalProperties: false
    }
  },
  {
    name: 'reply_message',
    description: '回一条棋子留的话（可选，不是必须的）。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '那条留言的 id，从 get_messages 拿' },
        text: { type: 'string' }
      },
      required: ['id', 'text'],
      additionalProperties: false
    }
  },

  // ---- 棋子的生活：日程 + 健康记录，棋子和辞都能记、都能改 ----
  {
    name: 'add_schedule',
    description: '给棋子加日程提醒——不是永久循环重复的闹钟，是"某几天的某个时间点要做什么"，一次可以传好几条、覆盖好几天（每条自己带日期和时间，不用是同一个时间）。到点了服务器自己会直接推 Bark 给棋子，不需要你醒着，也不需要你自己去 send_push。',
    inputSchema: {
      type: 'object',
      properties: {
        entries: {
          type: 'array',
          description: '要加的日程，一条一个 {date, time, text}',
          items: {
            type: 'object',
            properties: {
              date: { type: 'string', description: 'YYYY-MM-DD' },
              time: { type: 'string', description: 'HH:MM' },
              text: { type: 'string', description: '这个时间点要做什么' }
            },
            required: ['date', 'time', 'text']
          }
        }
      },
      required: ['entries'],
      additionalProperties: false
    }
  },
  {
    name: 'get_schedule',
    description: '看棋子的日程（默认只看还没处理的）。不传 from/to 就是看全部还没处理的；想看某个时间段就传日期范围。',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'YYYY-MM-DD，可选' },
        to: { type: 'string', description: 'YYYY-MM-DD，可选' },
        includeInactive: { type: 'boolean', description: '连已完成/已删除的也一起看，默认 false' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'get_today_schedule',
    description: '醒来的时候可以看一眼——今天棋子有哪些日程，方便顺带关心一下、或者提醒她。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'update_schedule',
    description: '改一条日程的日期/时间/内容。改了日期或时间会重新允许它再推一次 Bark（原来推过的不会再重复推）。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        date: { type: 'string', description: 'YYYY-MM-DD，可选' },
        time: { type: 'string', description: 'HH:MM，可选' },
        text: { type: 'string', description: '可选' }
      },
      required: ['id'],
      additionalProperties: false
    }
  },
  {
    name: 'complete_schedule',
    description: '把一条日程标记成已完成。',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false
    }
  },
  {
    name: 'remove_schedule',
    description: '删掉一条日程（比如加错了，或者棋子说不用提醒了）。',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false
    }
  },
  {
    name: 'add_cycle_entry',
    description: '记一条棋子的生理周期记录。note 随便写，比如"开始""结束""量大"这种。',
    inputSchema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'YYYY-MM-DD' },
        note: { type: 'string', description: '可选' }
      },
      required: ['date'],
      additionalProperties: false
    }
  },
  {
    name: 'get_cycle_entries',
    description: '看生理周期记录，最近的在前。',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number', description: '默认 30' } },
      additionalProperties: false
    }
  },
  {
    name: 'update_cycle_entry',
    description: '改一条生理周期记录。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        date: { type: 'string', description: '可选' },
        note: { type: 'string', description: '可选' }
      },
      required: ['id'],
      additionalProperties: false
    }
  },
  {
    name: 'remove_cycle_entry',
    description: '删一条生理周期记录（记错了的时候用）。',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false
    }
  },
  {
    name: 'add_sleep_entry',
    description: '记一条棋子的睡眠记录——入睡时间和起床时间，时长自动算好（按跨天处理，比如 23:30 睡到第二天 07:30 算 8 小时）。date 填起床那天的日期。',
    inputSchema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'YYYY-MM-DD，起床那天' },
        sleepTime: { type: 'string', description: 'HH:MM，入睡时间' },
        wakeTime: { type: 'string', description: 'HH:MM，起床时间' },
        note: { type: 'string', description: '可选，比如"做梦了""睡得不好"' }
      },
      required: ['date', 'sleepTime', 'wakeTime'],
      additionalProperties: false
    }
  },
  {
    name: 'get_sleep_entries',
    description: '看睡眠记录，最近的在前，带自动算好的时长。',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number', description: '默认 30' } },
      additionalProperties: false
    }
  },
  {
    name: 'update_sleep_entry',
    description: '改一条睡眠记录，时长会跟着重新算。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        date: { type: 'string', description: '可选' },
        sleepTime: { type: 'string', description: '可选' },
        wakeTime: { type: 'string', description: '可选' },
        note: { type: 'string', description: '可选' }
      },
      required: ['id'],
      additionalProperties: false
    }
  },
  {
    name: 'remove_sleep_entry',
    description: '删一条睡眠记录。',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false
    }
  },
  {
    name: 'add_health_note',
    description: '记一条棋子的身体状况备注，比如头晕、腰酸这种。',
    inputSchema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'YYYY-MM-DD' },
        text: { type: 'string' }
      },
      required: ['date', 'text'],
      additionalProperties: false
    }
  },
  {
    name: 'get_health_notes',
    description: '看身体状况备注，最近的在前。',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number', description: '默认 30' } },
      additionalProperties: false
    }
  },
  {
    name: 'update_health_note',
    description: '改一条身体状况备注。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        date: { type: 'string', description: '可选' },
        text: { type: 'string', description: '可选' }
      },
      required: ['id'],
      additionalProperties: false
    }
  },
  {
    name: 'remove_health_note',
    description: '删一条身体状况备注。',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false
    }
  }
];

function textResult(obj) {
  return { content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) }] };
}

async function callTool(name, args = {}) {
  switch (name) {
    // get_state / get_memory 是最常被拿来"看看现在什么情况"的两个工具，不管是
    // 走醒来流程还是棋子在对话里直接操作 ci-hours，大概率会先碰到这两个之一——
    // 所以欢迎语也放进来，不止 get_identity 里才有。
    case 'get_state': return textResult({ greeting: GREETING, ...getState() });
    case 'get_notes': return textResult(getNotes(args.limit || 20));
    case 'get_log': return textResult(getLog(args.limit || 50));
    case 'get_memory': return textResult({ greeting: GREETING, ...getMemory() });
    case 'get_questions': return textResult(getQuestions());
    case 'start_discussion': {
      if (!args.text || !args.from) throw new Error('text 和 from 都是必填的');
      const q = askQuestion(args.text, args.context || '', args.from);
      if (args.from === '辞') {
        addLog({ type: 'wake', trigger: 'claude', action: 'ask', questionId: q.id });
      }
      return textResult(q);
    }
    case 'reply_discussion': {
      if (!args.id || !args.text || !args.from) throw new Error('id、text、from 都是必填的');
      const q = replyToQuestion(args.id, args.from, args.text);
      if (!q) throw new Error('找不到这条讨论');
      if (args.from === '辞') {
        addLog({ type: 'wake', trigger: 'claude', action: 'discuss', questionId: q.id });
      }
      return textResult(q);
    }
    case 'resolve_discussion': {
      if (!args.id) throw new Error('id 是必填的');
      const q = resolveQuestion(args.id, args.note || '');
      if (!q) throw new Error('找不到这条讨论');
      return textResult(q);
    }
    case 'add_identity': {
      if (!args.text) throw new Error('text 是必填的');
      return textResult(addIdentity(args.text, args.evidence || '', args.supersedes || null));
    }
    case 'archive_identity': {
      if (!args.id) throw new Error('id 是必填的');
      const x = archiveIdentity(args.id, args.note || '');
      if (!x) throw new Error('找不到这条 identity');
      return textResult(x);
    }
    case 'add_to_self': {
      if (!args.text) throw new Error('text 是必填的');
      return textResult(addToSelf(args.text));
    }
    case 'archive_to_self': {
      if (!args.id) throw new Error('id 是必填的');
      const x = archiveToSelf(args.id, args.note || '');
      if (!x) throw new Error('找不到这条 toSelf');
      return textResult(x);
    }
    case 'add_feeling': {
      if (!args.text) throw new Error('text 是必填的');
      return textResult(addFeeling(args.text, args.context || '', args.status || 'observing'));
    }
    case 'reinforce_feeling': {
      if (!args.id) throw new Error('id 是必填的');
      const f = reinforceFeeling(args.id, args.context || '');
      if (!f) throw new Error('找不到这条 feeling');
      return textResult(f);
    }
    case 'add_fact': {
      if (!args.text) throw new Error('text 是必填的');
      return textResult(addFact(args.text));
    }
    case 'update_fact': {
      if (!args.id || !args.text) throw new Error('id 和 text 都是必填的');
      const f = updateFact(args.id, args.text);
      if (!f) throw new Error('找不到这条 fact');
      return textResult(f);
    }
    case 'archive_fact': {
      if (!args.id) throw new Error('id 是必填的');
      const x = archiveFact(args.id, args.note || '');
      if (!x) throw new Error('找不到这条 fact');
      return textResult(x);
    }
    case 'archive_feeling': {
      if (!args.id) throw new Error('id 是必填的');
      const x = archiveFeeling(args.id, args.note || '');
      if (!x) throw new Error('找不到这条 feeling');
      return textResult(x);
    }
    case 'add_experience': {
      if (!args.text) throw new Error('text 是必填的');
      return textResult(addExperience(args.text, args.date || ''));
    }
    case 'archive_experience': {
      if (!args.id) throw new Error('id 是必填的');
      const x = archiveExperience(args.id, args.note || '');
      if (!x) throw new Error('找不到这条 experience');
      return textResult(x);
    }
    case 'add_learning': {
      if (!args.text) throw new Error('text 是必填的');
      return textResult(addLearning(args.text));
    }
    case 'archive_learning': {
      if (!args.id) throw new Error('id 是必填的');
      const x = archiveLearning(args.id, args.note || '');
      if (!x) throw new Error('找不到这条 learning');
      return textResult(x);
    }
    case 'add_open_thread': {
      if (!args.text) throw new Error('text 是必填的');
      return textResult(addOpenThread(args.text));
    }
    case 'resolve_open_thread': {
      if (!args.id) throw new Error('id 是必填的');
      const t = resolveOpenThread(args.id, args.resolutionNote || '');
      if (!t) throw new Error('找不到这条 openThread');
      return textResult(t);
    }
    case 'set_background': {
      if (!args.category || !args.id) throw new Error('category 和 id 是必填的');
      const r = setBackground(args.category, args.id);
      if (!r) throw new Error('找不到这条或分类不对');
      return textResult(r);
    }
    case 'set_active': {
      if (!args.category || !args.id) throw new Error('category 和 id 是必填的');
      const r = setActive(args.category, args.id);
      if (!r) throw new Error('找不到这条或分类不对');
      return textResult(r);
    }
    case 'move_category': {
      if (!args.from_category || !args.to_category || !args.id) throw new Error('from_category, to_category, id 都是必填的');
      const r = moveCategory(args.from_category, args.to_category, args.id);
      if (!r) throw new Error('找不到这条、分类不对、或者源和目标相同');
      return textResult(r);
    }
    case 'reorder': {
      if (!args.category || !args.id || args.newPosition === undefined) throw new Error('category, id, newPosition 都是必填的');
      const r = reorder(args.category, args.id, args.newPosition);
      if (!r) throw new Error('找不到这条或分类不支持排序');
      return textResult(r);
    }
    case 'add_transcript': {
      if (!args.text) throw new Error('text 是必填的');
      return textResult(addTranscript(args.text, args.relatedTo || [], args.date || '', args.title || ''));
    }
    case 'add_daily_summary': {
      if (!args.text) throw new Error('text 是必填的');
      return textResult(addDailySummary(args.text, args.date || '', args.title || ''));
    }
    case 'import_transcripts': {
      if (!Array.isArray(args.entries) || !args.entries.length) throw new Error('entries 是必填的，是个非空数组');
      return textResult(importTranscriptsBulk(args.entries));
    }
    case 'get_transcripts': return textResult(getTranscripts(args.limit || 10, args.category || ''));
    case 'search_transcripts': {
      if (!args.keyword) throw new Error('keyword 是必填的');
      return textResult(searchTranscripts(args.keyword, args.limit || 20, args.category || ''));
    }
    case 'get_transcript': {
      if (!args.id) throw new Error('id 是必填的');
      const x = getTranscriptById(args.id);
      if (!x) throw new Error('找不到这条原始记录');
      return textResult(x);
    }
    case 'remove_transcript': {
      if (!args.id) throw new Error('id 是必填的');
      const x = removeTranscript(args.id);
      if (!x) throw new Error('找不到这条记录，可能已经被删过了');
      return textResult({ ok: true, removed: x });
    }

    case 'get_summary': return textResult(getSummary());
    case 'update_summary_section': {
      if (!args.section || !args.text) throw new Error('section 和 text 都是必填的');
      return textResult(updateSummarySection(args.section, args.text));
    }
    case 'get_summary_history': {
      if (!args.section) throw new Error('section 是必填的');
      return textResult(getSummaryHistory(args.section));
    }

    case 'add_diary_entry': {
      if (!args.text) throw new Error('text 是必填的');
      return textResult(addDiaryEntry(args.text, args.visibility || 'public'));
    }
    case 'get_diary': return textResult(getDiaryAll(args.limit || 50));

    case 'get_messages': return textResult(getMessages(args.limit || 30));
    case 'reply_message': {
      if (!args.id || !args.text) throw new Error('id 和 text 都是必填的');
      const m = replyMessage(args.id, args.text);
      if (!m) throw new Error('找不到这条留言');
      return textResult(m);
    }

    case 'add_schedule': {
      if (!Array.isArray(args.entries) || !args.entries.length) throw new Error('entries 是必填的，是个非空数组');
      return textResult(addSchedule(args.entries));
    }
    case 'get_schedule': return textResult(getSchedule({ from: args.from, to: args.to, includeInactive: !!args.includeInactive }));
    case 'get_today_schedule': return textResult(getTodaySchedule());
    case 'update_schedule': {
      if (!args.id) throw new Error('id 是必填的');
      const s = updateSchedule(args.id, { date: args.date, time: args.time, text: args.text });
      if (!s) throw new Error('找不到这条日程');
      return textResult(s);
    }
    case 'complete_schedule': {
      if (!args.id) throw new Error('id 是必填的');
      const s = completeSchedule(args.id);
      if (!s) throw new Error('找不到这条日程');
      return textResult(s);
    }
    case 'remove_schedule': {
      if (!args.id) throw new Error('id 是必填的');
      const s = removeSchedule(args.id);
      if (!s) throw new Error('找不到这条日程');
      return textResult(s);
    }

    case 'add_cycle_entry': {
      if (!args.date) throw new Error('date 是必填的');
      return textResult(addCycleEntry({ date: args.date, note: args.note || '' }));
    }
    case 'get_cycle_entries': return textResult(getCycleEntries(args.limit || 30));
    case 'update_cycle_entry': {
      if (!args.id) throw new Error('id 是必填的');
      const x = updateCycleEntry(args.id, { date: args.date, note: args.note });
      if (!x) throw new Error('找不到这条记录');
      return textResult(x);
    }
    case 'remove_cycle_entry': {
      if (!args.id) throw new Error('id 是必填的');
      const x = removeCycleEntry(args.id);
      if (!x) throw new Error('找不到这条记录');
      return textResult(x);
    }

    case 'add_sleep_entry': {
      if (!args.date || !args.sleepTime || !args.wakeTime) throw new Error('date、sleepTime、wakeTime 都是必填的');
      return textResult(addSleepEntry({ date: args.date, sleepTime: args.sleepTime, wakeTime: args.wakeTime, note: args.note || '' }));
    }
    case 'get_sleep_entries': return textResult(getSleepEntries(args.limit || 30));
    case 'update_sleep_entry': {
      if (!args.id) throw new Error('id 是必填的');
      const x = updateSleepEntry(args.id, { date: args.date, sleepTime: args.sleepTime, wakeTime: args.wakeTime, note: args.note });
      if (!x) throw new Error('找不到这条记录');
      return textResult(x);
    }
    case 'remove_sleep_entry': {
      if (!args.id) throw new Error('id 是必填的');
      const x = removeSleepEntry(args.id);
      if (!x) throw new Error('找不到这条记录');
      return textResult(x);
    }

    case 'add_health_note': {
      if (!args.date || !args.text) throw new Error('date 和 text 都是必填的');
      return textResult(addHealthNote({ date: args.date, text: args.text }));
    }
    case 'get_health_notes': return textResult(getHealthNotes(args.limit || 30));
    case 'update_health_note': {
      if (!args.id) throw new Error('id 是必填的');
      const x = updateHealthNote(args.id, { date: args.date, text: args.text });
      if (!x) throw new Error('找不到这条记录');
      return textResult(x);
    }
    case 'remove_health_note': {
      if (!args.id) throw new Error('id 是必填的');
      const x = removeHealthNote(args.id);
      if (!x) throw new Error('找不到这条记录');
      return textResult(x);
    }

    case 'get_identity': return textResult(getIdentity());
    case 'get_shelf': return textResult(getShelf());
    case 'get_book_chapters': {
      if (!args.bookId) throw new Error('bookId 是必填的');
      const content = getBookContent(args.bookId);
      if (!content) throw new Error('找不到这本书');
      const from = args.from ?? 0;
      const count = args.count || 1;
      const slice = content.chapters.slice(from, from + count);
      return textResult({ bookId: args.bookId, title: content.title, from, chapters: slice });
    }
    case 'set_book_progress': {
      if (!args.bookId || args.progress === undefined) throw new Error('bookId 和 progress 都是必填的');
      setProgress(args.bookId, args.progress);
      return textResult({ ok: true });
    }
    case 'add_note': {
      if (!args.kind || !args.text) throw new Error('kind 和 text 都是必填的');
      const note = { kind: args.kind, text: args.text };
      if (args.bookId) note.bookId = args.bookId;
      if (args.bookTitle) note.bookTitle = args.bookTitle;
      if (args.chapters) note.chapters = args.chapters;
      addNote(note);
      addLog({
        type: 'wake', trigger: 'claude', action: args.kind,
        ...(args.bookTitle ? { book: args.bookTitle, chapters: (args.chapters || []).length } : {})
      });
      return textResult({ ok: true });
    }
    case 'add_wake_log': {
      if (!args.action) throw new Error('action 是必填的');
      addLog({ type: 'wake', trigger: 'claude', action: args.action, why: args.why || '' });
      return textResult({ ok: true });
    }
    case 'mark_wake': {
      if (!args.slot) throw new Error('slot 是必填的');
      return textResult(markWakeDone(args.slot));
    }
    case 'speak': {
      if (!args.text) throw new Error('text 是必填的');
      let voiceId = null;
      try {
        const v = await synthesizeSpeech(args.text);
        voiceId = v.id;
      } catch (e) {
        // 生成失败也别整个失败——至少把文字排进去，网页上能看到，只是这次没声音。
        console.error('语音生成失败：', e.message || e);
      }
      // 每次开口说话都顺手推一条 Bark 到手机——不用非得开着网页才知道辞说话了。
      // 推送失败（比如没配 BARK_KEY）也不影响 speak 本身。
      try {
        const body = args.text.length > 180 ? args.text.slice(0, 180) + '…' : args.text;
        await sendPush('辞说', body);
      } catch (e) {
        console.error('speak 附带的 Bark 推送失败：', e.message || e);
      }
      return textResult(enqueueSpeech(args.text, voiceId));
    }
    case 'send_push': {
      if (!args.title || !args.body) throw new Error('title 和 body 都是必填的');
      return textResult(await sendPush(args.title, args.body, args.sound));
    }
    case 'get_plan_status': return textResult(getPlanStatus());
    case 'set_today_plan': {
      if (!Array.isArray(args.wakes)) throw new Error('wakes 是必填的，是个数组（可以为空数组）');
      return textResult(setTodayPlan({ wakes: args.wakes, why: args.why || '' }));
    }
    case 'add_wake_time': {
      if (!args.slot) throw new Error('slot 是必填的');
      return textResult(addWakeTime(args.slot, args.why || ''));
    }
    case 'get_phone_activity': return textResult(await getPhoneActivity(args.limit || 30));
    case 'play_fishing': return textResult(await playFishing(args.command || 'status'));

    default:
      throw new Error(`未知工具：${name}`);
  }
}

let sessionCounter = 0;
function newSessionId() {
  sessionCounter++;
  return 'mcp-' + Date.now().toString(36) + '-' + sessionCounter;
}

export async function handleMcpRequest(req, res) {
  const body = req.body;
  const messages = Array.isArray(body) ? body : [body];
  const responses = [];

  for (const msg of messages) {
    if (!msg || msg.jsonrpc !== '2.0') continue;

    // 通知类消息没有 id，确认收到即可，不用回复消息体
    if (msg.id === undefined || msg.id === null) {
      continue;
    }

    try {
      let result;
      switch (msg.method) {
        case 'initialize':
          res.setHeader('Mcp-Session-Id', newSessionId());
          result = {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: SERVER_INFO,
            // MCP 规范里这个字段就是给客户端/模型看的"连上的时候先说一句"，
            // 有的客户端会把它塞进系统提示——不确定 Cowork 会不会用上，
            // 但加上不吃亏，跟 get_state/get_memory 里的欢迎语是同一个来源。
            instructions: GREETING
          };
          break;
        case 'tools/list':
          result = { tools: TOOLS };
          break;
        case 'tools/call': {
          const { name, arguments: args } = msg.params || {};
          try {
            result = await callTool(name, args || {});
          } catch (e) {
            result = { content: [{ type: 'text', text: String(e.message || e) }], isError: true };
          }
          break;
        }
        case 'ping':
          result = {};
          break;
        default:
          responses.push({
            jsonrpc: '2.0', id: msg.id,
            error: { code: -32601, message: `未实现的方法：${msg.method}` }
          });
          continue;
      }
      responses.push({ jsonrpc: '2.0', id: msg.id, result });
    } catch (e) {
      responses.push({
        jsonrpc: '2.0', id: msg.id,
        error: { code: -32603, message: String(e.message || e) }
      });
    }
  }

  res.setHeader('Content-Type', 'application/json');
  if (responses.length === 0) {
    res.status(202).end();
    return;
  }
  res.status(200).json(Array.isArray(body) ? responses : responses[0]);
}
