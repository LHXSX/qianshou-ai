/** CPU-only fixture implements the durable approved-runtime ABI; it makes no GPU claims. */
import { createServer } from 'node:http'
import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
const [host, port, tokenPath, instance, dropSubmit] = process.argv.slice(2)
const config = {bundle_id:process.env.QIANSHOU_MEDIA_BUNDLE_ID,executor_sha256:process.env.QIANSHOU_MEDIA_EXECUTOR_SHA256,profiles:JSON.parse(process.env.QIANSHOU_MEDIA_PROFILES)}
const bearer = 'Bearer ' + readFileSync(tokenPath, 'utf8')
const db = new DatabaseSync(join(process.cwd(), 'fixture-jobs.sqlite'))
db.exec('CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,payload TEXT NOT NULL,result TEXT NOT NULL);CREATE TABLE IF NOT EXISTS calls(method TEXT NOT NULL,id TEXT NOT NULL)')
const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a9sAAAAASUVORK5CYII=', 'base64')
const server = createServer(async (req,res) => {
  if(req.headers.authorization !== bearer){res.writeHead(403).end();return}
  const send = value => {res.setHeader('Content-Type','application/json');res.end(JSON.stringify(value))}
  if(req.url === '/health'){send({schema:'qianshou.media-runtime.v1',instance_id:instance,...config});return}
  if(req.url === '/shutdown'){send({ok:true});server.close(()=>{db.close();process.exit(0)});return}
  if(req.method === 'POST' && req.url === '/v1/media/jobs'){
    let body='';for await(const chunk of req)body+=chunk.toString()
    const p=JSON.parse(body)
    db.prepare('INSERT INTO calls VALUES(?,?)').run('POST',p.attemptId)
    if(db.prepare('SELECT id FROM jobs WHERE id=?').get(p.attemptId)){res.writeHead(409).end();return}
    writeFileSync(p.outputPath,bytes,{mode:0o600})
    const result={schema:'qianshou.media-runtime-job.v1',taskId:p.taskId,attemptId:p.attemptId,leaseEpoch:p.leaseEpoch,assetId:p.assetId,
      status:'succeeded',result:{path:p.outputPath,sha256:createHash('sha256').update(bytes).digest('hex'),size_bytes:bytes.length,content_type:'image/png'}}
    db.prepare('INSERT INTO jobs VALUES(?,?,?)').run(p.attemptId,body,JSON.stringify(result))
    if(dropSubmit==='drop-submit'){req.socket.destroy();return}
    send(result);return
  }
  if(req.method === 'GET' && req.url.startsWith('/v1/media/jobs/')){
    const id=req.url.split('/').pop();db.prepare('INSERT INTO calls VALUES(?,?)').run('GET',id)
    const job=db.prepare('SELECT result FROM jobs WHERE id=?').get(id)
    if(!job){res.writeHead(404).end();return}send(JSON.parse(job.result));return
  }
  res.writeHead(404).end()
})
server.listen(Number(port),host)
process.on('SIGTERM',()=>server.close(()=>{db.close();process.exit(0)}))
