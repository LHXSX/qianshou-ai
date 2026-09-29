// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest'
import { createTokenStore, type AccountClient } from '@deepseek-ai/dsh-client-account'
import { createCnySubscriptionClient, type CnyQuote, type CnySubscriptionClient } from '../src/components/account-subscription-client.ts'
import { renderCnySubscriptionPage } from '../src/components/account-subscription-page.ts'
import type { CommerceReader } from '../src/components/account-commerce.ts'
const quote: CnyQuote = { quoteId:'quote-1',accountId:'7',tier:'basic',label:'基础订阅',months:1,currency:'CNY',amountFen:3900,amountYuan:'39.00',monthlySp:390,expiresAt:'2026-09-21T00:00:00Z' }
const wallet = { currency:'CNY',balanceFen:5000,balanceYuan:'50.00',shortfallFen:0,canPay:true }
const order = { orderId:'order-1',quoteId:quote.quoteId,accountId:'7',tier:'basic',months:1,currency:'CNY',amountFen:3900,amountYuan:'39.00',status:'fulfilled',paymentStatus:'paid',canRetry:false,subscription:{ tier:'basic',from:1000,to:2000 } }
const signal = () => new AbortController().signal
beforeEach(()=>{localStorage.clear();document.body.replaceChildren()})
async function harness(fetcher: typeof fetch, identity:()=>string|null=()=>'7') {
  const tokens=createTokenStore({ cookiesAvailable:false });await tokens.write({ access_token:'fixture-only-token',refresh_token:null,token_type:'bearer',expires_in:3600 })
  const account={ tokens,refresh:vi.fn(async()=>false) } as unknown as AccountClient
  return createCnySubscriptionClient({ client:account,accountId:identity,fetch:fetcher,origin:'https://app.example.test',timeoutMs:1000,storage:localStorage })
}
const path=(input:Parameters<typeof fetch>[0])=>new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url).pathname
it('pays exactly the server quote in CNY and never sends an amount or legacy SP request',async()=>{
  const calls:{ path:string;body:unknown }[]=[]
  const client=await harness(async(input,init)=>{calls.push({ path:path(input),body:typeof init?.body==='string'?JSON.parse(init.body):null });return Response.json({ ok:true,order })})
  expect(await client.purchase(quote,signal())).toMatchObject({ currency:'CNY',amountFen:3900,status:'fulfilled' })
  expect(calls).toEqual([{ path:'/account-api/api/v8/subscriptions/purchase',body:{ quoteId:'quote-1',idempotencyKey:(calls[0]?.body as { idempotencyKey: string }).idempotencyKey } }])
  expect((calls[0]?.body as { idempotencyKey: string }).idempotencyKey).toMatch(/^[a-zA-Z0-9-]{16,80}$/u)
  expect(client.pending()).toBeNull();expect(localStorage.length).toBe(0)
})
it.each([
  ['quote_expired','quote-expired'], ['insufficient_balance','insufficient-balance'], ['invalid_quote','invalid-quote'], ['quote_not_found','invalid-quote'],
] as const)('normalizes Shanghai underscore error %s',async(raw,expected)=>{
  const client=await harness(async()=>Response.json({ ok:false,detail:{ code:raw,message:'fixture' } },{ status:409 }))
  await expect(client.purchase(quote,signal())).rejects.toMatchObject({ code:expected })
  expect(client.pending()).toBeNull()
})
it.each([
  ['downgrade-not-allowed','当前订阅有效期内暂不支持降级，请选择当前或更高档位。'],
  ['already-subscribed','当前账号已拥有该订阅，无需重复购买。'],
  ['wallet_reconciliation_required','人民币余额需要核对，暂时无法支付。请联系客服。'],
  ['wallet_currency_conflict','账户余额的币种需要核对，暂时无法支付。请联系客服。'],
  ['gateway_unavailable','订阅服务暂时无法连接，请稍后重新查看。'],
  ['checkout_unavailable','订阅服务暂时无法连接，请稍后重新查看。'],
  ['quote_not_found','这次报价已失效，请重新查看并确认价格。'],
  ['future_backend_code','暂时无法确认套餐报价，请稍后重新查看。'],
] as const)('explains quote failure %s without inventing an order or echoing backend text',async(code,message)=>{
  const fetcher=vi.fn<typeof fetch>(async()=>Response.json({ detail:{ code,message:'private gateway diagnostics' } },{ status:409 }))
  const client=await harness(fetcher)
  await expect(client.quote('basic',signal())).rejects.toMatchObject({ message })
  expect(client.pending()).toBeNull();expect(localStorage.length).toBe(0)
  expect(fetcher).toHaveBeenCalledTimes(1);expect(path(fetcher.mock.calls[0]![0])).toBe('/account-api/api/v8/subscriptions/quote')
  expect(message).not.toContain('原订单')
})
it.each(['wallet_reconciliation_required','wallet_currency_conflict'] as const)('releases pending only for the definite unpaid purchase rejection %s',async(code)=>{
  const fetcher=vi.fn<typeof fetch>(async()=>Response.json({ detail:{ code } },{ status:503 }))
  const client=await harness(fetcher)
  const work=client.purchase(quote,signal())
  await expect(work).rejects.toMatchObject({ code });await expect(work).rejects.toThrow('核对')
  expect(client.pending()).toBeNull();expect(localStorage.length).toBe(0);expect(fetcher).toHaveBeenCalledTimes(1)
})
it.each(['gateway_unavailable','checkout_unavailable','gateway_outcome_unknown','idempotency_conflict','quote_already_paid'] as const)('retains same-key recovery for uncertain or existing purchase %s without retrying payment',async(code)=>{
  const calls:string[]=[]
  const client=await harness(async (input)=>{
    calls.push(path(input))
    return calls.length===1?Response.json({ detail:{ code } },{ status:503 }):Response.json({ ok:true,order })
  })
  const work=client.purchase(quote,signal())
  await expect(work).rejects.toMatchObject({ code });await expect(work).rejects.toThrow('勿再次付款')
  const key=client.pending()?.key;expect(key).toBeTruthy();expect(calls).toHaveLength(1)
  expect((await client.recover(signal()))?.status).toBe('fulfilled')
  expect(calls).toEqual(['/account-api/api/v8/subscriptions/purchase',`/account-api/api/v8/subscriptions/orders/by-key/${key}`])
})
it('does not call a missing wallet service an order failure or trust its raw error text',async()=>{
  const client=await harness(async()=>Response.json({ detail:{ code:'gateway_unavailable',message:'private' } },{ status:503 }))
  await expect(client.wallet(signal())).rejects.toMatchObject({ code:'gateway_unavailable',message:'暂时无法读取人民币余额，请稍后重新查看。' })
  expect(client.pending()).toBeNull()
})
it('does not interpret an unstructured HTTP 404 as proof that an uncertain order was never created',async()=>{
  let calls=0
  const client=await harness(async()=>{if(++calls===1)throw Error('lost');return Response.json({ detail:'Not Found' },{ status:404 })})
  await expect(client.purchase(quote,signal())).rejects.toThrow('lost')
  const key=client.pending()?.key
  const recovery=client.recover(signal())
  await expect(recovery).rejects.toMatchObject({ code:'unavailable' });await expect(recovery).rejects.toThrow('原订单')
  expect(client.pending()?.key).toBe(key);expect(calls).toBe(2)
})
it('restores the same pending operation after a lost response and reload, without another debit',async()=>{
  const calls:{ path:string;body:unknown }[]=[]
  const fetcher:typeof fetch=async(input,init)=>{calls.push({ path:path(input),body:typeof init?.body==='string'?JSON.parse(init.body):null });if(calls.length===1)throw Error('response lost');return Response.json({ ok:true,order })}
  const first=await harness(fetcher);await expect(first.purchase(quote,signal())).rejects.toThrow('response lost')
  const saved=first.pending();expect(saved?.key).toBeTruthy();expect(JSON.stringify(Object.values(localStorage))).not.toContain('fixture-only-token')
  const next=await harness(fetcher);expect(next.pending()?.key).toBe(saved?.key)
  expect((await next.recover(signal()))?.status).toBe('fulfilled')
  expect(calls[1]?.path).toContain('/orders/by-key/');expect(calls.filter(c=>c.path.endsWith('/purchase'))).toHaveLength(1)
})
it('locks the pending quote and reuses its idempotency key on an explicit same-order retry',async()=>{
  const keys:string[]=[]
  const client=await harness(async(_input,init)=>{keys.push((JSON.parse(typeof init?.body==='string'?init.body:'{}') as { idempotencyKey:string }).idempotencyKey);throw Error('network')})
  await expect(client.purchase(quote,signal())).rejects.toThrow()
  await expect(client.purchase({ ...quote,quoteId:'another' },signal())).rejects.toMatchObject({ code:'pending-order' })
  await expect(client.purchase(quote,signal())).rejects.toThrow()
  expect(keys).toHaveLength(2);expect(keys[0]).toBe(keys[1])
})
it('does not claim a 202 paid order is a fulfilled subscription',async()=>{
  const client=await harness(async()=>Response.json({ ok:true,order:{ ...order,status:'fulfilling',canRetry:true,subscription:undefined } },{ status:202 }))
  expect(await client.purchase(quote,signal())).toMatchObject({ status:'fulfilling',paymentStatus:'paid' })
  expect(client.pending()).not.toBeNull()
})
it.each(['currency','amount','owner','receipt'] as const)('fails closed for mismatched %s receipts and keeps recovery',async(kind)=>{
  const wrong={ ...order,...kind==='currency'?{ currency:'SP' }:kind==='amount'?{ amountFen:390000,amountYuan:'3900.00' }:kind==='owner'?{ accountId:'8' }:{ subscription:undefined } }
  const client=await harness(async()=>Response.json({ ok:true,order:wrong }))
  await expect(client.purchase(quote,signal())).rejects.toMatchObject({ code:'invalid-response' })
  expect(client.pending()).not.toBeNull()
})
it('rejects a late response after account switching',async()=>{
  let id='7';let done!:()=>void;const delay=new Promise<void>((resolve)=>{done=resolve})
  const client=await harness(async()=>{await delay;return Response.json({ ok:true,quote,wallet })},()=>id)
  const work=client.quote('basic',signal());id='8';done();await expect(work).rejects.toMatchObject({ code:'account-changed' })
})
it('does not make a money request when recovery storage cannot be written',async()=>{
  const fetcher=vi.fn<typeof fetch>(async()=>Response.json({ ok:true,order }));const tokens=createTokenStore({ cookiesAvailable:false })
  const client=createCnySubscriptionClient({ client:{ tokens } as AccountClient,accountId:()=>'7',fetch:fetcher,origin:'https://app.example.test',timeoutMs:1000,storage:{ getItem:()=>null,setItem:()=>{throw Error('storage refused')},removeItem:()=>{} } })
  await expect(client.purchase(quote,signal())).rejects.toThrow('storage refused');expect(fetcher).not.toHaveBeenCalled()
})
it('uses a fresh Shanghai wallet, and a quote whose amount and shortfall agree',async()=>{
  const client=await harness(async input=>Response.json(path(input).endsWith('/wallet')?{ ok:true,wallet }:{ ok:true,quote,wallet }))
  expect(await client.wallet(signal())).toEqual({ currency:'CNY',balanceFen:5000,balanceYuan:'50.00' })
  expect((await client.quote('basic',signal())).wallet.canPay).toBe(true)
  const bad=await harness(async()=>Response.json({ ok:true,quote,wallet:{ ...wallet,shortfallFen:4 } }))
  await expect(bad.quote('basic',signal())).rejects.toMatchObject({ code:'invalid-response' })
})
async function page(canPay=true) {
  const purchase=vi.fn(async()=>({ ...order,status:'fulfilled' as const,paymentStatus:'paid' as const,currency:'CNY' as const }))
  const subscription:CnySubscriptionClient={ wallet:vi.fn(async()=>wallet as { currency:'CNY';balanceFen:number;balanceYuan:string }),quote:vi.fn(async()=>({ quote,wallet:{ ...wallet,currency:'CNY' as const,...!canPay?{ balanceFen:100,balanceYuan:'1.00',shortfallFen:3800,canPay:false }:{} } })),purchase,pending:()=>null,recover:async()=>null,retry:vi.fn() }
  const legacy=vi.fn();const reader:CommerceReader={ status:async()=>({ tierId:'free',tierLabel:'免费版',remainingSp:10,purchasableSp:999999,plans:[{ id:'basic',label:'基础订阅',monthlyYuan:39,monthlySp:390 }] }),subscription,subscribe:legacy }
  const container=document.createElement('div');document.body.append(container);const navigate=vi.fn();const purchaseIntent={ tier:null as string|null }
  renderCnySubscriptionPage({ container,reader,signal:signal(),current:()=>true,navigate,purchaseIntent })
  await vi.waitFor(()=>{ expect(container.textContent).toContain('查看并选择') })
  ;[...container.querySelectorAll('button')].find(b=>b.textContent==='查看并选择')?.click()
  await vi.waitFor(()=>{ expect(container.querySelector('[data-testid="account-cny-confirm"]')).not.toBeNull() })
  return { container,subscription,purchase,legacy,navigate,purchaseIntent }
}
it('requires a second explicit CNY confirmation and never invokes the SP purchase handler',async()=>{
  const f=await page();expect(f.purchase).not.toHaveBeenCalled();expect(f.container.textContent).toContain('账户余额 ¥50.00');expect(f.container.textContent).toContain('同档续费延长有效期，不会重置本月已用额度或近 5 小时用量。')
  ;[...f.container.querySelectorAll('button')].find(b=>b.textContent==='确认支付 ¥39.00')?.click()
  await vi.waitFor(()=>{ expect(f.container.textContent).toContain('订阅已开通') });expect(f.legacy).not.toHaveBeenCalled();expect(f.purchase).toHaveBeenCalledTimes(1)
})
it('retains the selected plan when RMB is insufficient, regardless of legacy SP balance',async()=>{
  const f=await page(false);expect(f.container.textContent).toContain('还差 ¥38.00')
  ;[...f.container.querySelectorAll('button')].find(b=>b.textContent==='充值后继续购买')?.click()
  expect(f.navigate).toHaveBeenCalledWith('recharge');expect(f.purchaseIntent.tier).toBe('basic');expect(f.purchase).not.toHaveBeenCalled();expect(f.legacy).not.toHaveBeenCalled()
})
