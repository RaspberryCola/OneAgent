#!/usr/bin/env python3
"""
ACP 初始化测试脚本
通过 stdio 使用 JSON-RPC 2.0 协议与 Agent 通信

JSON-RPC 2.0 基本格式:
- 请求: {"jsonrpc": "2.0", "id": <数字>, "method": "<方法名>", "params": {...}}
- 响应: {"jsonrpc": "2.0", "id": <数字>, "result": {...}}
- 错误: {"jsonrpc": "2.0", "id": <数字>, "error": {"code": <错误码>, "message": "<错误信息>"}}
"""

import subprocess
import json
import sys
import threading
import time

# 注意：LSP 标准使用 Content-Length 头，但某些实现（如 qwen --acp）
# 直接使用换行符分隔的 JSON，更简单。


def create_initialize_request() -> dict:
    """
    创建 ACP initialize 请求

    这是 Client 与 Agent 建立连接后的第一个请求，
    用于协商协议版本和交换双方能力。
    """
    return {
        "jsonrpc": "2.0",
        "id": 1,  # 请求ID，响应时会原样返回，用于匹配请求和响应
        "method": "initialize",
        "params": {
            # 协议版本号（整数），目前是 1
            "protocolVersion": 1,
            # Client 能力声明
            "clientCapabilities": {
                # 文件系统能力
                "fs": {
                    "readTextFile": True,   # 支持 fs/read_text_file 方法
                    "writeTextFile": True,  # 支持 fs/write_text_file 方法
                },
                # 终端能力：支持 terminal/* 方法
                "terminal": True,
            },
            # Client 实现信息
            "clientInfo": {
                "name": "test-client",      # 程序化使用的名称
                "title": "Test Client",    # 人类可读的标题
                "version": "1.0.0",
            },
        },
    }


def create_session_list_request(cwd: str = None, cursor: str = None) -> dict:
    """
    创建 ACP session/list 请求

    用于获取 Agent 已知的会话列表，用于显示会话历史和切换会话。

    Args:
        cwd: 可选，按工作目录过滤会话（必须是绝对路径）
        cursor: 可选，分页游标，来自上一次响应的 nextCursor 字段
    """
    params = {}
    if cwd:
        params["cwd"] = cwd
    if cursor:
        params["cursor"] = cursor

    return {
        "jsonrpc": "2.0",
        "id": 2,  # 使用不同的 ID
        "method": "session/list",
        "params": params,
    }


def send_request(agent_process: subprocess.Popen, request: dict, use_content_length: bool = False) -> dict:
    """
    通过 stdio 向 Agent 发送 JSON-RPC 请求并接收响应

    Args:
        agent_process: Agent 子进程
        request: JSON-RPC 请求对象
        use_content_length: 是否使用 Content-Length 头（LSP 标准格式）

    Returns:
        解析后的 JSON-RPC 响应对象

    注意:
    - LSP 标准格式使用 Content-Length 头:
        Content-Length: <字节数>\r\n
        \r\n
        <JSON 内容>
    - 某些实现直接使用换行符分隔的 JSON（每行一个 JSON 对象）
    """
    # 将请求序列化为 JSON 字符串
    json_str = json.dumps(request, ensure_ascii=False)
    json_bytes = json_str.encode("utf-8")

    if use_content_length:
        # LSP 标准格式：带 Content-Length 头
        message = f"Content-Length: {len(json_bytes)}\r\n\r\n".encode("utf-8") + json_bytes
    else:
        # 简单格式：直接发送 JSON，换行符结尾
        message = json_bytes + b"\n"

    print(f"\n{'='*60}")
    print("📤 发送请求:")
    print("-" * 60)
    print(json.dumps(request, indent=2, ensure_ascii=False))

    # 写入 Agent 的 stdin
    agent_process.stdin.write(message)
    agent_process.stdin.flush()

    # 读取响应
    response = read_response(agent_process, use_content_length=use_content_length)

    print(f"\n{'='*60}")
    print("📥 收到响应:")
    print("-" * 60)
    print(json.dumps(response, indent=2, ensure_ascii=False))

    return response


def read_response(agent_process: subprocess.Popen, timeout: float = 10.0, use_content_length: bool = False) -> dict:
    """
    从 Agent 的 stdout 读取 JSON-RPC 响应

    Args:
        agent_process: Agent 子进程
        timeout: 超时时间（秒）
        use_content_length: 是否使用 Content-Length 头格式
    """
    start_time = time.time()

    while True:
        # 检查超时
        if time.time() - start_time > timeout:
            raise TimeoutError(f"等待响应超时（{timeout}秒）")

        # 检查进程是否已结束
        if agent_process.poll() is not None:
            raise ValueError(f"Agent 进程已退出，返回码: {agent_process.returncode}")

        try:
            if use_content_length:
                # LSP 标准格式：解析 Content-Length 头
                headers = {}
                while True:
                    line = agent_process.stdout.readline().decode("utf-8")
                    if not line:
                        time.sleep(0.1)
                        continue
                    if line == "\r\n" or line == "\n":
                        break
                    if ":" in line:
                        key, value = line.split(":", 1)
                        headers[key.strip()] = value.strip()
                        print(f"   收到头: {key.strip()} = {value.strip()}")

                content_length = int(headers.get("Content-Length", 0))
                if content_length == 0:
                    raise ValueError("响应中没有 Content-Length 头")

                content = agent_process.stdout.read(content_length).decode("utf-8")
                return json.loads(content)
            else:
                # 简单格式：读取一行 JSON
                line = agent_process.stdout.readline()
                if not line:
                    time.sleep(0.1)
                    continue

                line = line.decode("utf-8").strip()
                if not line:
                    continue

                return json.loads(line)

        except json.JSONDecodeError as e:
            print(f"   JSON 解析错误: {e}")
            time.sleep(0.1)
            continue
        except Exception as e:
            time.sleep(0.1)
            continue


def read_stderr(agent_process: subprocess.Popen):
    """后台线程：持续读取并打印 Agent 的 stderr 输出"""
    while True:
        line = agent_process.stderr.readline()
        if not line:
            break
        print(f"\n[Agent stderr] {line.decode('utf-8', errors='ignore').rstrip()}")


def main():
    """
    主函数：启动 Agent 进程并发送 initialize 请求

    使用方式:
        python test_acp_init.py <agent_command>

    示例:
        python test_acp_init.py "qwen --agent"
        python test_acp_init.py "./my-agent"
    """
    # 检查命令行参数
    if len(sys.argv) < 2:
        print("用法: python test_acp_init.py <agent_command>")
        print("示例: python test_acp_init.py \"qwen --agent\"")
        sys.exit(1)

    agent_command = sys.argv[1]
    print(f"🚀 启动 Agent: {agent_command}")
    print("=" * 60)

    # 启动 Agent 子进程
    # stdin=subprocess.PIPE: 允许我们向 Agent 写入数据
    # stdout=subprocess.PIPE: 允许我们从 Agent 读取数据
    # stderr=subprocess.PIPE: 捕获 Agent 的错误输出（避免干扰 JSON-RPC 通信）
    agent_process = subprocess.Popen(
        agent_command,
        shell=True,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=False,  # 使用二进制模式，避免编码问题
    )

    # 启动后台线程读取 stderr
    stderr_thread = threading.Thread(target=read_stderr, args=(agent_process,), daemon=True)
    stderr_thread.start()

    try:
        # ========================================
        # 第一步：initialize 请求
        # ========================================
        request = create_initialize_request()
        response = send_request(agent_process, request)

        # 解析 initialize 响应中的关键信息
        print(f"\n{'='*60}")
        print("📋 解析结果:")
        print("-" * 60)

        if "result" in response:
            result = response["result"]
            print(f"协议版本: {result.get('protocolVersion')}")

            # Agent 能力
            capabilities = result.get("agentCapabilities", {})
            print(f"Agent 名称: {result.get('agentInfo', {}).get('name')}")
            print(f"Agent 版本: {result.get('agentInfo', {}).get('version')}")

            # 检查是否支持 session/list
            session_capabilities = capabilities.get("sessionCapabilities", {})
            supports_session_list = "list" in session_capabilities
            print(f"支持 session/list: {supports_session_list}")

            print("\n✅ 初始化成功!")

            # ========================================
            # 第二步：session/list 请求（如果支持）
            # ========================================
            if supports_session_list:
                print(f"\n{'='*60}")
                print("🔍 测试 session/list:")
                print("=" * 60)

                # 循环获取所有页面的会话
                all_sessions = []
                page = 1
                cursor = None

                while True:
                    print(f"\n--- 第 {page} 页 ---")

                    # 创建 session/list 请求
                    session_list_request = create_session_list_request(cursor=cursor)
                    session_list_response = send_request(agent_process, session_list_request)

                    if "result" in session_list_response:
                        result = session_list_response["result"]
                        sessions = result.get("sessions", [])
                        next_cursor = result.get("nextCursor")

                        all_sessions.extend(sessions)
                        print(f"   本页返回: {len(sessions)} 个会话")
                        print(f"   累计: {len(all_sessions)} 个会话")
                        print(f"   nextCursor: {next_cursor if next_cursor else '无（最后一页）'}")

                        # 如果没有 nextCursor，说明是最后一页
                        if not next_cursor:
                            break

                        # 更新 cursor 继续下一页
                        cursor = next_cursor
                        page += 1

                    elif "error" in session_list_response:
                        error = session_list_response["error"]
                        print(f"❌ 错误: {error.get('message')} (代码: {error.get('code')})")
                        break

                # 显示所有会话汇总
                print(f"\n{'='*60}")
                print("📋 会话列表汇总:")
                print("-" * 60)
                print(f"总页数: {page}")
                print(f"总会话数: {len(all_sessions)}")

                if all_sessions:
                    print(f"\n所有会话:")
                    for i, session in enumerate(all_sessions, 1):
                        print(f"\n  会话 {i}:")
                        print(f"    ID: {session.get('sessionId')}")
                        print(f"    目录: {session.get('cwd')}")
                        print(f"    标题: {session.get('title', '(无标题)')}")
                        print(f"    更新时间: {session.get('updatedAt')}")
                else:
                    print("没有找到任何会话")

                # 分页说明
                print(f"\n{'='*60}")
                print("💡 分页说明:")
                print("-" * 60)
                print("  - 如果 Agent 返回 nextCursor，则还有更多数据")
                print("  - 将 nextCursor 传入下一次请求的 cursor 参数获取下一页")
                print("  - 如果没有 nextCursor，说明已经是最后一页")
                if page == 1 and len(all_sessions) <= 5:
                    print(f"\n  ⚠️  当前只有 {len(all_sessions)} 个会话，没有触发分页")
                    print("  要测试分页，需要创建更多会话（超过 Agent 的默认页面大小）")

            else:
                print("\n⚠️  Agent 不支持 session/list，跳过测试")

        elif "error" in response:
            error = response["error"]
            print(f"❌ 错误: {error.get('message')} (代码: {error.get('code')})")

    except TimeoutError as e:
        print(f"\n❌ {e}")
        print("\n💡 可能的原因:")
        print("   1. Agent 不支持 ACP 协议（没有响应 JSON-RPC 请求）")
        print("   2. Agent 需要特殊参数来启用 ACP 模式")
        print("   3. Agent 在等待其他输入或初始化")

        # 检查进程状态
        if agent_process.poll() is not None:
            print(f"\n   Agent 进程已退出，返回码: {agent_process.returncode}")

    except Exception as e:
        print(f"\n❌ 发生错误: {e}")

    finally:
        # 关闭进程
        agent_process.terminate()
        agent_process.wait()
        print("\n🏁 Agent 进程已关闭")


if __name__ == "__main__":
    main()
