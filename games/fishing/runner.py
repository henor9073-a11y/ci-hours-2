import sys
import os

# engine.py 的存档路径是按它自己 __file__ 所在目录算的（不是 cwd），
# 所以这个 runner.py 必须跟 engine.py 放在同一个目录里，存档才会落在
# 持久盘上、部署重启也不丢。
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import engine

if __name__ == "__main__":
    command = " ".join(sys.argv[1:]).strip()
    print(engine.cmd(command))
