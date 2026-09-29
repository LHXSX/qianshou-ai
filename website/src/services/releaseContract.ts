export interface EcoDownload {platform:string;url:string;size_bytes:number;sha256:string;available:boolean}
export interface EcoRelease {version:string;release_date:string;release_notes_zh:string;downloads:EcoDownload[]}
export function parseEcoRelease(raw:unknown):EcoRelease{
 const list=(raw as any)?.products;if(!Array.isArray(list))throw new Error('Invalid release list')
 const item=list.find((p:any)=>p?.id==='qianshou-eco-v3-preview');if(!item||typeof item.version!=='string'||!/^3\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(item.version)||!Array.isArray(item.downloads))throw new Error('Invalid V3 release')
 const seen=new Set();const downloads=item.downloads.filter((d:any)=>d.available===true).map((d:any)=>{
  if(!['windows-x64','macos-arm64'].includes(d.platform)||seen.has(d.platform)||typeof d.url!=='string'||!/^\/eco-v3\/downloads\/qianshou-ecosystem-v3-[A-Za-z0-9.-]+\.(?:exe|dmg)$/.test(d.url)||!Number.isSafeInteger(d.size_bytes)||d.size_bytes<1||d.size_bytes>2*1024**3||typeof d.sha256!=='string'||!/^[a-f0-9]{64}$/.test(d.sha256))throw new Error('Invalid download')
  if(d.platform==='windows-x64'&&!d.url.endsWith('.exe')||d.platform==='macos-arm64'&&!d.url.endsWith('.dmg'))throw new Error('Platform mismatch')
  seen.add(d.platform);return{platform:d.platform,url:d.url,size_bytes:d.size_bytes,sha256:d.sha256,available:true}
 });return{version:item.version,release_date:typeof item.release_date==='string'?item.release_date:'',release_notes_zh:typeof item.release_notes_zh==='string'?item.release_notes_zh:'',downloads}
}
