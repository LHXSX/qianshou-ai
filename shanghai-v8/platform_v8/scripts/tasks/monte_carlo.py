#!/usr/bin/env python3
"""monte_carlo — 蒙特卡洛模拟 (企业级 · 2026-06-07 S5 升级)

新增模拟:
  - pi          (π 估算)
  - integral    (函数定积分 · **AST 安全表达式** · 防 RCE)
  - option_bs   (Black-Scholes 期权定价)
  - random_walk (随机游走 · 终值分布)
  - dice        (骰子模拟 · 期望+方差)

安全:
  - integral expression 用 AST 白名单解析 · 仅允许数学函数(sin/cos/exp/log/sqrt/x)
  - 拒绝 eval/exec/import/__ 等任何调用

性能:
  - **多进程并行**(默认 CPU 核数,大幅加速)
  - 每核分摊样本数

参数 (EC_PARAMS):
  simulation     str   pi / integral / option_bs / random_walk / dice
  samples        int   样本数 (默认 100k)
  seed           int   随机种子 (默认 42)
  parallel       int   进程数 (默认 CPU 核数 · 1=单进程)
  --- integral ---
  expression     str   被积函数 (变量 x · 如 "x**2+sin(x)")
  a              float 下限
  b              float 上限
  --- option_bs ---
  spot/strike/rate/volatility/maturity/option_type(call/put)
  --- random_walk ---
  steps          int   每条游走步数
  start          float 起点 (默认 0)
  --- dice ---
  sides          int   面数 (默认 6)
  throws         int   每样本投几次
"""
import ast
import json
import math
import os
import random
import sys
import time
from multiprocessing import Pool, cpu_count


# ─────────────────────────────────────────────────
# 安全表达式 evaluator (替代 eval · 防 RCE)
# ─────────────────────────────────────────────────
_SAFE_FUNCS = {
    "sin": math.sin, "cos": math.cos, "tan": math.tan,
    "asin": math.asin, "acos": math.acos, "atan": math.atan,
    "sinh": math.sinh, "cosh": math.cosh, "tanh": math.tanh,
    "exp": math.exp, "log": math.log, "log2": math.log2, "log10": math.log10,
    "sqrt": math.sqrt, "abs": abs, "min": min, "max": max,
    "pow": pow, "ceil": math.ceil, "floor": math.floor,
    "pi": math.pi, "e": math.e, "tau": math.tau,
}


def _safe_eval(node, x_val: float):
    """AST 节点递归求值 · 只允许数学操作和变量 x"""
    if isinstance(node, ast.Expression):
        return _safe_eval(node.body, x_val)
    if isinstance(node, ast.Constant):
        if isinstance(node.value, (int, float)):
            return node.value
        raise ValueError(f"禁止常量类型: {type(node.value).__name__}")
    if isinstance(node, ast.Name):
        if node.id == "x":
            return x_val
        if node.id in _SAFE_FUNCS and not callable(_SAFE_FUNCS[node.id]):
            return _SAFE_FUNCS[node.id]  # pi/e/tau
        raise ValueError(f"未知变量: {node.id}")
    if isinstance(node, ast.BinOp):
        l = _safe_eval(node.left, x_val)
        r = _safe_eval(node.right, x_val)
        if isinstance(node.op, ast.Add):       return l + r
        if isinstance(node.op, ast.Sub):       return l - r
        if isinstance(node.op, ast.Mult):      return l * r
        if isinstance(node.op, ast.Div):       return l / r
        if isinstance(node.op, ast.Pow):       return l ** r
        if isinstance(node.op, ast.Mod):       return l % r
        if isinstance(node.op, ast.FloorDiv):  return l // r
        raise ValueError(f"禁止操作符: {type(node.op).__name__}")
    if isinstance(node, ast.UnaryOp):
        v = _safe_eval(node.operand, x_val)
        if isinstance(node.op, ast.USub):  return -v
        if isinstance(node.op, ast.UAdd):  return +v
        raise ValueError("禁止一元操作符")
    if isinstance(node, ast.Call):
        if not isinstance(node.func, ast.Name) or node.func.id not in _SAFE_FUNCS:
            raise ValueError(f"禁止调用: {ast.dump(node.func)}")
        fn = _SAFE_FUNCS[node.func.id]
        if not callable(fn):
            raise ValueError(f"非函数: {node.func.id}")
        args = [_safe_eval(a, x_val) for a in node.args]
        return fn(*args)
    raise ValueError(f"禁止 AST 节点: {type(node).__name__}")


def _compile_expr(expr: str):
    """编译表达式为安全可调用函数"""
    tree = ast.parse(expr, mode="eval")
    # 静态检测危险标识符
    for node in ast.walk(tree):
        if isinstance(node, ast.Name) and node.id.startswith("__"):
            raise ValueError(f"禁止 dunder 标识符: {node.id}")
        if isinstance(node, ast.Attribute):
            raise ValueError("禁止属性访问")
    def f(x):
        return _safe_eval(tree, x)
    return f


# ─────────────────────────────────────────────────
# 各模拟核心(返 (results_dict_partial, samples_done))
# ─────────────────────────────────────────────────
def _sim_pi(n: int, seed: int) -> tuple:
    rnd = random.Random(seed)
    hits = 0
    for _ in range(n):
        x, y = rnd.random(), rnd.random()
        if x * x + y * y <= 1:
            hits += 1
    return {"hits": hits, "samples": n}


def _sim_integral(args: tuple) -> dict:
    n, seed, expr_str, a, b = args
    f = _compile_expr(expr_str)
    rnd = random.Random(seed)
    total = 0.0
    sum_sq = 0.0
    for _ in range(n):
        x = rnd.uniform(a, b)
        v = f(x)
        total += v
        sum_sq += v * v
    return {"sum": total, "sum_sq": sum_sq, "samples": n}


def _sim_option_bs(args: tuple) -> dict:
    n, seed, spot, strike, rate, vol, T, opt_type = args
    rnd = random.Random(seed)
    payoff_sum = 0.0
    payoff_sq = 0.0
    for _ in range(n):
        # GBM 终值: S * exp((r - 0.5σ²)T + σ√T·Z)
        z = rnd.gauss(0, 1)
        ST = spot * math.exp((rate - 0.5 * vol * vol) * T + vol * math.sqrt(T) * z)
        if opt_type == "call":
            payoff = max(ST - strike, 0)
        else:
            payoff = max(strike - ST, 0)
        payoff_sum += payoff
        payoff_sq += payoff * payoff
    return {"sum": payoff_sum, "sum_sq": payoff_sq, "samples": n}


def _sim_random_walk(args: tuple) -> dict:
    n, seed, steps, start = args
    rnd = random.Random(seed)
    finals = []
    for _ in range(n):
        x = start
        for _ in range(steps):
            x += 1 if rnd.random() > 0.5 else -1
        finals.append(x)
    return {
        "finals_sum": sum(finals), "finals_sq": sum(f * f for f in finals),
        "min": min(finals), "max": max(finals), "samples": n,
    }


def _sim_dice(args: tuple) -> dict:
    n, seed, sides, throws = args
    rnd = random.Random(seed)
    sum_total = 0
    sum_sq = 0
    for _ in range(n):
        s = sum(rnd.randint(1, sides) for _ in range(throws))
        sum_total += s
        sum_sq += s * s
    return {"sum": sum_total, "sum_sq": sum_sq, "samples": n}


# ─────────────────────────────────────────────────
# 并行调度
# ─────────────────────────────────────────────────
def _parallel_run(fn, total_n: int, parallel: int, base_seed: int, *extra) -> list:
    """把 total_n 分到 parallel 个进程 · 各用不同 seed · 收集 partial 结果"""
    per = total_n // parallel
    rem = total_n % parallel
    args_list = []
    for i in range(parallel):
        n_i = per + (1 if i < rem else 0)
        if n_i == 0:
            continue
        args_list.append((n_i, base_seed + i * 9973, *extra))
    if parallel <= 1 or len(args_list) <= 1:
        return [fn(a) for a in args_list]
    with Pool(parallel) as p:
        return p.map(fn, args_list)


def _pi_worker(args):
    n, seed = args
    return _sim_pi(n, seed)


def main():
    t0 = time.time()
    try:
        params = json.loads(os.environ.get("EC_PARAMS", "{}"))
    except Exception as e:
        print(json.dumps({"status": "failed", "task_type": "monte_carlo",
                          "error": f"EC_PARAMS 不合法: {e}",
                          "summary_text": "❌ 参数错"}, ensure_ascii=False))
        return 1

    sim = params.get("simulation", "pi")
    n = max(1, min(int(params.get("samples", 100_000)), 5_000_000))
    seed = int(params.get("seed", 42))
    # 不得独占节点；调度层可再通过 runtime 限制收紧。
    parallel = int(params.get("parallel") or 1)
    parallel = max(1, min(parallel, min(4, cpu_count())))

    try:
        if sim == "pi":
            partials = _parallel_run(_pi_worker, n, parallel, seed)
            total_hits = sum(p["hits"] for p in partials)
            total_n = sum(p["samples"] for p in partials)
            estimated_pi = 4 * total_hits / total_n
            output = {
                "simulation": "pi", "samples": total_n,
                "result": estimated_pi,
                "error": abs(estimated_pi - math.pi),
                "stdev_estimate": math.sqrt(estimated_pi * (4 - estimated_pi) / total_n),
            }

        elif sim == "integral":
            expr = params.get("expression", "x**2")
            a = float(params.get("a", 0))
            b = float(params.get("b", 1))
            # 预编译 1 次 · 验证表达式合法
            _compile_expr(expr)
            partials = _parallel_run(_sim_integral, n, parallel, seed, expr, a, b)
            tot_sum = sum(p["sum"] for p in partials)
            tot_sq = sum(p["sum_sq"] for p in partials)
            tot_n = sum(p["samples"] for p in partials)
            mean = tot_sum / tot_n
            var = max(0, tot_sq / tot_n - mean * mean)
            result = (b - a) * mean
            stderr = (b - a) * math.sqrt(var / tot_n)
            output = {
                "simulation": "integral", "expression": expr,
                "range": [a, b], "samples": tot_n,
                "result": result,
                "stderr": stderr,
                "confidence_95": [result - 1.96 * stderr, result + 1.96 * stderr],
            }

        elif sim == "option_bs":
            spot = float(params.get("spot", 100))
            strike = float(params.get("strike", 100))
            rate = float(params.get("rate", 0.05))
            vol = float(params.get("volatility", 0.2))
            T = float(params.get("maturity", 1.0))
            opt = params.get("option_type", "call").lower()
            if opt not in ("call", "put"):
                raise ValueError("option_type 必须是 call/put")
            partials = _parallel_run(_sim_option_bs, n, parallel, seed,
                                     spot, strike, rate, vol, T, opt)
            tot_sum = sum(p["sum"] for p in partials)
            tot_sq = sum(p["sum_sq"] for p in partials)
            tot_n = sum(p["samples"] for p in partials)
            mean_payoff = tot_sum / tot_n
            disc_price = math.exp(-rate * T) * mean_payoff
            var = max(0, tot_sq / tot_n - mean_payoff * mean_payoff)
            stderr = math.exp(-rate * T) * math.sqrt(var / tot_n)
            output = {
                "simulation": "option_bs",
                "spot": spot, "strike": strike, "rate": rate,
                "volatility": vol, "maturity": T, "option_type": opt,
                "samples": tot_n,
                "result": disc_price,
                "stderr": stderr,
                "confidence_95": [disc_price - 1.96 * stderr, disc_price + 1.96 * stderr],
            }

        elif sim == "random_walk":
            steps = int(params.get("steps", 1000))
            start = float(params.get("start", 0))
            partials = _parallel_run(_sim_random_walk, n, parallel, seed, steps, start)
            tot_n = sum(p["samples"] for p in partials)
            tot_sum = sum(p["finals_sum"] for p in partials)
            tot_sq = sum(p["finals_sq"] for p in partials)
            mean = tot_sum / tot_n
            var = max(0, tot_sq / tot_n - mean * mean)
            output = {
                "simulation": "random_walk", "steps": steps, "start": start,
                "samples": tot_n,
                "result": mean,
                "stdev": math.sqrt(var),
                "min": min(p["min"] for p in partials),
                "max": max(p["max"] for p in partials),
            }

        elif sim == "dice":
            sides = max(2, int(params.get("sides", 6)))
            throws = max(1, int(params.get("throws", 1)))
            partials = _parallel_run(_sim_dice, n, parallel, seed, sides, throws)
            tot_n = sum(p["samples"] for p in partials)
            tot_sum = sum(p["sum"] for p in partials)
            tot_sq = sum(p["sum_sq"] for p in partials)
            mean = tot_sum / tot_n
            var = max(0, tot_sq / tot_n - mean * mean)
            theoretical_mean = throws * (sides + 1) / 2
            output = {
                "simulation": "dice", "sides": sides, "throws": throws,
                "samples": tot_n,
                "result": mean,
                "stdev": math.sqrt(var),
                "theoretical_mean": theoretical_mean,
                "error": abs(mean - theoretical_mean),
            }
        else:
            raise ValueError(f"未知 simulation: {sim} (支持 pi/integral/option_bs/random_walk/dice)")

        output["elapsed_ms"] = int((time.time() - t0) * 1000)
        output["parallel"] = parallel
        output["status"] = "ok"
        output["schema_version"] = "v1"
        output["task_type"] = "monte_carlo"
        output["contract_version"] = "1"
        output["summary"] = {
            "value": output["result"],
            "samples": output["samples"],
            "simulation": output["simulation"],
        }
        output["summary_text"] = (
            f"✅ MC {sim} · samples={output['samples']:,} · "
            f"result={output['result']:.6g}"
            + (f" (理论 {output.get('theoretical_mean'):.6g})" if 'theoretical_mean' in output else "")
            + f"\n⚡ {parallel} 进程并行 · {output['elapsed_ms']}ms"
        )
        print(json.dumps(output, ensure_ascii=False))
        return 0
    except Exception as e:
        print(json.dumps({
            "status": "failed", "task_type": "monte_carlo",
            "error": str(e), "summary_text": "❌ " + str(e),
        }, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    sys.exit(main())
