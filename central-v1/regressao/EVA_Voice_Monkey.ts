// EVA avisos: só novas marcações para montar. Sem nomes/contactos de clientes no anúncio.
const PROJECT='https://whypekodiqdgfbzoakry.supabase.co';
const DEVICE=Deno.env.get('P57_VOICE_MONKEY_DEVICE')||'patio-echo-2ewbx';
const json=(data,status=200)=>Response.json(data,{status});
async function sameSecret(a,b){
 const e=new TextEncoder();
 const [x,y]=await Promise.all([a,b].map(s=>crypto.subtle.digest('SHA-256',e.encode(s))));
 const p=new Uint8Array(x),q=new Uint8Array(y);let diff=0;for(let i=0;i<p.length;i++)diff|=p[i]^q[i];return diff===0;
}
const escapeSpeech=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
function announcement(row){
 if(typeof row.horse!=='string'||!row.horse.trim()||!/^\d{4}-\d{2}-\d{2}$/.test(row.date)||!/^([01]\d|2[0-3]):[0-5]\d$/.test(row.time))throw Error('invalid-booking');
 const [year,month,day]=row.date.split('-').map(Number),[hour,minute]=row.time.split(':').map(Number);
 const date=new Date(Date.UTC(year,month-1,day));
 if(date.getUTCFullYear()!==year||date.getUTCMonth()!==month-1||date.getUTCDate()!==day)throw Error('invalid-date');
 return 'Entrou uma nova marcação para montar '+escapeSpeech(row.horse.trim().slice(0,140).replace(/[{}]/g,''))+', no dia '+day+' de '+['janeiro','fevereiro','março','abril','maio','junho','julho','agosto','setembro','outubro','novembro','dezembro'][month-1]+', às '+hour+' horas'+(minute?' e '+minute+' minutos':'')+'. Está por confirmar. Para consultar, diga: Alexa, abre assistente eva, e peça as tarefas pendentes.';
}
function backendKey(){
 let key=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')||'';
 try{key=JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS')||'{}').default||key;}catch{}
 return key;
}
async function rpc(name,body,key){
 const headers={apikey:key,'Content-Type':'application/json'};
 if(!key.startsWith('sb_secret_'))headers.Authorization='Bearer '+key;
 const res=await fetch(PROJECT+'/rest/v1/rpc/'+name,{method:'POST',headers,body:JSON.stringify(body),signal:AbortSignal.timeout(5000),redirect:'error'});
 if(!res.ok)throw Error('database-'+res.status);return res.json();
}
async function handle(request){
 if(request.method!=='POST')return json({error:'method'},405);
 const expected=Deno.env.get('P57_PUSH_WEBHOOK_SECRET')||'',received=request.headers.get('x-p57-push-secret')||'';
 if(!expected||!received||received.length>1024||!await sameSecret(expected,received))return json({error:'unauthorized'},401);
 const token=Deno.env.get('P57_VOICE_MONKEY_TOKEN')||'';
 if(!token)return json({ignored:true,reason:'not_configured'});
 let payload;try{payload=await request.json();}catch{return json({error:'invalid_json'},400);}
 if(payload.action==='check'){
  try{
   const r=await fetch('https://api-v3.voicemonkey.io/me',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:'{}',signal:AbortSignal.timeout(8000),redirect:'error'});
   return json({configured:true,tokenAccepted:r.ok,httpStatus:r.status,device:DEVICE});
  }catch{return json({configured:true,tokenAccepted:false,error:'network'},503);}
 }
 if(payload.type!=='INSERT'||payload.schema!=='public'||payload.table!=='p57_riding_requests')return json({ignored:true});
 const id=payload.record?.id;
 if(typeof id!=='string'||! /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id))return json({error:'invalid_id'},400);
 const key=backendKey();if(!key)return json({error:'not_configured'},503);
 let row;
 try{row=await rpc('eva_patio57_voice_claim',{p_booking_id:id},key);}catch{return json({error:'claim_failed'},503);}
 if(!row.send)return json({ignored:true,reason:row.reason});
 let state='uncertain',httpStatus=0;
 try{
  const speech=announcement(row);
  const response=await fetch('https://api-v3.voicemonkey.io/announce',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},
   body:JSON.stringify({device:DEVICE,speech,language:'pt-BR'}),signal:AbortSignal.timeout(12000),redirect:'error'});
  httpStatus=response.status;
  let result;try{result=await response.json();}catch{}
  state=response.ok&&result?.success===true?'sent':'failed';
 }catch{state='uncertain';}
 try{await rpc('eva_patio57_voice_finish',{p_booking_id:id,p_state:state,p_http_status:httpStatus},key);}catch{
  console.error('EVA announcement status unavailable');
 }
 // Uma falha ambígua não volta a anunciar automaticamente: evita repetições.
 return json({handled:true,state});
}
export {handle,announcement};
if (import.meta.main) Deno.serve(handle);

