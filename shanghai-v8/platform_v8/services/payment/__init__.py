"""S3-T2 · 支付服务

模式:
  admin_manual  · 用户提交充值申请 → admin 后台确认到账后手工入账(零成本起步)
  wechat_pay    · API v3 Native 扫码，需显式启用与完整配置
  alipay        · RSA2 alipay.trade.page.pay 跳转收银台(电脑网站支付，已签约)；
                  alipay.trade.precreate 扫码保留给当面付签约后启用
  bank_transfer · 对公转账(同 admin_manual,带流水号字段)
  usdt          · USDT 链上(远期)

下单 → (跳转收银台 | 二维码) → 异步通知/主动查询 → ledger.deposit 入账。
同步回跳不可作为付款依据；只有验签通过的异步通知或 alipay.trade.query 能入账。
"""
