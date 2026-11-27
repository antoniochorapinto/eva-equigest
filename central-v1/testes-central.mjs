import assert from 'node:assert/strict';
import worker from './EVA_Worker_Central.mjs';
import {webcrypto} from 'node:crypto';
if(!globalThis.crypto)globalThis.crypto=webcrypto;
let count=0,calls=[],user='owner-a',auth=true,changing=false,failed=false,pelletPrepared={};
const env={EVA_SIGNING_SECRET:'fixture-signing-key',EVA_ALEXA_SECRET:'x'.repeat(40),P57_ALEXA_TASKS_ENABLED:'true',P57_ALEXA_PELLETS_ENABLED:'true',P57_ALLOWED_DEVICE_HASHES:'a'.repeat(64),P57_SUPABASE_PUBLISHABLE_KEY:'sb_publishable_fixture'};
const id='aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',version='b'.repeat(32);
const rows=Array.from({length:12},(_,i)=>({id:'t'+(i+1),title:'Montar',horse:'Cavalo '+(i+1),time:'15:20',day:'2026-11-27',kind:i===0?'booking':'task',bookingStatus:i===0?'pending':undefined,revision:'a'.repeat(32)}));
globalThis.fetch=async(url,init={})=>{
 if(String(url).endsWith('/auth/v1/user'))return auth?Response.json({id:user}):Response.json({}, {status:401});
 const b=init.body?JSON.parse(init.body):{};calls.push({url:String(url),body:b,headers:init.headers});
 if(failed)throw Error('network');
 if(String(url).endsWith('/eva_patio57_read'))return Response.json([{name:'Lírio',stableName:'Lírio',box:'7',patio:'Pátio 57'},{name:'Nouvelle',stableName:'Nounou',box:'2',patio:'Pátio Dr. Pedro'},{name:'Quirona',stableName:'Quirona',box:'13',patio:'Pátio 57'}]);
 if(String(url).endsWith('/eva_patio57_tasks')){
  if(b.p_action==='list')return Response.json({tasks:rows.slice(b.p_offset,b.p_offset+5),offset:b.p_offset,total:rows.length,snapshotVersion:changing?'c'.repeat(32):version});
  if(b.p_action==='prepare'||b.p_action==='prepare_confirm')return Response.json({task:rows[0],confirmation:id,expiresAt:new Date(Date.now()+180000).toISOString()});
  if(b.p_action==='complete')return Response.json({...rows[0],status:'completed',employee:b.p_employee});
  if(b.p_action==='confirm')return Response.json({...rows[0],status:'confirmed'});
 }
 if(String(url).endsWith('/eva_patio57_pellets')){
  if(b.p_action==='prepare'&&b.p_box==='1'&&!b.p_patio)return Response.json({code:'PELLETS_AMBIGUOUS'});
  if(b.p_action==='prepare'){pelletPrepared={horse:b.p_box==='13'?'Quirona':b.p_box==='2'?'Nounou':'Lírio',box:b.p_box,patio:b.p_patio,bags:b.p_bags};return Response.json({...pelletPrepared,confirmation:id,expiresAt:new Date(Date.now()+180000).toISOString()});}
  return Response.json({...pelletPrepared,status:'recorded',kg:pelletPrepared.bags*15});
 }
 throw Error('unexpected fetch '+url);
};
let stateToken='';
async function ask(text,{state=stateToken,alexa=false,headers={},body={},token='a.b.c'}={}){
 const r=await worker.fetch(new Request('https://fixture'+(alexa?'/alexa/conversation':'/eva/chat'),{method:'POST',headers:{Origin:'https://antoniochorapinto.github.io',Authorization:'Bearer '+(alexa?env.EVA_ALEXA_SECRET:token),'Content-Type':'application/json',...headers},body:JSON.stringify({text,stateToken:state,...(alexa?{patioAccessToken:token,deviceHash:'a'.repeat(64)}:{}),...body})}),env);
 const d=await r.json();if(d.stateToken)stateToken=d.stateToken;return {r,d};
}
async function test(name,f){stateToken='';calls=[];user='owner-test-'+count;await f();count++;console.log('OK '+name);}
const noWrites=()=>assert(!calls.some(c=>['complete','confirm'].includes(c.body.p_action)));
await test('PC localiza Lírio sem segredo Alexa, sem código de acesso e sem Gemini',async()=>{const {r,d}=await ask('Localiza Lírio');assert.equal(r.status,200);assert.match(d.answer,/Lírio/);assert.equal(d.source,'eva-central');assert(calls[0].headers.Authorization==='Bearer a.b.c');});
await test('origem diferente recusada',async()=>{const {r}=await ask('localiza Lírio',{headers:{Origin:'https://evil.example'}});assert.equal(r.status,403);assert.equal(calls.length,0);});
await test('JWT ausente recusado',async()=>{const {r}=await ask('localiza Lírio',{token:''});assert.equal(r.status,401);});
await test('sessão inválida recusada antes de consultar dados',async()=>{auth=false;const {r}=await ask('localiza Lírio');auth=true;assert.equal(r.status,401);assert.equal(calls.length,0);});
await test('Alexa continua a exigir segredo e aparelho autorizado',async()=>{let x=await ask('localiza Lírio',{alexa:true,body:{deviceHash:'b'.repeat(64)}});assert.equal(x.r.status,403);x=await ask('localiza Lírio',{alexa:true,headers:{Authorization:'Bearer bad'}});assert.equal(x.r.status,401);});
await test('PC e Alexa devolvem a mesma consulta através do núcleo',async()=>{const a=await ask('localiza Lírio'),b=await ask('localiza Lírio',{alexa:true,state:''});assert.equal(a.d.answer,b.d.answer);});
await test('12 tarefas são paginadas sem omissões',async()=>{let x=await ask('Lê todas as tarefas pendentes');assert.equal(x.d.tasks[0].id,'t1');x=await ask('mais tarefas');assert.equal(x.d.tasks[0].id,'t6');x=await ask('continua');assert.equal(x.d.tasks.at(-1).id,'t12');noWrites();});
await test('mudança da lista reinicia paginação',async()=>{await ask('tarefas pendentes');changing=true;const x=await ask('mais tarefas');changing=false;assert.match(x.d.answer,/lista mudou/);assert.equal(x.d.tasks[0].id,'t1');});
await test('concluir exige lista, confirmação e funcionário',async()=>{await ask('tarefas pendentes');let x=await ask('conclui a tarefa dois');assert.match(x.d.answer,/Confirma/);noWrites();x=await ask('sim');assert.match(x.d.answer,/Quem realizou/);noWrites();x=await ask('Antônio');assert.match(x.d.answer,/Tarefa concluída/);assert.equal(calls.at(-1).body.p_employee,'António');});
await test('sem lista não se pode concluir por número',async()=>{const x=await ask('conclui a tarefa dois');assert.match(x.d.answer,/Peça primeiro/);assert.equal(calls.length,0);});
await test('funcionário não permitido não conclui',async()=>{await ask('tarefas pendentes');await ask('conclui a tarefa dois');await ask('sim');const x=await ask('Manuel');assert.match(x.d.answer,/António/);noWrites();});
await test('confirmar marcação não equivale a concluir',async()=>{await ask('tarefas pendentes');let x=await ask('confirma a marcação um');assert.match(x.d.answer,/Continuará pendente/);noWrites();x=await ask('sim');assert.match(x.d.answer,/Continua na lista/);assert.equal(calls.at(-1).body.p_action,'confirm');assert(!calls.some(c=>c.body.p_action==='complete'));});
await test('nova consulta abandona tarefa por confirmar',async()=>{await ask('tarefas pendentes');await ask('conclui a tarefa dois');await ask('localiza Lírio');const x=await ask('sim');assert.match(x.d.answer,/Não há nenhum pedido/);noWrites();});
await test('pellets pede quantidade e zero cancela sem baixa',async()=>{let x=await ask('pellets na boxe sete');assert.match(x.d.answer,/Quantos sacos/);x=await ask('zero');assert.match(x.d.answer,/cancelado/);assert.equal(calls.length,0);});
await test('zero no pedido inicial não chama RPC de stock',async()=>{const x=await ask('regista zero sacos de pellets na boxe sete');assert.match(x.d.answer,/cancelado/);assert.equal(calls.length,0);});
await test('0 numérico também cancela',async()=>{await ask('pellets na boxe sete');const x=await ask('0');assert.match(x.d.answer,/cancelado/);assert.equal(calls.length,0);});
await test('pellets prepara, confirma e só depois grava',async()=>{let x=await ask('regista dois sacos de pellets na boxe sete do Pátio 57');assert.match(x.d.answer,/Confirma 2 sacos/);noWrites();x=await ask('sim');assert.match(x.d.answer,/Registei 2 sacos de cama/);assert(!/quilos|kg|quinze|15/.test(x.d.answer));assert.equal(calls.at(-1).body.p_confirmation,id);});
await test('pellets por stable name consulta os cavalos atuais',async()=>{const x=await ask('regista dois sacos de pellets para Nounou');assert.match(x.d.answer,/Confirma 2 sacos/);const p=calls.at(-1).body;assert.equal(p.p_box,'2');assert.equal(p.p_patio,'Pátio Dr. Pedro');});
await test('boxe em falta é recolhida sem ser confundida com consulta de cavalos',async()=>{await ask('regista dois sacos de pellets');const x=await ask('boxe sete do Pátio 57');assert.match(x.d.answer,/Confirma 2 sacos/);noWrites();});
await test('boxe ambígua pede pátio e preserva quantidade',async()=>{let x=await ask('regista dois sacos de pellets na boxe um');assert.match(x.d.answer,/Indique também o pátio/);x=await ask('no Pátio Dr. Pedro');assert.match(x.d.answer,/Confirma 2 sacos/);});
await test('não cancela confirmação sem gravar',async()=>{await ask('regista dois sacos de pellets na boxe sete');await ask('não');await ask('sim');noWrites();});
await test('contexto alterado pelo cliente é recusado',async()=>{await ask('tarefas pendentes');const pieces=stateToken.split('.');pieces[0]='x'+pieces[0].slice(1);const x=await ask('conclui a tarefa um',{state:pieces.join('.')});assert.equal(x.r.status,409);noWrites();});
await test('contexto de outra conta é recusado',async()=>{await ask('tarefas pendentes');user='owner-b';const x=await ask('conclui a tarefa um');user='owner-a';assert.equal(x.r.status,409);noWrites();});
await test('contexto da web não pode ser usado no aparelho Alexa',async()=>{await ask('tarefas pendentes');const x=await ask('conclui a tarefa um',{alexa:true});assert.equal(x.r.status,409);noWrites();});
await test('falha no servidor nunca anuncia sucesso; retry conserva confirmação',async()=>{await ask('regista dois sacos de pellets na boxe sete');failed=true;let x=await ask('sim');failed=false;assert(!/Registei/.test(x.d.answer));assert.equal(x.d.code,'PATIO_UNAVAILABLE');x=await ask('sim');assert.match(x.d.answer,/Registei/);assert.equal(calls.at(-1).body.p_confirmation,id);});
await test('recomeçar avisa sobre tentativa de gravação incerta',async()=>{await ask('regista dois sacos de pellets na boxe sete');failed=true;await ask('sim');failed=false;const x=await ask('recomeçar');assert.match(x.d.answer,/Verifique a aplicação/);});
await test('saúde sem ferramenta nunca é inventada',async()=>{const x=await ask('como está a saúde do Lírio');assert.match(x.d.answer,/ainda não está ligada/);assert.equal(calls.length,0);});
await test('zero também cancela depois da pergunta de confirmação',async()=>{await ask('regista dois sacos de pellets na boxe sete');const x=await ask('zero');assert.match(x.d.answer,/cancelado/);await ask('sim');noWrites();});
await test('zero após falha de gravação não promete anular movimento existente',async()=>{await ask('regista dois sacos de pellets na boxe sete');failed=true;await ask('sim');failed=false;const x=await ask('zero');assert.match(x.d.answer,/não anula uma baixa já gravada/);assert(!/Não registei/.test(x.d.answer));});

await test('frase ouvida toallet na boxe Lírio exige esclarecimento antes de preparar',async()=>{let x=await ask('toallet na boxe lirio');assert.match(x.d.answer,/Pretende registar pellets/);assert.equal(calls.length,0);x=await ask('sim');assert.match(x.d.answer,/Quantos sacos/);assert(!calls.some(c=>c.body.p_action==='prepare'));x=await ask('dois');assert.match(x.d.answer,/Confirma 2 sacos/);assert.equal(calls.at(-1).body.p_box,'7');noWrites();});
await test('não ao esclarecimento de toallet não altera stock',async()=>{await ask('toallet na boxe lirio');await ask('não');assert.equal(calls.length,0);});
await test('pellets na boxe Lírio resolve o nome atual sem gravar',async()=>{let x=await ask('pellets na boxe Lírio');assert.match(x.d.answer,/Quantos sacos/);x=await ask('dois');assert.match(x.d.answer,/Confirma 2 sacos/);assert.equal(calls.at(-1).body.p_box,'7');noWrites();});
await test('singular pellet não é confundido com consulta por boxe',async()=>{const x=await ask('regista um saco de pellet na boxe sete');assert.match(x.d.answer,/Confirma 1 saco/);noWrites();});
await test('sacos de cama com registo é alternativa portuguesa para pellets',async()=>{const x=await ask('regista dois sacos de cama na boxe sete do Pátio 57');assert.match(x.d.answer,/Confirma 2 sacos de cama/);noWrites();});
await test('botão inicia pellets sem assumir número de sacos ou boxe',async()=>{const x=await ask('Quero registar pellets');assert.match(x.d.answer,/Quantos sacos/);assert.equal(calls.length,0);});
await test('conversa central não recebe a instrução antiga sem ligação operacional',async()=>{const previousFetch=globalThis.fetch;let prompt='';globalThis.fetch=async(url,init)=>{if(String(url).includes('generativelanguage.googleapis.com')){prompt=JSON.parse(init.body).systemInstruction.parts[0].text;return Response.json({candidates:[{content:{parts:[{text:'Pode dizer regista dois sacos de pellets para Lírio.'}]}}]});}return previousFetch(url,init);};try{const x=await ask('Como faço uma baixa de material?');assert.equal(x.r.status,200);assert(prompt.includes('Esta sessão está autenticada no pátio'));assert(!prompt.includes('ainda não tem uma ligação operacional autenticada'));}finally{globalThis.fetch=previousFetch;}});


await test('fluxo pedido: regista sacos de cama na Quirona, pergunta só quantos, recebe número e confirma sem peso',async()=>{let x=await ask('Regista sacos de cama na Quirona');assert.equal(x.d.answer,'Quantos sacos?');assert(!calls.some(c=>c.body.p_action==='prepare'));x=await ask('2');assert.equal(x.d.answer,'Confirma 2 sacos de cama para Quirona?');noWrites();assert.equal(calls.at(-1).body.p_box,'13');x=await ask('sim');assert.equal(x.d.answer,'Registei 2 sacos de cama para Quirona.');assert.equal(calls.at(-1).body.p_action,'complete');});
await test('fluxo por nome aceita zero isolado sem preparar baixa',async()=>{await ask('Regista sacos de cama na Quirona');const x=await ask('zero');assert.match(x.d.answer,/cancelado/);assert(!calls.some(c=>c.body.p_action==='prepare'));noWrites();});
await test('fluxo por stable name mantém a consulta dinâmica sem nome fixo no modelo',async()=>{let x=await ask('Regista sacos de cama na Nounou');assert.equal(x.d.answer,'Quantos sacos?');x=await ask('um');assert.equal(x.d.answer,'Confirma 1 saco de cama para Nounou?');assert.equal(calls.at(-1).body.p_patio,'Pátio Dr. Pedro');noWrites();});

console.log(count+' testes do núcleo central aprovados; sem operações reais.');
