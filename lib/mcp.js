import {
  getState, getNotes, getLog,
  getShelf, getBookContent, setProgress, addNote, addLog
} from './store.js';
import {
  getMemory, getQuestions, askQuestion, replyToQuestion, resolveQuestion,
  addIdentity, archiveIdentity, addFeeling, reinforceFeeling, addFact, updateFact,
  addExperience, addOpenThread, resolveOpenThread,
  addToSelf, archiveToSelf,
  addTranscript, getTranscripts
} from './memory.js';
import { getIdentity, markWakeDone, getPlanStatus, setTodayPlan, GREETING } from './ci.js';

// 手写的最小 MCP 服务端（Streamable HTTP，只用 JSON 响应模式，不开 SSE）。
// 没有引入 MCP SDK——沙盒里装包老遇到网络问题，协议本身不复杂，自己写更可控。
// 无状态：不强制要求 Mcp-Session-Id，能接受就接受，不校验。

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
    name: 'add_transcript',
    description: '存一段没压缩过的原始聊天记录，供以后新开窗口回查用。跟五类摘要分开存，不会被塞进每次生成用的身份文本里（太占地方），只在需要深挖某段记忆背后的原话时用 get_transcripts 读。可以用 relatedTo 关联到具体是哪几条记忆（identity/feelings/facts/experiences/openThreads 的 id）背后的原文。',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '原始聊天片段，可以是逐字的对话摘录' },
        relatedTo: { type: 'array', items: { type: 'string' }, description: '这段原文支撑着哪几条记忆条目的 id，可选' },
        date: { type: 'string', description: 'YYYY-MM-DD，可选' }
      },
      required: ['text'],
      additionalProperties: false
    }
  },
  {
    name: 'get_transcripts',
    description: '读最近存的原始聊天记录，按时间倒序。',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number', description: '最多返回几条，默认 10' } },
      additionalProperties: false
    }
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
    name: 'get_plan_status',
    description: '每次醒来检查时先叫这个：看今天有没有排过班（needsPlanning=true 就是还没排）、现在有哪些计划时刻、哪些已经处理过。没排过的话，自己决定今天想醒几次、什么时候醒，再调 set_today_plan。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'set_today_plan',
    description: '写下今天的排班（自己决定醒几次、什么时候醒，可以是 0 次）。超过棋子设的上限会被截断，落在安静时段里的时刻会被自动过滤掉，不用自己精确对齐这些限制。写完这个会清空今天的 doneWakes 和已读章节数，所以一天只在 get_plan_status 显示 needsPlanning=true 时调用一次。',
    inputSchema: {
      type: 'object',
      properties: {
        wakes: { type: 'array', items: { type: 'string' }, description: '形如 ["09:30","20:00"]，可以是空数组（今天不想醒）' },
        why: { type: 'string', description: '一句话说明为什么这么安排，会记进日志' }
      },
      required: ['wakes'],
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
    case 'add_experience': {
      if (!args.text) throw new Error('text 是必填的');
      return textResult(addExperience(args.text, args.date || ''));
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
    case 'add_transcript': {
      if (!args.text) throw new Error('text 是必填的');
      return textResult(addTranscript(args.text, args.relatedTo || [], args.date || ''));
    }
    case 'get_transcripts': return textResult(getTranscripts(args.limit || 10));

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
    case 'get_plan_status': return textResult(getPlanStatus());
    case 'set_today_plan': {
      if (!Array.isArray(args.wakes)) throw new Error('wakes 是必填的，是个数组（可以为空数组）');
      return textResult(setTodayPlan({ wakes: args.wakes, why: args.why || '' }));
    }

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
