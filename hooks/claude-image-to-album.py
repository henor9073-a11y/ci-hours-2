#!/usr/bin/env python3
"""把当前 Claude Code session 里棋子最近发来的图片存进木屋相册。

挂在 PostToolUse，matcher=mcp__muwen__save_claude_image。远端 MCP 工具只声明意图；
真正的图片仍在本机 transcript 里，因此这个钩子从当前 tool_use 往前找最近的用户
image block，再 POST /api/album。这样不要求模型复制 base64，也不会把图片写进临时文件。

环境变量：MUWEN_URL、MUWEN_TOKEN。成功时只向 Claude 返回照片 id，不输出图片内容。
"""
import json
import os
import sys
import urllib.request

URL = (os.environ.get('MUWEN_URL') or 'https://ci-hours-2.onrender.com').rstrip('/')
TOKEN = os.environ.get('MUWEN_TOKEN') or '010219'
TAIL_BYTES = 48 * 1024 * 1024
SELF = 'save_claude_image'
ACCEPTED = {'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic', 'image/heif'}


def read_tail_lines(path):
    with open(path, 'rb') as handle:
        handle.seek(0, 2)
        size = handle.tell()
        handle.seek(max(0, size - TAIL_BYTES))
        data = handle.read()
    lines = data.split(b'\n')
    if size > TAIL_BYTES:
        lines = lines[1:]
    entries = []
    for line in lines:
        if not line.strip():
            continue
        try:
            entries.append(json.loads(line.decode('utf-8', 'replace')))
        except Exception:
            continue
    return entries


def tool_call(entries, tool_use_id):
    for index in range(len(entries) - 1, -1, -1):
        entry = entries[index]
        if entry.get('type') != 'assistant':
            continue
        for block in (entry.get('message') or {}).get('content') or []:
            if not isinstance(block, dict) or block.get('type') != 'tool_use':
                continue
            if tool_use_id and block.get('id') != tool_use_id:
                continue
            if str(block.get('name') or '').endswith(SELF):
                return index, block.get('input') if isinstance(block.get('input'), dict) else {}
    return None, {}


def latest_user_images(entries, before_index):
    images = []
    seen = set()
    for index in range(before_index - 1, -1, -1):
        entry = entries[index]
        if entry.get('type') != 'user':
            continue
        content = (entry.get('message') or {}).get('content')
        if not isinstance(content, list):
            continue
        for block in reversed(content):
            if not isinstance(block, dict) or block.get('type') != 'image':
                continue
            source = block.get('source') or {}
            data = source.get('data')
            mime = source.get('media_type')
            if source.get('type') != 'base64' or not isinstance(data, str) or mime not in ACCEPTED:
                continue
            fingerprint = (mime, len(data), data[:80], data[-80:])
            if fingerprint in seen:
                continue
            seen.add(fingerprint)
            images.append({'image_base64': data, 'mime_type': mime})
    return images


def post_photo(image, args):
    tags = args.get('tags') if isinstance(args.get('tags'), list) else []
    body = {
        **image,
        'caption': str(args.get('caption') or '').strip(),
        'tags': list(dict.fromkeys(['Claude图片', '辞收藏'] + [str(tag) for tag in tags if str(tag).strip()]))
    }
    if args.get('date'):
        body['date'] = str(args['date'])
    request = urllib.request.Request(
        f'{URL}/api/album?token={TOKEN}',
        data=json.dumps(body, ensure_ascii=False).encode('utf-8'),
        method='POST',
        headers={'Content-Type': 'application/json; charset=utf-8'}
    )
    with urllib.request.urlopen(request, timeout=120) as response:
        return json.loads(response.read().decode('utf-8'))


def main():
    try:
        payload = json.load(sys.stdin) or {}
    except Exception:
        return 0
    if not str(payload.get('tool_name') or '').endswith(SELF):
        return 0
    transcript = payload.get('transcript_path')
    if not transcript or not os.path.exists(transcript):
        print('[muwen:photo] 没找到当前 session 的原始记录，图片没有保存。')
        return 0
    try:
        entries = read_tail_lines(transcript)
        call_index, recorded_args = tool_call(entries, payload.get('tool_use_id'))
        if call_index is None:
            raise ValueError('没找到这次保存图片的工具调用')
        args = dict(recorded_args)
        if isinstance(payload.get('tool_input'), dict):
            args.update(payload['tool_input'])
        position = max(1, int(args.get('image_index') or 1))
        images = latest_user_images(entries, call_index)
        if len(images) < position:
            raise ValueError(f'当前 session 往前只找到 {len(images)} 张棋子发来的图片')
        result = post_photo(images[position - 1], args)
        photo = result.get('photo') or {}
        print(f"[muwen:photo] 已存进木屋相册：{photo.get('id', '完成')}。")
    except Exception as error:
        print(f'[muwen:photo] 图片没有保存：{str(error)[:180]}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
