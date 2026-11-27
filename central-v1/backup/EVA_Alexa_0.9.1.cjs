'use strict';
// EVA 0.9.1 — Skill Alexa independente da skill Pátio 57.
// A credencial da Alexa é lida da tabela DynamoDB da própria skill (piloto privado).
// NUNCA escrever a chave Gemini, o código EVA web ou o segredo Alexa neste ficheiro.
const Alexa = require('ask-sdk-core');
const https = require('https');
const crypto = require('crypto');
const AWS = require('aws-sdk');
const db = new AWS.DynamoDB.DocumentClient({region:process.env.DYNAMODB_PERSISTENCE_REGION || 'us-east-1'});
let cachedSecret = null;
async function getAlexaSecret() {
  if(cachedSecret) return cachedSecret;
  const table = process.env.DYNAMODB_PERSISTENCE_TABLE_NAME;
  if(!table) throw new Error('dynamodb-not-configured');
  const item = await db.get({TableName:table, Key:{id:'EVA_ALEXA_CONFIG'}, ConsistentRead:true}).promise();
  const secret = item.Item && item.Item.secret;
  if(typeof secret !== 'string' || !/^[A-Za-z0-9_-]{32,256}$/.test(secret)) throw new Error('alexa-secret-not-found');
  cachedSecret = secret;
  return secret;
}

const WORKER_HOST = 'eva-ia-equigest.antoniochorapinto.workers.dev';
const MAX_HISTORY = 10;
function speech(text) {
  return String(text).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function reply(input,text,followUp=true) {
  const builder=input.responseBuilder.speak(speech(text));
  if(followUp) builder.withShouldEndSession(false).reprompt('Em que mais posso ajudar?');
  else builder.withShouldEndSession(true);
  return builder.getResponse();
}
async function requestEVA(messages,userId,patioAccessToken,deviceId,catalog=false,taskAction=null,pelletAction=null) {
  const key=await getAlexaSecret();
  const deviceHash=typeof deviceId==='string'?crypto.createHash('sha256').update('eva-device-v1:'+deviceId).digest('hex'):undefined;
  const body=JSON.stringify({messages,userId,deviceHash,...(taskAction?{taskAction}:{}),...(pelletAction?{pelletAction}:{}),...(typeof patioAccessToken==='string'?{patioAccessToken}:{})});
  return new Promise((resolve,reject)=>{
    const req=https.request({
      hostname:WORKER_HOST,port:443,path:pelletAction?'/alexa/pellets':taskAction?'/alexa/tasks':catalog?'/alexa/catalog':'/alexa/chat',method:'POST',
      timeout:6800,
      headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body),'Authorization':'Bearer '+key}
    },res=>{
      let raw='';res.setEncoding('utf8');
      res.on('data',part=>{raw+=part;if(raw.length>(catalog?48000:12000))req.destroy(new Error('too-long'));});
      res.on('end',()=>{
        try{const data=JSON.parse(raw);if(res.statusCode!==200 || ((taskAction||pelletAction)?(!data||typeof data!=='object'||Array.isArray(data)):catalog?!Array.isArray(data.catalog):typeof data.answer!=='string')){
          const error=new Error('remote-error-'+res.statusCode);
          const permitted=['PATIO_DEVICE_REQUIRED','PATIO_LINK_REQUIRED','PATIO_FORBIDDEN','PATIO_UNAVAILABLE','PATIO_NOT_CONFIGURED','PATIO_READ_ONLY','PATIO_UNSUPPORTED','AI_DEADLINE','AI_TIMEOUT','AI_RATE_LIMIT','AI_REQUEST_INVALID','AI_MODEL_NOT_FOUND','AI_AUTH','AI_PERMISSION','AI_UNAVAILABLE','AI_BLOCKED','AI_OUTPUT_LIMIT','AI_EMPTY','AI_NETWORK','AI_RESPONSE_INVALID','MEMORY_UNAVAILABLE','TASKS_NOT_ENABLED','TASK_REQUEST_INVALID','EMPLOYEE_INVALID','PELLETS_NOT_ENABLED','EVA_RATE_LIMIT'];
          if(permitted.includes(data.code))error.code=data.code;
          // Identificador derivado do dispositivo: não é uma credencial de acesso.
          if(data.code==='PATIO_DEVICE_REQUIRED' && /^[a-f0-9]{64}$/.test(deviceHash||'')){
            error.deviceCode=deviceHash;
            console.info('EVA_DEVICE_AUTHORIZATION',JSON.stringify({deviceCode:deviceHash}));
          }

          return reject(error);
        }resolve((taskAction||pelletAction)?data:catalog?data:{answer:data.answer,source:data.source});}
        catch(e){reject(e);}
      });
    });
    req.on('timeout',()=>req.destroy(new Error('timeout')));
    req.on('error',reject);req.end(body);
  });
}
const horseKey=value=>String(value||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
function clearHorseCatalog(input){
  input.responseBuilder.addDirective({type:'Dialog.UpdateDynamicEntities',updateBehavior:'CLEAR'});
}
async function loadHorseCatalog(input){
  const attrs=input.attributesManager.getSessionAttributes();
  attrs.horseCatalog=[];
  delete attrs.pendingHorse;
  const system=input.requestEnvelope.context?.System;
  if(!system?.user?.accessToken){clearHorseCatalog(input);input.attributesManager.setSessionAttributes(attrs);return false;}
  try{
    const result=await requestEVA([],system.user.userId,system.user.accessToken,system.device?.deviceId,true);
    let cost=0;
    const ids=new Set();
    for(const row of result.catalog){
      if(!row || typeof row.id!=='string' || !/^[A-Za-z0-9_-]{1,64}$/.test(row.id) || ids.has(row.id))throw Error('catalog-invalid');
      for(const value of [row.canonical,row.name,...(Array.isArray(row.aliases)?row.aliases:[])])if(typeof value!=='string' || !value.trim() || value.length>140)throw Error('catalog-invalid');
      if(!Array.isArray(row.aliases)||row.aliases.length>4)throw Error('catalog-invalid');
      ids.add(row.id);cost+=1+row.aliases.length;
    }
    if(cost>100)throw Error('catalog-limit');
    attrs.horseCatalog=result.catalog;
    console.info('EVA_CATALOG_READY',JSON.stringify({count:result.catalog.length}));
    input.responseBuilder.addDirective(result.catalog.length?{
      type:'Dialog.UpdateDynamicEntities',updateBehavior:'REPLACE',types:[{
        name:'EVA_HORSE',values:result.catalog.map(row=>({id:row.id,name:{value:row.name,...(row.aliases.length?{synonyms:row.aliases}:{})}}))
      }]
    }:{type:'Dialog.UpdateDynamicEntities',updateBehavior:'CLEAR'});
    input.attributesManager.setSessionAttributes(attrs);
    return true;
  }catch(error){
    clearHorseCatalog(input);
    input.attributesManager.setSessionAttributes(attrs);
    // Não registar os nomes, o token nem o identificador do dispositivo.
    console.error('EVA catalog unavailable',error.code||'CATALOG_UNAVAILABLE');
    return false;
  }
}
const LaunchRequestHandler={
  canHandle(input){return Alexa.getRequestType(input.requestEnvelope)==='LaunchRequest';},
  async handle(input){
    input.attributesManager.setSessionAttributes({history:[]});
    await loadHorseCatalog(input);
    return reply(input,'Olá. Sou a EVA, a assistente do pátio. Em que posso ajudar?');
  }
};
async function horseReply(input,name){
  const system=input.requestEnvelope.context?.System;
  try{
    // A resposta é sempre consultada novamente; o catálogo não contém boxes nem permissões.
    const result=await requestEVA([{role:'user',text:'Onde está '+name+'?'}],system?.user?.userId,system?.user?.accessToken,system?.device?.deviceId);
    return reply(input,result.answer);
  }catch(error){
    if(error.code==='PATIO_LINK_REQUIRED')input.responseBuilder.withLinkAccountCard();
    return reply(input,'Não consegui consultar este cavalo. Verifique a ligação da conta do pátio e tente novamente.');
  }
}
const HorseLocationHandler={
  canHandle(input){return Alexa.getRequestType(input.requestEnvelope)==='IntentRequest' && Alexa.getIntentName(input.requestEnvelope)==='EVAHorseLocationIntent';},
  async handle(input){
    const attrs=input.attributesManager.getSessionAttributes();
    delete attrs.pendingTask;
    delete attrs.pendingPellets;
    delete attrs.pendingHorse;
    input.attributesManager.setSessionAttributes(attrs);
    console.info('EVA_ROUTE',JSON.stringify({route:'horse',catalogCount:(attrs.horseCatalog||[]).length}));
    const slot=input.requestEnvelope.request.intent.slots?.cavalo;
    const raw=typeof slot?.value==='string'?slot.value.trim():'';
    if(!raw)return reply(input,'Qual é o nome do cavalo?');
    // Sem catálogo nesta sessão, carregá-lo para a próxima tentativa; não adivinhar.
    if(!Array.isArray(attrs.horseCatalog)||!attrs.horseCatalog.length){
      const loaded=await loadHorseCatalog(input);
      return reply(input,loaded?'Já carreguei os nomes atuais. Repita, por favor, o nome do cavalo.':'Não consegui carregar os nomes atuais. Pode consultar pela box ou verificar a ligação da conta.');
    }
    const exact=attrs.horseCatalog.filter(row=>[row.canonical,row.name,...row.aliases].some(label=>horseKey(label)===horseKey(raw)));
    const authorities=slot.resolutions?.resolutionsPerAuthority||[];
    const resolvedIds=new Set(authorities.filter(authority=>authority.status?.code==='ER_SUCCESS_MATCH')
      .flatMap(authority=>(authority.values||[]).map(entry=>entry.value?.id)).filter(Boolean));
    const candidates=exact.length?exact:attrs.horseCatalog.filter(row=>resolvedIds.has(row.id));
    if(candidates.length>1)return reply(input,'Há mais de um cavalo possível. Indique o nome oficial completo ou consulte pela box.');
    if(!candidates.length)return reply(input,'Não consegui identificar o nome com segurança. Pode dizer o nome oficial, o nome de estábulo ou consultar pela box?');
    const row=candidates[0];
    const originalName=[row.canonical,row.name].some(label=>horseKey(label)===horseKey(raw));
    if(exact.length===1 && originalName)return horseReply(input,row.canonical);
    attrs.pendingHorse={id:row.id,expires:Date.now()+90000};
    input.attributesManager.setSessionAttributes(attrs);
    return reply(input,'Referia-se a '+row.name+'?');
  }
};
const HorseConfirmationHandler={
  canHandle(input){return Alexa.getRequestType(input.requestEnvelope)==='IntentRequest' && ['AMAZON.YesIntent','AMAZON.NoIntent'].includes(Alexa.getIntentName(input.requestEnvelope));},
  async handle(input){
    const attrs=input.attributesManager.getSessionAttributes();
    delete attrs.pendingTask;
    const pending=attrs.pendingHorse;
    delete attrs.pendingHorse;
    input.attributesManager.setSessionAttributes(attrs);
    if(!pending || pending.expires<Date.now())return reply(input,'Indique, por favor, o pedido completo.');
    if(Alexa.getIntentName(input.requestEnvelope)==='AMAZON.NoIntent')return reply(input,'Está bem. Diga o nome oficial do cavalo ou consulte pela box.');
    const row=(attrs.horseCatalog||[]).find(row=>row.id===pending.id);
    if(!row)return reply(input,'Indique, por favor, novamente o nome do cavalo.');
    return horseReply(input,row.canonical);
  }
};

// Os inícios naturais são retirados pela Alexa dos slots e repostos aqui.
// A skill não recebe uma transcrição livre de todas as frases.
const QUESTION_PREFIXES = Object.freeze({
  "EVAQueIntent": "que",
  "EVAOndeIntent": "onde fica",
  "EVAComoIntent": "como",
  "EVAQualIntent": "qual",
  "EVAQuaisIntent": "quais",
  "EVAQuantosIntent": "quantos",
  "EVAQuantasIntent": "quantas",
  "EVAQuemIntent": "quem",
  "EVAQuandoIntent": "quando",
  "EVAPorqueIntent": "porque",
  "EVAMotivoSeparadoIntent": "por que",
  "EVAOQueIntent": "o que",
  "EVASeraIntent": "será que",
  "EVAPodesIntent": "podes",
  "EVAPodeIntent": "pode",
  "EVALembraIntent": "lembra-te que",
  "EVAGuardaIntent": "guarda que",
  "EVAMemorizaIntent": "memoriza que",
  "EVAPalavraIntent": "a palavra",
  "EVATesteIntent": "para o teste"
});
function questionText(input) {
  const name=Alexa.getIntentName(input.requestEnvelope);
  const value=Alexa.getSlotValue(input.requestEnvelope,'pergunta');
  if(typeof value!=='string' || !value.trim())return '';
  const prefix=QUESTION_PREFIXES[name];
  return prefix ? prefix+' '+value.trim() : value.trim();
}
const TASK_EMPLOYEE_INTENTS=Object.freeze({EVATaskAntonioIntent:'António',EVATaskViniciusIntent:'Vinicius',EVATaskIgorIntent:'Igor',EVATaskTiagoIntent:'Tiago'});
const TASK_EMPLOYEES={antonio:'António',vinicius:'Vinicius',igor:'Igor',tiago:'Tiago'};
const TASK_NOTICES={
 EVA_RATE_LIMIT:'Foi atingido um limite temporário de pedidos. Aguarde um minuto e repita.',
 NO_PENDING_BOOKINGS:'Não há marcações por confirmar na lista de pendentes.',
 TASK_SELECTION_REQUIRED:'Há várias marcações por confirmar. Peça as tarefas pendentes e diga confirma a marcação, seguido do número da lista.',
 BOOKING_ALREADY_CONFIRMED:'Esta marcação já está confirmada e continua pendente até ser concluída.',
 BOOKING_CONFIRM_FIRST:'Esta marcação ainda está por confirmar. Diga confirma a marcação, seguido do número da lista.',

 TASKS_NOT_ENABLED:'A consulta e conclusão de tarefas ainda não foram ativadas nesta instalação.',
 TASK_CHANGED:'A tarefa mudou ou já foi concluída. Vou precisar que peça novamente a lista de tarefas.',
 TASK_EXPIRED:'Esta confirmação expirou. Peça novamente as tarefas e escolha a tarefa a concluir.',
 TASK_CONFIRMATION_REQUIRED:'Escolha primeiro a tarefa e confirme a conclusão.',
 TASK_APP_REQUIRED:'Esta tarefa de ferrador deve ser concluída na aplicação, onde é enviado o aviso ao responsável.',
 EMPLOYEE_INVALID:'Diga António, Vinicius, Igor ou Tiago.',
 PATIO_LINK_REQUIRED:'É necessário associar a conta do pátio na aplicação Alexa.',
 PATIO_DEVICE_REQUIRED:'Este dispositivo ainda não tem autorização para consultar o pátio.',
 PATIO_FORBIDDEN:'A sessão terminou ou a conta não tem acesso às tarefas.',
 PATIO_NOT_CONFIGURED:'A ligação ao pátio precisa de configuração.',
 PATIO_UNAVAILABLE:'Não consegui confirmar o resultado. Não vou afirmar que a tarefa ficou concluída. Pode repetir o nome para eu verificar o mesmo pedido.',
 TASK_DATA_INVALID:'Não consegui validar esta tarefa. Confirme-a na aplicação.'
};
function taskReply(input,text){
 input.responseBuilder.speak(speech(text)).withShouldEndSession(false).reprompt('Pode pedir mais tarefas, indicar o número da tarefa ou fazer outro pedido.');
 return input.responseBuilder.getResponse();
}
function asksPendingTasks(q){return /\b(tarefas?|marcacoes|marcacao)\b/.test(q) && /\b(hoje|pendentes?|fazer|listar?|le|ler|diz|quais|todas|por concluir|por confirmar|nao concluidas)\b/.test(q) && !/\b(conclui|concluir tarefa|termina|regista|apaga|cancela)\b/.test(q);}
function taskLabel(t){return [t.title,t.day?'dia '+t.day.slice(8,10)+' do '+t.day.slice(5,7)+' de '+t.day.slice(0,4):'',t.horse&&t.horse!=='__all_horses__'?t.horse:'',t.time?'às '+t.time:''].filter(Boolean).join(', ');}
function taskAttrs(input){return input.attributesManager.getSessionAttributes();}
async function taskCall(input,taskAction){
 const s=input.requestEnvelope.context?.System;
 return requestEVA([],s?.user?.userId,s?.user?.accessToken,s?.device?.deviceId,false,taskAction);
}
function taskFailure(input,error){
 if(error.code==='PATIO_LINK_REQUIRED')input.responseBuilder.withLinkAccountCard();
 return taskReply(input,TASK_NOTICES[error.code]||TASK_NOTICES.PATIO_UNAVAILABLE);
}
const TaskHandler={
 canHandle(input){
  if(Alexa.getRequestType(input.requestEnvelope)!=='IntentRequest')return false;
  const name=Alexa.getIntentName(input.requestEnvelope),pending=taskAttrs(input).pendingTask;
  const question=horseKey(questionText(input));
  const asksTasks=asksPendingTasks(question);
  return Object.prototype.hasOwnProperty.call(TASK_EMPLOYEE_INTENTS,name) || asksTasks || ['EVATaskListIntent','EVATaskNextIntent','EVATaskCompleteIntent','EVATaskEmployeeIntent','EVABookingConfirmIntent','EVABookingConfirmOnlyIntent'].includes(name)
   || !pending&&name==='AMAZON.YesIntent'&&!!taskAttrs(input).taskPage?.hasMore
   || !!pending&&['AMAZON.YesIntent','AMAZON.NoIntent','AMAZON.FallbackIntent'].includes(name);
 },
 async handle(input){
  const attrs=taskAttrs(input);let name=Alexa.getIntentName(input.requestEnvelope);
  delete attrs.pendingHorse;
  delete attrs.pendingPellets;
  const save=()=>input.attributesManager.setSessionAttributes(attrs);
  let pending=attrs.pendingTask;
  if(pending&&pending.expires<Date.now()&&!['EVATaskListIntent','EVATaskNextIntent'].includes(name)){
   delete attrs.pendingTask;save();return taskReply(input,TASK_NOTICES.TASK_EXPIRED);
  }
  if(name==='EVABookingConfirmOnlyIntent'&&pending){
   if(pending.phase==='employee')return taskReply(input,'Quem realizou a tarefa? Diga António, Vinicius, Igor ou Tiago.');
   name='AMAZON.YesIntent';
  }
  if(name==='AMAZON.YesIntent'&&!pending&&attrs.taskPage?.hasMore)name='EVATaskNextIntent';
  if(name==='AMAZON.YesIntent'&&pending?.phase==='booking-confirm'){
   try{
    const result=await taskCall(input,{action:'confirm',confirmation:pending.confirmation});
    if(result.code){
     if(['TASK_CHANGED','TASK_EXPIRED','TASK_CONFIRMATION_REQUIRED'].includes(result.code)){delete attrs.pendingTask;save();}
     return taskReply(input,TASK_NOTICES[result.code]||TASK_NOTICES.PATIO_UNAVAILABLE);
    }
    if(result.status!=='confirmed')throw Error('invalid-confirm-result');
    delete attrs.pendingTask;delete attrs.taskPage;save();
    return taskReply(input,'Marcação confirmada: '+taskLabel(result)+'. Continua na lista de pendentes até ser concluída.');
   }catch(error){return taskFailure(input,error);}
  }
  if(['EVABookingConfirmIntent','EVABookingConfirmOnlyIntent'].includes(name)){
   delete attrs.pendingTask;save();let action={action:'prepare_confirm'};
   if(name==='EVABookingConfirmIntent'){
    const page=attrs.taskPage,index=Number(Alexa.getSlotValue(input.requestEnvelope,'numero'))-1-(page?.offset||0);
    if(!page||page.expires<Date.now()||!Number.isInteger(index)||index<0||index>=page.tasks.length)return taskReply(input,'Peça as tarefas pendentes e diga confirma a marcação, seguido do número da lista.');
    const t=page.tasks[index];
    if(t.kind!=='booking')return taskReply(input,'Esse número corresponde a uma tarefa, não a uma marcação. Escolha uma marcação por confirmar.');
    action={...action,taskId:t.id,day:t.day,revision:t.revision};
   }
   try{
    const result=await taskCall(input,action);
    if(result.code)return taskReply(input,TASK_NOTICES[result.code]||TASK_NOTICES.PATIO_UNAVAILABLE);
    if(!result.task||!result.confirmation||!Number.isFinite(Date.parse(result.expiresAt)))throw Error('invalid-confirm-prepare');
    attrs.pendingTask={confirmation:result.confirmation,phase:'booking-confirm',expires:Date.parse(result.expiresAt)};save();
    return taskReply(input,'Confirma que aceita a marcação '+taskLabel(result.task)+'? Esta confirmação mantém a tarefa pendente.');
   }catch(error){return taskFailure(input,error);}
  }
  if(name==='AMAZON.NoIntent'){
   delete attrs.pendingTask;save();return taskReply(input,'Pedido de voz cancelado.');
  }
  if(name==='AMAZON.FallbackIntent')return taskReply(input,pending.phase==='booking-confirm'?'Confirma que aceita a marcação? Diga sim ou não.':pending.phase==='employee'?'Quem realizou a tarefa? Diga António, Vinicius, Igor ou Tiago.':'Confirma que esta tarefa foi realizada? Diga sim ou não.');
  if(name==='AMAZON.YesIntent'){
   if(pending.phase!=='confirm')return taskReply(input,'Quem realizou a tarefa? Diga António, Vinicius, Igor ou Tiago.');
   pending.phase='employee';save();return taskReply(input,'Quem realizou a tarefa?');
  }
  if(name==='EVATaskEmployeeIntent'||Object.prototype.hasOwnProperty.call(TASK_EMPLOYEE_INTENTS,name)){
   if(!pending||pending.phase!=='employee')return taskReply(input,'Escolha primeiro uma tarefa da lista e confirme a conclusão.');
   const raw=TASK_EMPLOYEE_INTENTS[name]||Alexa.getSlotValue(input.requestEnvelope,'funcionario');
   const employee=TASK_EMPLOYEES[horseKey(raw)];
   if(!employee)return taskReply(input,TASK_NOTICES.EMPLOYEE_INVALID);
   if(pending.employee&&pending.employee!==employee)return taskReply(input,'Já enviei este pedido com outro nome. Repita esse nome para verificar o resultado, ou diga não para cancelar.');
   pending.employee=employee;save();
   try{
    const result=await taskCall(input,{action:'complete',confirmation:pending.confirmation,employee});
    if(result.code){
     if(['TASK_CHANGED','TASK_EXPIRED','TASK_CONFIRMATION_REQUIRED','TASK_APP_REQUIRED'].includes(result.code)){delete attrs.pendingTask;save();}
     return taskReply(input,TASK_NOTICES[result.code]||TASK_NOTICES.PATIO_UNAVAILABLE);
    }
    if(result.status!=='completed')throw Error('invalid-task-response');
    delete attrs.pendingTask;delete attrs.taskPage;save();
    return taskReply(input,'Tarefa concluída: '+taskLabel(result)+'. Registada em nome de '+result.employee+'.');
   }catch(error){return taskFailure(input,error);}
  }
  if(name==='EVATaskCompleteIntent'){
   const value=Alexa.getSlotValue(input.requestEnvelope,'numero');
   const page=attrs.taskPage,index=Number(value)-1-(page?.offset||0);
   delete attrs.pendingTask;save();
   if(!page||page.expires<Date.now()||!Number.isInteger(index)||index<0||index>=page.tasks.length)return taskReply(input,'Peça primeiro as tarefas de hoje. Depois diga conclui a tarefa, seguido do número da lista que acabei de ler.');
   const t=page.tasks[index];
   try{
    const result=await taskCall(input,{action:'prepare',taskId:t.id,day:t.day,revision:t.revision});
    if(result.code)return taskReply(input,TASK_NOTICES[result.code]||TASK_NOTICES.PATIO_UNAVAILABLE);
    if(typeof result.confirmation!=='string'||!result.task||!Number.isFinite(Date.parse(result.expiresAt)))throw Error('invalid-prepare');
    attrs.pendingTask={confirmation:result.confirmation,phase:'confirm',expires:Date.parse(result.expiresAt)};save();
    return taskReply(input,'Confirma que foi realizada a tarefa '+taskLabel(result.task)+'?');
   }catch(error){return taskFailure(input,error);}
  }
  const continuing=name==='EVATaskNextIntent'||name==='AMAZON.YesIntent';
  if(continuing&&(!attrs.taskPage||attrs.taskPage.expires<Date.now())){delete attrs.taskPage;save();return taskReply(input,'A lista expirou. Peça novamente todas as tarefas pendentes.');}
  if(continuing&&!attrs.taskPage.hasMore)return taskReply(input,'Já li todas as tarefas desta lista. Pode pedir novamente as tarefas pendentes para atualizar.');
  const previousPage=attrs.taskPage;
  let offset=continuing?previousPage.offset+previousPage.tasks.length:0;
  delete attrs.taskPage;delete attrs.pendingTask;save();
  try{
   let result=await taskCall(input,{action:'list',offset});
   let refreshed=false;
   if(continuing&&result.snapshotVersion!==previousPage.snapshotVersion){result=await taskCall(input,{action:'list',offset:0});offset=0;refreshed=true;}
   if(result.code)return taskReply(input,TASK_NOTICES[result.code]||TASK_NOTICES.PATIO_UNAVAILABLE);
   if(!Array.isArray(result.tasks)||result.tasks.length>5||!Number.isSafeInteger(result.total)||result.total<0||result.offset!==offset||!Number.isSafeInteger(result.offset)||!/^\d{4}-\d{2}-\d{2}$/.test(result.day)||!/^([a-f0-9]{32})$/.test(result.snapshotVersion)||result.total<offset+result.tasks.length||(!result.tasks.length&&offset<result.total))throw Error('invalid-task-list');
   for(const t of result.tasks)if(!t||typeof t.id!=='string'||!['task','booking'].includes(t.kind)||typeof t.title!=='string'||t.title.length>160||typeof t.horse!=='string'||t.horse.length>140||typeof t.time!=='string'||t.time.length>5||!/^\d{4}-\d{2}-\d{2}$/.test(t.day)||!/^[a-f0-9]{32}$/.test(t.revision))throw Error('invalid-task-row');
   // Limitar apenas entre tarefas: nunca cortar uma tarefa ou uma entidade XML.
   const received=result.tasks;
   result.tasks=[];
   for(const t of received){if(speech(JSON.stringify([...result.tasks,t])).length>5500)break;result.tasks.push(t);}
   if(received.length&&!result.tasks.length)throw Error('task-speech-too-long');
   attrs.taskPage={snapshotVersion:result.snapshotVersion,tasks:result.tasks,offset:result.offset,hasMore:result.total>result.offset+result.tasks.length,expires:Date.now()+180000};save();
   if(!result.tasks.length)return taskReply(input,offset?'Não há mais tarefas nesta lista.':'Não há tarefas nem marcações por concluir.');
   const remaining=result.total>offset+result.tasks.length;
   return taskReply(input,(refreshed?'A lista mudou. Vou recomeçar com os dados atuais. ':'')+(offset?'Mais tarefas pendentes. ':'Há '+result.total+' tarefas e marcações por concluir. ')+result.tasks.map((t,i)=>(offset+i+1)+': '+taskLabel(t)+(t.bookingStatus?' — '+({pending:'por confirmar',confirmed:'confirmada',preparing:'a aparelhar',ready:'aparelhada'}[t.bookingStatus]||'pendente'):'')).join('. ')+'. Pode dizer conclui a tarefa, seguido do número desta lista.'+(remaining?' Ainda há mais na lista. Quer que continue? Pode dizer sim ou mais tarefas.':''));
  }catch(error){return taskFailure(input,error);}
 }
};


function resolvedPatio(input){const slot=input.requestEnvelope.request.intent.slots?.patio;const values=(slot?.resolutions?.resolutionsPerAuthority||[]).filter(a=>a.status?.code==='ER_SUCCESS_MATCH').flatMap(a=>(a.values||[]).map(v=>v.value?.name)).filter(Boolean);return [...new Set(values)].length===1?values[0]:Alexa.getSlotValue(input.requestEnvelope,'patio')||'';}
const PELLET_NOTICES={
 PELLETS_NOT_ENABLED:'O registo de pellets ainda não está ativado.',
 PELLETS_AMBIGUOUS:'Há mais de um cavalo nessa boxe. Indique também o pátio.',
 PELLETS_HORSE_NOT_FOUND:'Não encontrei um cavalo presente nessa boxe e nesse pátio.',
 PELLETS_CHANGED:'O cavalo, a boxe ou o stock mudou. Repita o pedido completo para eu confirmar os dados atuais.',
 PELLETS_EXPIRED:'A confirmação expirou. Repita o pedido de pellets.',
 PELLETS_INVALID:'Indique um número de boxe e entre um e trinta sacos inteiros.',
 PELLETS_STOCK_INVALID:'É necessário verificar o artigo de pellets e o peso de quinze quilos por saco na aplicação.',
 PATIO_FORBIDDEN:'Esta operação requer a conta da administração do pátio.'
};
const PelletsHandler={
 canHandle(input){
  if(Alexa.getRequestType(input.requestEnvelope)!=='IntentRequest')return false;
  const n=Alexa.getIntentName(input.requestEnvelope);
  return ['EVAPelletsBoxIntent','EVAPelletsPatioIntent','EVAPelletsQuantityIntent'].includes(n)||!!taskAttrs(input).pendingPellets&&['AMAZON.YesIntent','AMAZON.NoIntent','AMAZON.FallbackIntent','EVABookingConfirmOnlyIntent'].includes(n);
 },
 async handle(input){
  const attrs=taskAttrs(input),n=Alexa.getIntentName(input.requestEnvelope);
  delete attrs.pendingTask;delete attrs.pendingHorse;delete attrs.taskPage;
  const save=()=>input.attributesManager.setSessionAttributes(attrs);
  const say=text=>input.responseBuilder.speak(speech(text)).withShouldEndSession(false).reprompt(speech(text)).getResponse();
  let p=attrs.pendingPellets;
  if(p&&p.expires<Date.now()&&n!=='EVAPelletsBoxIntent'){delete attrs.pendingPellets;save();return say('O pedido anterior de pellets expirou. Diga novamente o pedido completo.');}
  const call=async action=>{const s=input.requestEnvelope.context?.System;return requestEVA([],s?.user?.userId,s?.user?.accessToken,s?.device?.deviceId,false,null,action);};
  if(n==='AMAZON.NoIntent'){delete attrs.pendingPellets;save();return say('Pedido de pellets cancelado.');}
  if(n==='AMAZON.FallbackIntent')return say(p.phase==='patio'?'Indique o pátio, por exemplo: no Pátio Dr. Pedro.':p.phase==='quantity'?'Quantos sacos de pellets?':'Confirma o registo de pellets? Diga sim ou não.');
  if(['AMAZON.YesIntent','EVABookingConfirmOnlyIntent'].includes(n)){
   if(!p||p.phase!=='confirm')return say('Indique primeiro os dados que faltam para registar os pellets.');
   // Repetir a mesma confirmação após uma falha permite recuperar sem duplicar a baixa.
   p.submitted=true;save();
   try{const r=await call({action:'complete',confirmation:p.confirmation});
    if(r.code){if(['PELLETS_EXPIRED','PELLETS_CHANGED'].includes(r.code)){delete attrs.pendingPellets;save();}return say(PELLET_NOTICES[r.code]||TASK_NOTICES[r.code]||TASK_NOTICES.PATIO_UNAVAILABLE);}
    if(r.status!=='recorded')throw Error('pellet-result');
    delete attrs.pendingPellets;save();return say('Registei '+r.bags+' sacos de pellets, '+r.kg+' quilos, para '+r.horse+', na boxe '+r.box+', '+r.patio+'.');
   }catch(e){return taskFailure(input,e);}
  }
  if(n==='EVAPelletsBoxIntent')p={box:Alexa.getSlotValue(input.requestEnvelope,'boxe'),patio:resolvedPatio(input),bags:Alexa.getSlotValue(input.requestEnvelope,'sacos'),expires:Date.now()+180000};
  else {
   if(!p||p.expires<Date.now()||!['patio','quantity'].includes(p.phase)){delete attrs.pendingPellets;save();return say('Repita o pedido completo de pellets, com a boxe e a quantidade.');}
   if(n==='EVAPelletsPatioIntent')p.patio=resolvedPatio(input);
   if(n==='EVAPelletsQuantityIntent')p.bags=Alexa.getSlotValue(input.requestEnvelope,'sacos');
  }
  attrs.pendingPellets=p;save();
  if(p.bags==null||p.bags===''){p.phase='quantity';save();return say('Quantos sacos de pellets para a boxe '+p.box+'?');}
  const bags=Number(p.bags),box=String(p.box||'');
  if(bags===0){delete attrs.pendingPellets;save();return say('Está bem. Não registei nenhum saco de pellets.');}
  if(!Number.isInteger(bags)||bags<1||bags>30||!/^\d{1,5}$/.test(box))return say(PELLET_NOTICES.PELLETS_INVALID);
  try{
   const r=await call({action:'prepare',box,patio:p.patio,bags});
   if(r.code){if(r.code==='PELLETS_AMBIGUOUS'){p.phase='patio';save();}else{delete attrs.pendingPellets;save();}return say(PELLET_NOTICES[r.code]||TASK_NOTICES[r.code]||TASK_NOTICES.PATIO_UNAVAILABLE);}
   if(!r.confirmation||!Number.isFinite(Date.parse(r.expiresAt)))throw Error('pellet-prepare');
   attrs.pendingPellets={phase:'confirm',confirmation:r.confirmation,expires:Date.parse(r.expiresAt)};save();
   return say('Confirma '+bags+' sacos de pellets de quinze quilos para '+r.horse+', na boxe '+r.box+', '+r.patio+'?');
  }catch(e){delete attrs.pendingPellets;save();return taskFailure(input,e);}
 }
};


async function operationalRead(input,question){
 const attrs=taskAttrs(input);delete attrs.pendingTask;delete attrs.pendingPellets;delete attrs.pendingHorse;delete attrs.taskPage;
 input.attributesManager.setSessionAttributes(attrs);
 const s=input.requestEnvelope.context?.System;
 try{
  const result=await requestEVA([{role:'user',text:question}],s?.user?.userId,s?.user?.accessToken,s?.device?.deviceId);
  if(result.source!=='patio-live')return reply(input,'Não consegui consultar os dados atuais do pátio nesta tentativa.');
  return reply(input,result.answer);
 }catch(error){
  if(error.code==='PATIO_LINK_REQUIRED')input.responseBuilder.withLinkAccountCard();
  const notices={EVA_RATE_LIMIT:TASK_NOTICES.EVA_RATE_LIMIT,PATIO_LINK_REQUIRED:'Associe a conta individual do pátio na aplicação Alexa.',PATIO_DEVICE_REQUIRED:'Este aparelho ainda não está autorizado para consultar o pátio.',PATIO_FORBIDDEN:'A conta não tem acesso a esta consulta, ou a sessão terminou.',PATIO_NOT_CONFIGURED:'As consultas de cavalos não estão ativadas na configuração da EVA.'};
  return reply(input,notices[error.code]||'Não consegui consultar o pátio nesta tentativa. Repita dentro de instantes.');
 }
}
const DirectReadHandler={
 canHandle(input){return Alexa.getRequestType(input.requestEnvelope)==='IntentRequest'&&['EVAHorseSearchIntent','EVABoxLocationIntent'].includes(Alexa.getIntentName(input.requestEnvelope));},
 async handle(input){
  if(Alexa.getIntentName(input.requestEnvelope)==='EVABoxLocationIntent'){
   const box=Alexa.getSlotValue(input.requestEnvelope,'boxe');
   if(!/^\d{1,5}$/.test(String(box||'')))return reply(input,'Qual é o número da boxe?');
   const patio=resolvedPatio(input);
   return operationalRead(input,'Quem está na boxe '+box+(patio?' do '+patio:''));
  }
  const value=Alexa.getSlotValue(input.requestEnvelope,'pergunta');
  if(typeof value!=='string'||!value.trim())return reply(input,'Qual é o nome do cavalo?');
  return operationalRead(input,'Localiza '+value.trim().slice(0,160));
 }
};
const RestartHandler={
 canHandle(input){return Alexa.getRequestType(input.requestEnvelope)==='IntentRequest'&&Alexa.getIntentName(input.requestEnvelope)==='EVARestartIntent';},
 handle(input){
  const old=taskAttrs(input);const uncertain=!!old.pendingPellets?.submitted||!!old.pendingTask?.employee;
  input.attributesManager.setSessionAttributes({horseCatalog:Array.isArray(old.horseCatalog)?old.horseCatalog:[],history:[]});
  return reply(input,(uncertain?'Houve uma tentativa de gravação. Consulte a aplicação antes de repetir essa operação. ':'')+'Vamos começar um novo pedido. Em que posso ajudar?');
 }
};

const GreetingHandler={
  canHandle(input){return Alexa.getRequestType(input.requestEnvelope)==='IntentRequest' && Alexa.getIntentName(input.requestEnvelope)==='HelloWorldIntent';},
  handle(input){const attrs=taskAttrs(input);delete attrs.pendingTask;delete attrs.pendingPellets;delete attrs.taskPage;input.attributesManager.setSessionAttributes(attrs);return reply(input,'Estou a ouvir. Em que posso ajudar?');}
};
const EVAChatHandler={
  canHandle(input){return Alexa.getRequestType(input.requestEnvelope)==='IntentRequest'&&(Alexa.getIntentName(input.requestEnvelope)==='EVAChatIntent' || Object.prototype.hasOwnProperty.call(QUESTION_PREFIXES,Alexa.getIntentName(input.requestEnvelope)));},
  async handle(input){
    const currentAttrs=input.attributesManager.getSessionAttributes();
    delete currentAttrs.pendingHorse;
    delete currentAttrs.pendingPellets;
    delete currentAttrs.pendingTask;
    input.attributesManager.setSessionAttributes(currentAttrs);
    console.info('EVA_ROUTE',JSON.stringify({route:'general',intent:Alexa.getIntentName(input.requestEnvelope),hasQuestion:!!questionText(input),catalogCount:(currentAttrs.horseCatalog||[]).length}));
    const slot=questionText(input);
    if(!slot || !slot.trim()){
      console.info('EVA_INPUT_EMPTY',JSON.stringify({intent:Alexa.getIntentName(input.requestEnvelope)}));
      return reply(input,'Não recebi uma pergunta completa. Para procurar um cavalo, diga, por exemplo: localiza, seguido do nome.');
    }
    const attrs=input.attributesManager.getSessionAttributes();
    const previous=Array.isArray(attrs.history)?attrs.history:[];
    const messages=[...previous,{role:'user',text:slot.trim()}].slice(-MAX_HISTORY);
    try{
      const userId=input.requestEnvelope.context && input.requestEnvelope.context.System && input.requestEnvelope.context.System.user && input.requestEnvelope.context.System.user.userId;
      const result=await requestEVA(messages,userId,input.requestEnvelope.context?.System?.user?.accessToken,input.requestEnvelope.context?.System?.device?.deviceId);
      const answer=result.answer;
      // As respostas operacionais ficam fora do histórico enviado ao Gemini.
      if(result.source!=='patio-live')attrs.history=[...messages,{role:'model',text:answer.slice(0,1700)}].slice(-MAX_HISTORY);
      input.attributesManager.setSessionAttributes(attrs);
      return reply(input,answer.length>2200?answer.slice(0,2200)+' Quer que continue?':answer);
    }catch(err){
      console.error('EVA request failed:',err.message,err.code||'');
      if(err.code==='PATIO_LINK_REQUIRED')input.responseBuilder.withLinkAccountCard();
      if(err.code==='PATIO_DEVICE_REQUIRED' && err.deviceCode)input.responseBuilder.withSimpleCard('Autorizar dispositivo EVA','Código do dispositivo para autorizar consultas do pátio:\n'+err.deviceCode+'\nEste código identifica o dispositivo; não é uma palavra-passe.');
      const notices={
        EVA_RATE_LIMIT:'Foi atingido um limite temporário de pedidos. Aguarde um minuto e repita.',
        PATIO_DEVICE_REQUIRED:'A conta está associada, mas este dispositivo ainda precisa de autorização para consultar o pátio. Enviei o código num cartão da aplicação Alexa.',
        PATIO_LINK_REQUIRED:'Para consultar o pátio, associe a sua conta individual na aplicação Alexa. Enviei um cartão de ligação de conta.',
        PATIO_FORBIDDEN:'A sua conta não tem permissão para esta consulta, ou a sessão terminou.',
        PATIO_UNAVAILABLE:'Não consegui consultar o pátio nesta tentativa. Tente novamente.',
        PATIO_NOT_CONFIGURED:'A consulta do pátio pela Alexa aguarda a associação segura da conta.',
        PATIO_READ_ONLY:'Nesta fase, posso apenas consultar o pátio. Não efetuei nenhuma alteração.',
        PATIO_UNSUPPORTED:'Essa consulta ainda não está ligada. Estão preparadas consultas de cavalos, boxes, tarefas pendentes e aparelhagem de hoje.',

        AI_DEADLINE:'O serviço de inteligência artificial demorou demasiado. Tente novamente.',
        AI_TIMEOUT:'O serviço de inteligência artificial demorou demasiado. Tente novamente.',
        AI_RATE_LIMIT:'O limite temporário de utilização da inteligência artificial foi atingido. Tente mais tarde.',
        AI_MODEL_NOT_FOUND:'O modelo de inteligência artificial configurado não está disponível. É necessário verificar a configuração.',
        AI_AUTH:'A credencial do serviço de inteligência artificial foi recusada. É necessário verificar a configuração.',
        AI_PERMISSION:'O serviço de inteligência artificial recusou o acesso. É necessário verificar a configuração.',
        AI_REQUEST_INVALID:'O serviço de inteligência artificial recusou o formato do pedido. Código de diagnóstico: pedido inválido.',
        AI_BLOCKED:'O serviço de inteligência artificial não autorizou uma resposta a este pedido. Pode reformular?',
        AI_OUTPUT_LIMIT:'O serviço de inteligência artificial atingiu o limite de resposta sem devolver texto. Código de diagnóstico: limite de resposta.',
        AI_EMPTY:'O serviço de inteligência artificial devolveu uma resposta vazia. Código de diagnóstico: resposta vazia.',
        AI_UNAVAILABLE:'O serviço de inteligência artificial está temporariamente indisponível. Tente novamente mais tarde.',
        AI_NETWORK:'Falhou a ligação entre o serviço EVA e a inteligência artificial. Tente novamente.',
        AI_RESPONSE_INVALID:'A inteligência artificial devolveu um formato de resposta inesperado. Código de diagnóstico: formato de resposta.',
        MEMORY_UNAVAILABLE:'Não consegui aceder à memória nesta tentativa. Tente novamente.'
      };
      return reply(input,notices[err.code] || (err.message==='timeout'?'A resposta demorou demasiado para a Alexa. Tente novamente.':'Não consegui obter uma resposta da inteligência artificial. Tente novamente.'));
    }
  }
};
const HelpHandler={canHandle(input){return Alexa.getRequestType(input.requestEnvelope)==='IntentRequest'&&Alexa.getIntentName(input.requestEnvelope)==='AMAZON.HelpIntent';},handle(input){return reply(input,'Pode perguntar, por exemplo: lê todas as tarefas pendentes, ou regista dois sacos de pellets na boxe sete do Pátio cinquenta e sete.');}};
const StopHandler={canHandle(input){return Alexa.getRequestType(input.requestEnvelope)==='IntentRequest'&&['AMAZON.StopIntent','AMAZON.CancelIntent','AMAZON.NavigateHomeIntent'].includes(Alexa.getIntentName(input.requestEnvelope));},handle(input){input.responseBuilder.addDirective({type:'Dialog.UpdateDynamicEntities',updateBehavior:'CLEAR'});return reply(input,'Até já!',false);}};
const FallbackHandler={canHandle(input){return Alexa.getRequestType(input.requestEnvelope)==='IntentRequest';},handle(input){console.info('EVA_UNMATCHED',{intent:Alexa.getIntentName(input.requestEnvelope)});return reply(input,'Não consegui compreender o pedido. Pode dizer localiza, seguido do nome do cavalo, ou consultar pela box?');}};
const SessionEndedHandler={canHandle(input){return Alexa.getRequestType(input.requestEnvelope)==='SessionEndedRequest';},handle(input){return input.responseBuilder.getResponse();}};
const ErrorHandler={canHandle(){return true;},handle(input,err){console.error('Alexa error:',err.message);return reply(input,'Tive um problema a processar o pedido. Podes repetir?');}};
exports.handler=Alexa.SkillBuilders.custom()
 .addRequestHandlers(LaunchRequestHandler,RestartHandler,DirectReadHandler,PelletsHandler,TaskHandler,HorseLocationHandler,HorseConfirmationHandler,GreetingHandler,EVAChatHandler,HelpHandler,StopHandler,FallbackHandler,SessionEndedHandler)
 .addErrorHandlers(ErrorHandler)
 .lambda();