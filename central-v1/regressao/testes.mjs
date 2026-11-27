import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {fileURLToPath} from 'node:url';
process.chdir(fileURLToPath(new URL('.',import.meta.url)));
let handlers=[];
const Alexa={getRequestType:e=>e.request.type,getIntentName:e=>e.request.intent.name,getSlotValue:(e,k)=>e.request.intent.slots?.[k]?.value,SkillBuilders:{custom:()=>({addRequestHandlers(...h){handlers=h;return this},addErrorHandlers(){return this},lambda(){return ()=>{}}})}};
const ctx=vm.createContext({require:n=>n==='ask-sdk-core'?Alexa:n==='aws-sdk'?{DynamoDB:{DocumentClient:class{}}}:n==='crypto'?{}:{},exports:{},process:{env:{}},console,Buffer,Date,Set,Map,TextEncoder,Number,JSON});
vm.runInContext(fs.readFileSync('EVA_Alexa_Tarefas.cjs','utf8'),ctx);
let attrs={},calls=[],remote;
ctx.remote=async(...a)=>{calls.push(a[6]||a[5]);return structuredClone(await remote(a[6]||a[5]));};
vm.runInContext('requestEVA=(...a)=>remote(...a)',ctx);
function input(name,slots={}){let output={};const b={speak(t){output.speech=t;return this},reprompt(t){output.reprompt=t;return this},withShouldEndSession(v){output.end=v;return this},getResponse(){return output},withLinkAccountCard(){return this},addDirective(){return this}};return {requestEnvelope:{request:{type:'IntentRequest',intent:{name,slots:Object.fromEntries(Object.entries(slots).map(([k,v])=>[k,{value:v}]))}},context:{System:{user:{userId:'u',accessToken:'a.b.c'},device:{deviceId:'d'}}}},attributesManager:{getSessionAttributes:()=>attrs,setSessionAttributes:a=>attrs=a},responseBuilder:b};}
async function run(n,s={}){const i=input(n,s),h=handlers.find(h=>h.canHandle(i));assert(h,'handler '+n);return h.handle(i);}
let count=0;async function test(name,f){await f();count++;console.log('OK '+name)}
const task=(i,extra={})=>({id:'t'+i,title:'Tarefa '+i,horse:'Cavalo '+i,time:'15:20',day:'2026-11-26',kind:'task',revision:'a'.repeat(32),...extra});
const version='b'.repeat(32);let rows=Array.from({length:12},(_,i)=>task(i+1));
const paging=a=>({tasks:rows.slice(a.offset,a.offset+5),offset:a.offset,total:rows.length,day:'2026-11-26',snapshotVersion:version});
await test('12 tarefas lidas com sim/continua sem omissões',async()=>{attrs={};remote=paging;await run('EVATaskListIntent');assert.equal(attrs.taskPage.tasks[0].id,'t1');await run('AMAZON.YesIntent');assert.equal(attrs.taskPage.tasks[0].id,'t6');await run('EVATaskNextIntent');assert.equal(attrs.taskPage.tasks.at(-1).id,'t12');assert.equal(attrs.taskPage.hasMore,false);});
await test('pedido por concluir encaminhado para tarefas',async()=>{attrs={};remote=paging;const r=await run('EVAQuaisIntent',{pergunta:'tarefas estão por concluir'});assert.match(r.speech,/12 tarefas/);});
await test('marcação por confirmar permanece legível',async()=>{attrs={};remote=a=>({...paging(a),tasks:[task(1,{kind:'booking',bookingStatus:'pending',horse:'Destiny'})]});const r=await run('EVATaskListIntent');assert.match(r.speech,/Destiny/);assert.match(r.speech,/por confirmar/);});
await test('mudança durante paginação recomeça em zero',async()=>{attrs={};remote=paging;await run('EVATaskListIntent');remote=a=>({...paging(a),snapshotVersion:'c'.repeat(32)});const r=await run('EVATaskNextIntent');assert.equal(attrs.taskPage.offset,0);assert.match(r.speech,/lista mudou/);});
await test('lista expirada exige nova consulta',async()=>{attrs={taskPage:{expires:0,hasMore:true}};const r=await run('EVATaskNextIntent');assert.match(r.speech,/expirou/);});
await test('rótulos longos não cortam a meio da tarefa',async()=>{attrs={};remote=a=>({...paging(a),tasks:rows.slice(0,5).map(t=>({...t,title:'&'.repeat(160),horse:'<'.repeat(140)}))});const r=await run('EVATaskListIntent');assert(r.speech.length<7900);assert(attrs.taskPage.tasks.length<5);assert(attrs.taskPage.hasMore);assert(!r.speech.endsWith('&am'));});
await test('resposta inválida não cria lista selecionável',async()=>{attrs={};remote=a=>({...paging(a),offset:-1});await run('EVATaskListIntent');assert.equal(attrs.taskPage,undefined);});
await test('pellets pede pátio perante boxe ambígua',async()=>{attrs={};remote=()=>({code:'PELLETS_AMBIGUOUS'});const r=await run('EVAPelletsBoxIntent',{boxe:'2',sacos:'2'});assert.match(r.speech,/pátio/);assert.equal(attrs.pendingPellets.phase,'patio');});
const confirmation='aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
await test('pellets confirma e completa sem segunda preparação',async()=>{attrs={};calls=[];remote=a=>a.action==='prepare'?{horse:'Remy',box:'1',patio:'Pátio Dr. Pedro',confirmation,expiresAt:new Date(Date.now()+180000).toISOString()}:{status:'recorded',bags:2,kg:30,horse:'Remy',box:'1',patio:'Pátio Dr. Pedro'};await run('EVAPelletsBoxIntent',{boxe:'1',sacos:'2',patio:'Pátio Dr. Pedro'});assert.equal(calls.length,1);const r=await run('AMAZON.YesIntent');assert.match(r.speech,/30 quilos/);assert.equal(calls[1].confirmation,confirmation);assert.equal(attrs.pendingPellets,undefined);});
await test('zero cancela sem contactar o servidor',async()=>{attrs={};calls=[];await run('EVAPelletsBoxIntent',{boxe:'1',sacos:'0'});assert.equal(calls.length,0);});
await test('pellets negativa não escreve',async()=>{attrs={pendingPellets:{phase:'confirm',confirmation}};calls=[];await run('AMAZON.NoIntent');assert.equal(calls.length,0);assert.equal(attrs.pendingPellets,undefined);});
await test('falha ao concluir mantém o mesmo identificador para recuperar',async()=>{attrs={pendingPellets:{phase:'confirm',confirmation}};remote=()=>{throw Error('network')};await run('AMAZON.YesIntent');assert.equal(attrs.pendingPellets.confirmation,confirmation);});
await test('novo pedido de tarefas abandona pellets por confirmar',async()=>{attrs={pendingPellets:{phase:'confirm',confirmation}};remote=paging;await run('EVATaskListIntent');assert.equal(attrs.pendingPellets,undefined);});
// Worker com pedido HTTP real e transporte Supabase simulado.
if(!globalThis.crypto)Object.defineProperty(globalThis,'crypto',{value:webcrypto});
const worker=(await import('./EVA_Worker_Tarefas.mjs')).default;
const env={EVA_ALEXA_SECRET:'x'.repeat(40),P57_ALEXA_TASKS_ENABLED:'true',P57_ALEXA_PELLETS_ENABLED:'true',P57_ALLOWED_DEVICE_HASHES:'a'.repeat(64),P57_SUPABASE_PUBLISHABLE_KEY:'sb_publishable_test'};
let upstream=[],fetchAnswer={};globalThis.fetch=async(url,init)=>{upstream.push({url,body:JSON.parse(init.body),headers:init.headers});return Response.json(fetchAnswer);};
async function request(path,body={},override={}){return worker.fetch(new Request('https://eva.example'+path,{method:'POST',headers:{Authorization:'Bearer '+env.EVA_ALEXA_SECRET,'Content-Type':'application/json'},body:JSON.stringify({patioAccessToken:'a.b.c',deviceHash:'a'.repeat(64),...body})}),{...env,...override});}
await test('Worker tarefas funciona sem Gemini e transmite paginação',async()=>{upstream=[];fetchAnswer=paging({offset:5});const r=await request('/alexa/tasks',{taskAction:{action:'list',offset:5}});assert.equal(r.status,200);assert.equal(upstream[0].body.p_offset,5);assert.equal((await r.json()).source,'patio-live');});
await test('Worker recusa dispositivo não autorizado',async()=>{upstream=[];const r=await request('/alexa/tasks',{deviceHash:'b'.repeat(64),taskAction:{action:'list',offset:0}});assert.equal(r.status,403);assert.equal(upstream.length,0);});
await test('Worker valida quantidade pellets e não chama RPC',async()=>{upstream=[];const r=await request('/alexa/pellets',{pelletAction:{action:'prepare',box:'2',patio:'',bags:31}});assert.equal(r.status,400);assert.equal(upstream.length,0);});
await test('Worker pellets preserva JWT individual',async()=>{upstream=[];fetchAnswer={confirmation};const r=await request('/alexa/pellets',{pelletAction:{action:'prepare',box:'2',patio:'Pátio 57',bags:2}});assert.equal(r.status,200);assert(upstream[0].url.endsWith('/rpc/eva_patio57_pellets'));assert.equal(upstream[0].headers.Authorization,'Bearer a.b.c');assert.equal(upstream[0].body.p_bags,2);});
await test('Worker recusa operações desativadas',async()=>{const r=await request('/alexa/pellets',{pelletAction:{action:'complete',confirmation}},{P57_ALEXA_PELLETS_ENABLED:'false'});assert.equal(r.status,503);});
await test('modelo contém todos os handlers e sem amostras duplicadas',async()=>{const m=JSON.parse(fs.readFileSync('EVA_Modelo_Tarefas.json'));const intents=m.interactionModel.languageModel.intents;const samples=intents.flatMap(i=>i.samples||[]);assert.equal(new Set(samples).size,samples.length);for(const n of ['EVAPelletsBoxIntent','EVAPelletsPatioIntent','EVAPelletsQuantityIntent','EVATaskListIntent','EVATaskNextIntent'])assert(intents.some(i=>i.name===n));});
// Voice Monkey: só simulações, sem emissão de avisos.
const voiceEnv={P57_PUSH_WEBHOOK_SECRET:'test-secret',P57_VOICE_MONKEY_TOKEN:'test-token',SUPABASE_SERVICE_ROLE_KEY:'test-service'};
const vctx=vm.createContext({Deno:{env:{get:k=>voiceEnv[k]}},Response,Request,TextEncoder,crypto:webcrypto,AbortSignal,console,fetch:async()=>{throw Error('unexpected call')}});
const vsrc=fs.readFileSync('EVA_Voice_Monkey.ts','utf8').replace('export {handle,announcement};','').replace('if (import.meta.main) Deno.serve(handle);','');
vm.runInContext(vsrc,vctx);
const announcement=vm.runInContext('announcement',vctx),voiceHandle=vm.runInContext('handle',vctx);
await test('Voice Monkey anuncia data/hora e exige abertura da EVA',async()=>{const text=announcement({horse:'Destiny {VM.USER.FIRST_NAME}',date:'2026-11-26',time:'15:20'});assert.match(text,/15 horas e 20 minutos/);assert.match(text,/por confirmar/);assert.match(text,/abre assistente eva/);assert(!text.includes('{VM.'));});
await test('Voice Monkey rejeita datas inválidas',async()=>{assert.throws(()=>announcement({horse:'Destiny',date:'2026-02-30',time:'15:20'}));});
await test('Voice Monkey recusa webhook sem segredo',async()=>{const r=await voiceHandle(new Request('https://test',{method:'POST',body:'{}'}));assert.equal(r.status,401);});
await test('Voice Monkey não envia quando a base recusa o claim',async()=>{let calls=0;vctx.fetch=async()=>{calls++;return Response.json({send:false,reason:'already_claimed'})};const r=await voiceHandle(new Request('https://test',{method:'POST',headers:{'x-p57-push-secret':'test-secret'},body:JSON.stringify({type:'INSERT',schema:'public',table:'p57_riding_requests',record:{id:confirmation}})}));assert.equal((await r.json()).ignored,true);assert.equal(calls,1);});
console.log(`${count} testes aprovados. SQL e reprodução física no Echo exigem validação separada.`);

// Regressões de sessões longas e consultas sem catálogo.
let directQuestions=[];
ctx.directProbe=async(...args)=>{directQuestions.push(args[0][0].text);return {answer:'Lírio, Pátio 57, box 7.',source:'patio-live'};};
vm.runInContext('requestEVA=(...a)=>directProbe(...a)',ctx);
await test('localiza Lírio sem catálogo consulta o servidor e limpa apenas pedidos pendentes',async()=>{attrs={horseCatalog:[],pendingTask:{phase:'employee'},pendingPellets:{phase:'quantity'},taskPage:{offset:5}};directQuestions=[];const r=await run('EVAHorseSearchIntent',{pergunta:'Lírio'});assert.match(r.speech,/Lírio/);assert.equal(directQuestions[0],'Localiza Lírio');assert.equal(attrs.pendingTask,undefined);assert.equal(attrs.pendingPellets,undefined);});
await test('consulta por número tem comando próprio e inclui o pátio indicado',async()=>{attrs={};directQuestions=[];await run('EVABoxLocationIntent',{boxe:'7',patio:'Pátio 57'});assert.equal(directQuestions[0],'Quem está na boxe 7 do Pátio 57');});
vm.runInContext('requestEVA=(...a)=>remote(...a)',ctx);
await test('pergunta por quantidade repete a quantidade em falta e não conversa geral',async()=>{attrs={};const r=await run('EVAPelletsBoxIntent',{boxe:'7'});assert.equal(r.reprompt,r.speech);assert.match(r.reprompt,/Quantos sacos/);});
await test('pedido de pellets expirado não retém a conversa anterior',async()=>{attrs={pendingPellets:{phase:'confirm',confirmation,expires:Date.now()-1}};calls=[];await run('AMAZON.YesIntent');assert.equal(attrs.pendingPellets,undefined);assert.equal(calls.length,0);});
await test('recomeçar limpa todas as pendências e conserva catálogo; avisa sobre resultado incerto',async()=>{attrs={horseCatalog:[{name:'Lírio'}],pendingPellets:{submitted:true},pendingTask:{phase:'confirm'},history:[1]};const r=await run('EVARestartIntent');assert.equal(attrs.horseCatalog.length,1);assert.equal(attrs.pendingPellets,undefined);assert.equal(attrs.pendingTask,undefined);assert.match(r.speech,/Consulte a aplicação/);});
const rateEnv={...env};delete rateEnv.GEMINI_API_KEY;
let readUpstream=0;
globalThis.fetch=async(url,init)=>{
 if(String(url).includes('generativelanguage.googleapis.com'))return Response.json({candidates:[{content:{parts:[{text:'Resposta simulada.'}]}}]});
 if(String(url).endsWith('/eva_patio57_read')){readUpstream++;return Response.json([{name:'Lírio',stableName:'Lírio',patio:'Pátio 57',box:'7'},{name:'Outro cavalo',patio:'Pátio Dr. Pedro',box:'7'}]);}
 return Response.json({confirmation});
};
async function rateRequest(path,body,user='rate-actor-a'){
 return worker.fetch(new Request('https://fixture.example'+path,{method:'POST',headers:{Authorization:'Bearer '+rateEnv.EVA_ALEXA_SECRET,'CF-Connecting-IP':'shared-lambda-ip'},body:JSON.stringify({userId:user,deviceHash:'a'.repeat(64),patioAccessToken:'a.b.c',...body})}),rateEnv);
}
await test('trinta consultas seguidas por nome sem Gemini não consomem o limite da IA',async()=>{for(let i=0;i<30;i++){const r=await rateRequest('/alexa/chat',{messages:[{role:'user',text:'Localiza Lírio'}]});assert.equal(r.status,200);assert.match((await r.json()).answer,/Lírio/);}assert.equal(readUpstream,30);});
await test('vinte preparações de pellets não partilham limite com consultas por nome',async()=>{for(let i=0;i<20;i++)assert.equal((await rateRequest('/alexa/pellets',{pelletAction:{action:'prepare',box:'7',patio:'Pátio 57',bags:2}})).status,200);});
await test('IA conserva limite de doze sem bloquear consultas operacionais',async()=>{rateEnv.GEMINI_API_KEY='fixture';for(let i=0;i<12;i++)assert.equal((await rateRequest('/alexa/chat',{messages:[{role:'user',text:'Bom dia, como estás?'}]})).status,200);const r=await rateRequest('/alexa/chat',{messages:[{role:'user',text:'Bom dia, como estás?'}]});assert.equal(r.status,429);assert.equal((await r.json()).code,'EVA_RATE_LIMIT');assert.equal((await rateRequest('/alexa/chat',{messages:[{role:'user',text:'Localiza Lírio'}]})).status,200);});
await test('consulta por boxe filtra o pátio e dispensa catálogo',async()=>{const r=await rateRequest('/alexa/chat',{messages:[{role:'user',text:'Quem está na boxe 7 do Pátio 57'}]});assert.equal(r.status,200);const a=(await r.json()).answer;assert.match(a,/Lírio/);assert(!a.includes('Outro cavalo'));});
await test('limite de leitura é explícito e isolado por conta mesmo atrás do mesmo IP',async()=>{for(let i=0;i<28;i++)assert.equal((await rateRequest('/alexa/chat',{messages:[{role:'user',text:'Localiza Lírio'}]})).status,200);const r=await rateRequest('/alexa/chat',{messages:[{role:'user',text:'Localiza Lírio'}]});assert.equal(r.status,429);assert.equal((await r.json()).code,'EVA_RATE_LIMIT');assert.equal((await rateRequest('/alexa/chat',{messages:[{role:'user',text:'Localiza Lírio'}]},'rate-actor-b')).status,200);});
console.log('Total: '+count+' testes JavaScript aprovados, com serviços simulados e sem baixas reais.');
