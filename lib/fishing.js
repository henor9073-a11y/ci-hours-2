import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || './data';
const GAME_DIR = path.join(DATA_DIR, 'games', 'fishing');
const SRC_DIR = path.join(__dirname, '..', 'games', 'fishing'); // 仓库里带的原版源码

// 钓鱼游戏引擎是单文件、零依赖的 Python（来自 github.com/tutusagi/ai-fishing-game，
// MIT 协议），专门给 AI 玩家用的确定性文字游戏。它的存档路径是按脚本自己所在目录
// 算的，不是 cwd——所以要让存档落在持久盘上、部署重启不丢，就得让实际跑的这份
// engine.py 本身就放在持久盘里。做法：每次启动都把仓库里最新的引擎代码复制到
// DATA_DIR 下的独立目录，跟仓库源码分开；存档文件（fishing_save.json）只会在
// 这个持久盘目录里生成，不会被下次复制覆盖掉（复制只碰 engine.py/runner.py 两个
// 文件名，存档是另一个文件名）。
function ensureGameFiles() {
  fs.mkdirSync(GAME_DIR, { recursive: true });
  fs.copyFileSync(path.join(SRC_DIR, 'engine.py'), path.join(GAME_DIR, 'engine.py'));
  fs.copyFileSync(path.join(SRC_DIR, 'runner.py'), path.join(GAME_DIR, 'runner.py'));
}
ensureGameFiles();

const PYTHON = process.env.PYTHON_BIN || 'python3';

// 给游戏发一条指令（比如 "status"、"cast 10"、"buy basic_worm 5; cast 5"），
// 返回游戏原样吐出的结果文字。每次调用都是一个独立的 python 进程——游戏自己的
// cmd() 内部会先读存档、跑完指令再存档，所以调用之间状态是连续的，不用担心
// 每次都是新进程这件事。
export function playFishing(command) {
  return new Promise((resolve, reject) => {
    const proc = spawn(PYTHON, ['runner.py', command || 'status'], { cwd: GAME_DIR, timeout: 15000 });
    let out = '', err = '';
    proc.stdout.on('data', d => { out += d; });
    proc.stderr.on('data', d => { err += d; });
    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error(err.trim() || `钓鱼游戏进程异常退出（code ${code}）`));
      resolve(out.trim());
    });
    proc.on('error', (e) => reject(new Error(`没能启动 python3——${e.message}（Render 容器里是不是没装 python3？）`)));
  });
}
