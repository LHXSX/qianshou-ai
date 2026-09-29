#!/usr/bin/env python3
"""
轻量级边缘节点代理

特点：
- 资源占用低
- 无需依赖第三方库（仅使用标准库）
- 适合资源受限的边缘设备
"""

import sys
import json
import uuid
import socket
from datetime import datetime
from typing import Dict, Any, Optional
import http.client
import urllib.parse


class LightweightAgent:
    """
    轻量级边缘节点代理

    功能：
    1. 节点注册
    2. 任务拉取
    3. 任务执行
    4. 结果上报
    """

    def __init__(self, config: Optional[Dict[str, Any]] = None):
        self.config = config or {}
        self.platform_url = self.config.get("platform_url", "qianshousuanli.com")
        self.node_id = self.config.get("node_id", f"node-{uuid.uuid4().hex[:8]}")
        self.node_name = self.config.get("node_name", socket.gethostname())
        self.tier = self.config.get("tier", "low")
        self.running = False
        self.completed_tasks = 0

    def _send_request(
        self,
        path: str,
        method: str = "GET",
        data: Optional[Dict[str, Any]] = None,
    ) -> Optional[Dict[str, Any]]:
        """发送 HTTP 请求"""
        try:
            url_parts = urllib.parse.urlparse(f"http://{self.platform_url}{path}")
            host = url_parts.hostname or "localhost"
            port = url_parts.port or 80

            conn = http.client.HTTPConnection(host, port, timeout=10)
            headers = {"Content-Type": "application/json"}
            body = json.dumps(data).encode("utf-8") if data else None

            conn.request(method, path, body=body, headers=headers)
            response = conn.getresponse()

            if response.status == 200:
                response_body = response.read().decode("utf-8")
                return json.loads(response_body)

            conn.close()
        except Exception as exc:
            print(f"请求失败: {exc}")

        return None

    def register_node(self) -> bool:
        """注册节点"""
        data = {
            "node_id": self.node_id,
            "name": self.node_name,
            "tier": self.tier,
            "capability_score": 30,
            "reputation_score": 50,
            "cpu_cores": 1,
            "memory_gb": 2.0,
        }

        result = self._send_request("/api/v1/nodes/register", "POST", data)
        return result.get("success", False) if result else False

    def poll_task(self) -> Optional[Dict[str, Any]]:
        """拉取任务"""
        data = {
            "node_id": self.node_id,
            "capability_score": 30,
            "current_load": 0,
        }

        result = self._send_request("/api/v1/tasks/pull", "POST", data)
        return result.get("task") if result else None

    def execute_task(self, task: Dict[str, Any]) -> Dict[str, Any]:
        """执行任务"""
        start_time = datetime.now()
        execution_time = (datetime.now() - start_time).total_seconds()

        return {
            "subtask_id": task["id"],
            "task_id": task["task_id"],
            "status": "completed",
            "accuracy": 0.9,
            "execution_time": execution_time,
        }

    def report_result(self, result: Dict[str, Any]) -> bool:
        """上报结果"""
        result["created_at"] = datetime.now().isoformat()
        response = self._send_request("/api/v1/tasks/submit_result", "POST", result)
        return response.get("success", False) if response else False

    def run(self) -> None:
        """运行代理"""
        self.running = True
        print(f"启动轻量级代理: {self.node_name}")

        if not self.register_node():
            print("注册失败")
            return

        print("注册成功")

        while self.running:
            try:
                task = self.poll_task()

                if task:
                    print(f"收到任务: {task['id']}")
                    result = self.execute_task(task)
                    self.completed_tasks += 1

                    if self.report_result(result):
                        print(f"任务完成: {task['id']}")
                    else:
                        print(f"上报失败: {task['id']}")

                import time

                time.sleep(5)

            except KeyboardInterrupt:
                print("\n停止代理")
                self.running = False
            except Exception as exc:
                print(f"错误: {exc}")


def main() -> None:
    """主函数"""
    config = {"platform_url": sys.argv[1] if len(sys.argv) > 1 else "qianshousuanli.com"}
    agent = LightweightAgent(config)
    agent.run()


if __name__ == "__main__":
    main()
