import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

function deferred() { let resolve, reject; const promise = new Promise((a,b) => {resolve=a;reject=b}); return {promise,resolve,reject} }
function view(name, bindings, expose) {
  const source=readFileSync(new URL(`../src/views/${name}.vue`,import.meta.url),'utf8').split('<script setup lang="ts">')[1].split('</script>')[0].replace(/^import .*$/gm,'')
  const context={auth:{getUser:()=>({id:'test-account'})},localStorage:{getItem(){return null},setItem(){},removeItem(){}},errorMessage:(e,fallback)=>e?.response?.status >= 500 ? '服务暂时不可用，请稍后再试。' : fallback,ref:v=>({value:v}), computed:f=>({get value(){return f()}}), onMounted(){}, onBeforeUnmount(){}, ElMessage:{error(){},warning(){},success(){}}, ...bindings}
  vm.createContext(context)
  vm.runInContext(ts.transpile(source+`\nglobalThis.exposed = {${expose}}`,{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}),context)
  return context.exposed
}
const first=deferred(),second=deferred();let calls=0
const tasks=view('Tasks',{myApi:{getMyTasks:()=>++calls===1?first.promise:second.promise}},'loadData,tasks,stats,total,statusFilter,loading,loadError')
const a=tasks.loadData();tasks.statusFilter.value='failed';const b=tasks.loadData()
second.resolve({ok:true,tasks:[{id:'new'}],stats:{},total:1});await b
first.resolve({ok:true,tasks:[{id:'old'}],stats:{},total:9});await a
assert.equal(tasks.tasks.value[0].id,'new');assert.equal(tasks.total.value,1);assert.equal(tasks.loading.value,false)
const broken=view('Tasks',{myApi:{getMyTasks:async()=>{throw Error('offline')}}},'loadData,tasks,stats,total,loadError')
await broken.loadData();assert.match(broken.loadError.value,/无法读取/);assert.equal(broken.total.value,0);assert.equal(broken.stats.value,null)
let txCalls=0;const txFirst=deferred(),txSecond=deferred()
const warnings=[],errors=[]
const wallet=view('Wallet',{ElMessage:{error(message){errors.push(message)},warning(message){warnings.push(message)},success(){}},myApi:{getMyTransactions:()=>++txCalls===1?txFirst.promise:txSecond.promise}},'loadTxs,txs,txType,txTotal,txLoading,txError,submitWithdraw,withdrawAmount,wallet,payeeAccount,payeeHolder,submittingWithdraw')
const ta=wallet.loadTxs();wallet.txType.value='expense';const tb=wallet.loadTxs()
txSecond.reject(Error('offline'));await tb;txFirst.resolve({ok:true,items:[{id:'stale'}],total:1});await ta
assert.equal(wallet.txs.value.length,0);assert.equal(wallet.txTotal.value,0);assert.match(wallet.txError.value,/无法读取/)
const previousErrors=errors.length
wallet.wallet.value={wallet:{balance:200000}};wallet.withdrawAmount.value='100001';await wallet.submitWithdraw();assert.equal(wallet.submittingWithdraw.value,false)
assert.match(warnings.at(-1),/100000/)
wallet.withdrawAmount.value='100.001';await wallet.submitWithdraw();assert.equal(wallet.submittingWithdraw.value,false)
assert.match(warnings.at(-1),/两位小数/)
assert.equal(errors.length,previousErrors)
console.log('PASS: latest task selection wins; task failure stays error; latest transaction failure cannot reveal stale rows; invalid withdrawals rejected before network.')

const identityContext = {}
vm.createContext(identityContext)
const identitySource = readFileSync(new URL('../src/services/identityContract.ts', import.meta.url), 'utf8').replace(/^import .*$/gm, '').replace(/^export /gm, '')
vm.runInContext(ts.transpile(identitySource + '\nglobalThis.translate = errorMessage', {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None}), identityContext)
const sharedSource = readFileSync(new URL('../src/shared/session-coordinator.ts', import.meta.url), 'utf8')
const codes = [...sharedSource.split('export type SessionCode =')[1].split(';')[0].matchAll(/'([^']+)'/g)].map(match => match[1])
for (const code of codes) {
  const message = identityContext.translate({code, message: code}, 'fallback')
  assert.notEqual(message, code)
  assert.notEqual(message, 'fallback')
  assert.match(message, /[\u4e00-\u9fff]/)
}
assert.match(identityContext.translate({response:{status:503},message:'Request failed with status code 503'}, 'fallback'), /服务暂时不可用/)
console.log('PASS: every shared SessionCode has a user-facing Chinese message; HTTP 503 stays readable.')

for (const outcome of ['network', '503', 'missing', '422']) {
  const stored = new Map(); let posts = 0, reads = 0
  const httpClient = {
    async post() { posts++; if (outcome === 'network') throw Error('offline'); if (outcome !== 'missing') throw {response:{status:Number(outcome)}}; return {data:{}} },
    async get() { reads++; return {data:{ok:true,items:[],total:0}} },
  }
  const localStorage = {getItem:key=>stored.get(key)||null,setItem:(key,value)=>stored.set(key,value),removeItem:key=>stored.delete(key)}
  const w = view('Wallet', {httpClient,localStorage}, 'submitWithdraw,withdrawAmount,wallet,payeeAccount,payeeHolder,withdrawUncertain,openWithdraw')
  w.wallet.value={wallet:{balance:1000}};w.withdrawAmount.value='100';w.payeeAccount.value='account';w.payeeHolder.value='holder'
  await w.submitWithdraw()
  assert.equal(posts,1)
  assert.equal(w.withdrawAmount.value,'100');assert.equal(w.payeeAccount.value,'account')
  if(outcome==='422') { assert.equal(w.withdrawUncertain.value,false);await w.submitWithdraw();assert.equal(posts,2) }
  else {
    assert.equal(w.withdrawUncertain.value,true);assert.equal(reads,1)
    await w.submitWithdraw();w.openWithdraw();await w.submitWithdraw();assert.equal(posts,1)
    const reopened = view('Wallet',{httpClient,localStorage},'withdrawUncertain,submitWithdraw')
    assert.equal(reopened.withdrawUncertain.value,true);await reopened.submitWithdraw();assert.equal(posts,1)
  }
}
console.log('PASS: network/503/missing acknowledgement lock repeat POST, retain input, fetch history and survive remount; explicit 422 rejection permits correction.')
