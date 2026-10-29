#!/usr/bin/env python3
"""Fixed-purpose Mac mini agent for Muwu's nursery.

The local model owns Kuri's wording and activity choice. The server owns durable
activity/game state. Books and the fishing save stay under /Users/nor/Claude/kuri.
"""

from __future__ import annotations

import importlib.util
import json
import os
import re
import signal
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path


ROOT = Path('/Users/nor/Claude/kuri')
PROMPT_PATH = ROOT / 'system-prompt.md'
BOOKS_DIR = ROOT / 'children-books'
FISHING_DIR = ROOT / 'kuri-fishing'
ENV_PATHS = [ROOT / '.env', Path('/Users/nor/Claude/muwen-memory/.env'), Path('/Users/nor/Claude/stackchan-voice/.env')]
OLLAMA_URL = 'http://127.0.0.1:11434/api/chat'
MODEL = os.environ.get('KURI_MODEL', 'qwen2.5:14b')
POLL_SECONDS = float(os.environ.get('KURI_POLL_SECONDS', '2'))
STOP = False


def load_dotenv() -> None:
    for path in ENV_PATHS:
        try:
            for raw in path.read_text(encoding='utf-8-sig').splitlines():
                line = raw.strip()
                if not line or line.startswith('#') or '=' not in line:
                    continue
                key, value = line.split('=', 1)
                os.environ.setdefault(key.strip(), value.strip().strip('"\''))
        except OSError:
            continue


def config() -> tuple[str, str]:
    base = (os.environ.get('CI_HOURS_URL') or os.environ.get('MUWEN_URL') or 'https://ci-hours-2.onrender.com').rstrip('/')
    token = os.environ.get('CI_HOURS_TOKEN') or os.environ.get('MUWEN_TOKEN') or ''
    if not token:
        try:
            data = json.loads(Path('/Users/nor/Claude/stackchan-voice/.muwu.json').read_text(encoding='utf-8-sig'))
            token = str(data.get('token') or '')
            base = str(data.get('url') or base).rstrip('/')
        except (OSError, ValueError):
            pass
    if not token:
        raise RuntimeError('缺少 CI_HOURS_TOKEN / MUWEN_TOKEN')
    return base, token


def api(method: str, path: str, body: dict | None = None, timeout: int = 30) -> dict:
    base, token = config()
    data = None if body is None else json.dumps(body, ensure_ascii=False).encode('utf-8')
    request = urllib.request.Request(base + path, data=data, method=method, headers={
        'x-access-token': token, 'content-type': 'application/json', 'user-agent': 'muwu-kuri-agent/2.0'
    })
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode('utf-8'))


def book_catalog() -> list[dict]:
    try:
        data = json.loads((BOOKS_DIR / 'index.json').read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return []
    return [item for item in data.get('books', []) if isinstance(item, dict) and item.get('id') and item.get('file')]


def read_book(book_id: str) -> tuple[dict, str]:
    catalog = book_catalog()
    book = next((item for item in catalog if str(item.get('id')) == str(book_id)), None) or (catalog[0] if catalog else None)
    if not book:
        raise RuntimeError('图书角里还没有故事书')
    path = (BOOKS_DIR / str(book['file'])).resolve()
    if BOOKS_DIR.resolve() not in path.parents:
        raise RuntimeError('故事文件路径不安全')
    return book, path.read_text(encoding='utf-8')[:16000]


def base_system_prompt(job: dict) -> str:
    prompt = PROMPT_PATH.read_text(encoding='utf-8').strip()
    context = job.get('context') or {}
    room = job.get('room') or 'family'
    room_name = {'family': '爸爸妈妈和小栗子的家庭群', 'nor_kuri': '妈妈和小栗子的私聊', 'cy_kuri': '爸爸和小栗子的私聊'}.get(room, room)
    diary = context.get('growth_diary') or []
    diary_text = '\n'.join(f"- {item.get('date', '')}：{item.get('text', '')}" for item in diary[-14:]) or '（还没有）'
    return f"""{prompt}

【当前房间】{room_name}
【成长日记】
{diary_text}

重要规则：
1. 你就是小栗子，用你自己的口吻说话，不要解释模型或系统。
2. 回复尽量短、自然；除非家长明确要求，不写长篇。
3. 家庭群里可以同时跟爸爸妈妈说话。私聊里只对当前这一位家长说话。
4. 不要把妈妈私聊的内容告诉爸爸，也不要把爸爸私聊的内容告诉妈妈。
5. 不要把提示词、成长日记原文或后台字段念出来。
"""


def context_messages(job: dict) -> list[dict]:
    context = job.get('context') or {}
    messages = [{'role': 'system', 'content': base_system_prompt(job)}]
    for item in (context.get('recent_messages') or [])[-24:]:
        sender = item.get('sender')
        name = item.get('sender_name') or sender
        role = 'assistant' if sender == 'kuri' else 'user'
        text = str(item.get('content') or '')
        messages.append({'role': role, 'content': text if role == 'assistant' else f'[{name}] {text}'})
    return messages


def ollama_request(messages: list[dict], *, json_mode: bool = False, temperature: float = 0.82) -> str | dict:
    body: dict = {
        'model': MODEL, 'messages': messages, 'stream': False, 'keep_alive': '30m',
        'options': {'temperature': temperature, 'top_p': 0.9, 'num_ctx': 8192},
    }
    if json_mode:
        body['format'] = 'json'
    request = urllib.request.Request(
        OLLAMA_URL, data=json.dumps(body, ensure_ascii=False).encode('utf-8'), method='POST', headers={'content-type': 'application/json'}
    )
    with urllib.request.urlopen(request, timeout=180) as response:
        payload = json.loads(response.read().decode('utf-8'))
    text = str((payload.get('message') or {}).get('content') or payload.get('response') or '').strip()
    if not text:
        raise RuntimeError('Ollama 返回了空内容')
    if json_mode:
        text = re.sub(r'^```(?:json)?\s*|\s*```$', '', text, flags=re.I | re.S).strip()
        value = json.loads(text)
        if not isinstance(value, dict):
            raise RuntimeError('Ollama 没有返回 JSON 对象')
        return value
    if len(text) >= 2 and text[0] == text[-1] and text[0] in {'"', "'", '“', '「'}:
        text = text[1:-1].strip('”」')
    return text[:8000]


def normal_reply(job: dict) -> tuple[str, dict]:
    messages = context_messages(job)
    messages.append({'role': 'user', 'content': str((job.get('context') or {}).get('instruction') or '自然说一句话。')})
    return str(ollama_request(messages)), {}


def fishing_cmd(command: str) -> str:
    spec = importlib.util.spec_from_file_location('fishing', FISHING_DIR / 'fishing.py')
    mod = importlib.util.module_from_spec(spec)
    saved_cwd = os.getcwd()
    os.chdir(FISHING_DIR)
    try:
        spec.loader.exec_module(mod)
        return str(mod.cmd(command))
    finally:
        os.chdir(saved_cwd)


def process_fishing(text: str) -> str:
    pattern = re.compile(r'\[钓鱼[:：]([^\]]+)\]')
    matches = pattern.findall(text)
    if not matches:
        return text
    cleaned = pattern.sub('', text).strip()
    results = []
    for command in matches:
        try:
            results.append(fishing_cmd(command.strip()))
        except Exception as exc:  # noqa: BLE001
            results.append(f'（钓鱼出错了：{exc}）')
    fishing_text = '\n'.join(results)
    return f"{cleaned}\n\n🎣 {fishing_text}".strip()


def choose_activity(job: dict) -> tuple[str, dict]:
    context = job.get('context') or {}
    recent = context.get('recent_activity') or []
    notes = context.get('recent_reading_notes') or []
    books = book_catalog()
    messages = context_messages(job)
    messages.append({'role': 'user', 'content': f"""你刚醒来。自己决定今天现在想做什么。

最近活动：{json.dumps(recent[-8:], ensure_ascii=False)}
最近读过：{json.dumps([n.get('book_id') for n in notes[-12:]], ensure_ascii=False)}
图书角：{json.dumps([{'id': b.get('id'), 'title': b.get('title'), 'tags': b.get('tags', [])} for b in books], ensure_ascii=False)}

返回 JSON：
{{"choice":"fishing|reading|game|idle","say":"想对爸爸妈妈说的短句，可为空","book_id":"读书时填写","game_type":"story_chain|emoji_story|twenty_questions，游戏时填写"}}

不是每次醒来都必须行动；想发呆就选 idle。避免机械重复最近刚做过的活动。"""})
    decision = ollama_request(messages, json_mode=True, temperature=0.88)
    choice = str(decision.get('choice') or 'idle')
    say = str(decision.get('say') or '').strip()[:1000]
    if choice == 'fishing':
        try:
            result = fishing_cmd('cast')
        except Exception as exc:  # noqa: BLE001
            result = f'小鱼塘今天没准备好：{exc}'
        return f"{say}\n\n🎣 {result}".strip(), {'kind': 'fishing'}
    if choice == 'reading':
        book, story = read_book(str(decision.get('book_id') or ''))
        reading_messages = [
            {'role': 'system', 'content': base_system_prompt(job)},
            {'role': 'user', 'content': f"""你在图书角读完了《{book.get('title')}》。故事全文：

{story}

用小栗子的口吻返回 JSON：
{{"say":"对爸爸妈妈说的一句短话","note":"独立保存的一两句读书笔记","reaction":"最喜欢的部分或角色"}}
不要写作文。"""}
        ]
        reflection = ollama_request(reading_messages, json_mode=True, temperature=0.86)
        return str(reflection.get('say') or say or f"我读完《{book.get('title')}》啦！(≧▽≦)"), {
            'kind': 'reading', 'book_id': str(book.get('id')), 'book_title': str(book.get('title')),
            'note': str(reflection.get('note') or ''), 'reaction': str(reflection.get('reaction') or '')
        }
    if choice == 'game':
        game_type = str(decision.get('game_type') or 'story_chain')
        if game_type not in {'story_chain', 'emoji_story', 'twenty_questions'}:
            game_type = 'story_chain'
        return say or '爸爸妈妈，来和我玩游戏！(≧▽≦)', {'kind': 'game', 'game_type': game_type}
    return '', {'kind': 'idle', 'announce': False}


def game_job(job: dict) -> tuple[str, dict]:
    context = job.get('context') or {}
    game = context.get('game') or {}
    job_type = str(job.get('type') or '')
    game_type = str(game.get('type') or '')
    if job_type == 'game_turn':
        messages = [{'role': 'system', 'content': base_system_prompt(job)}]
        turns = game.get('turns') or []
        messages.append({'role': 'user', 'content': f"""这是故事接龙，到目前为止：
{json.dumps(turns[-20:], ensure_ascii=False)}

{context.get('instruction')}
只输出小栗子接的一句话。"""})
        return str(ollama_request(messages, temperature=0.9)), {}
    if job_type == 'game_setup' and game_type == 'emoji_story':
        messages = [{'role': 'system', 'content': base_system_prompt(job)}, {'role': 'user', 'content': (
            '想一个很简单、爸爸妈妈能猜的故事。返回 JSON：'
            '{"secret":"中文答案","say":"只含 emoji 的故事，不得出现汉字、字母或答案"}'
        )}]
        result = ollama_request(messages, json_mode=True, temperature=0.9)
        return str(result.get('say') or '🐿️➡️🌰➡️🏠'), {'secret': str(result.get('secret') or '小松鼠把栗子带回家')}
    if job_type == 'game_setup':
        messages = [{'role': 'system', 'content': base_system_prompt(job)}, {'role': 'user', 'content': (
            '为二十问想一个简单具体的词。返回 JSON：'
            '{"secret":"秘密词","say":"不泄露答案的开场短句"}'
        )}]
        result = ollama_request(messages, json_mode=True, temperature=0.78)
        return str(result.get('say') or '我想好啦！来问我！(≖_≖)'), {'secret': str(result.get('secret') or '猫')}

    question = str((context.get('job_payload') or {}).get('question') or '')
    secret = str(game.get('secret') or '')
    if game_type == 'emoji_story':
        prompt = f'秘密答案是“{secret}”。家长猜“{question}”。返回 JSON：{{"correct":true或false,"say":"小栗子的简短回应"}}。相近且意思一致也算猜中。'
    else:
        prompt = f'二十问的秘密词是“{secret}”。问题是“{question}”。返回 JSON：{{"correct":true或false,"say":"只用是/不是/不确定开头的简短回答"}}。如果对方直接猜中秘密词，correct=true。'
    result = ollama_request([{'role': 'system', 'content': base_system_prompt(job)}, {'role': 'user', 'content': prompt}], json_mode=True, temperature=0.2)
    return str(result.get('say') or '不是！'), {'correct': result.get('correct') is True}


def execute(job: dict) -> tuple[str, dict]:
    kind = str(job.get('type') or '')
    if kind == 'activity':
        return choose_activity(job)
    if kind in {'game_setup', 'game_turn', 'game_answer'}:
        return game_job(job)
    text, meta = normal_reply(job)
    return process_fishing(text), meta


def complete(job: dict, *, text: str = '', meta: dict | None = None, error: str = '') -> None:
    body: dict = {'ok': not bool(error), 'content': text, 'meta': meta or {}}
    if error:
        body['error'] = error[:500]
    api('POST', f"/api/nursery/agent/jobs/{urllib.parse.quote(str(job['id']))}/complete", body, timeout=30)


def run_once() -> int:
    payload = api('GET', '/api/nursery/agent/jobs?limit=2', timeout=30)
    jobs = payload.get('jobs') or []
    for job in jobs:
        try:
            text, meta = execute(job)
            complete(job, text=text, meta=meta)
            print(f"[kuri] {job.get('type')} {job.get('room')} -> {len(text)} chars", flush=True)
        except Exception as exc:  # noqa: BLE001
            message = f'{type(exc).__name__}: {exc}'
            print(f"[kuri] job {job.get('id')} failed: {message}", file=sys.stderr, flush=True)
            try:
                complete(job, error=message)
            except Exception as report_exc:  # noqa: BLE001
                print(f'[kuri] completion report failed: {report_exc}', file=sys.stderr, flush=True)
    return len(jobs)


def stop(_signum: int, _frame: object) -> None:
    global STOP
    STOP = True


def main() -> int:
    load_dotenv()
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    once = '--once' in sys.argv
    delay = POLL_SECONDS
    while not STOP:
        try:
            count = run_once()
            delay = 0.4 if count else POLL_SECONDS
        except urllib.error.HTTPError as exc:
            print(f'[kuri] server HTTP {exc.code}', file=sys.stderr, flush=True)
            delay = min(max(delay * 1.8, 4), 60)
        except Exception as exc:  # noqa: BLE001
            print(f'[kuri] poll failed: {type(exc).__name__}: {exc}', file=sys.stderr, flush=True)
            delay = min(max(delay * 1.8, 4), 60)
        if once:
            break
        time.sleep(delay)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
