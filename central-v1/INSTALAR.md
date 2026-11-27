# EVA central 1.0.1 — teste separado

A página anterior `/teste-ia/`, os três ficheiros da Alexa 0.9.1, as funções SQL, as tabelas, as memórias anteriores e os anúncios Voice Monkey são preservados. Esta versão acrescenta `/eva/chat` para o PC e `/alexa/conversation` para o adaptador opcional. Os endpoints antigos mantêm-se disponíveis; passaram os 33 testes de regressão.

## Primeiro ativar a EVA no PC

1. Guardar uma cópia da versão ativa do Worker no Cloudflare antes de substituir.
2. Cloudflare → Workers & Pages → `eva-ia-equigest` → Edit code. Substituir o conteúdo completo de `worker.js` por `EVA_Worker_Central.mjs`; Save/Deploy. Não alterar variáveis nem segredos. Este ficheiro conserva os endpoints antigos e acrescenta os novos.
3. Abrir a nova página `/eva-equigest/patio/` no GitHub Pages. Entrar com a conta individual do Pátio 57. A password é enviada diretamente ao Supabase do pátio; não passa pela IA. O token da sessão fica apenas em memória da página.
4. Testar primeiro por escrito: `Localiza Lírio`, `Quem está na boxe sete do Pátio 57?`, `Lê todas as tarefas pendentes`, `Mais tarefas`.
5. Testar sem baixa: `Pellets na boxe sete`, depois `zero`. Deve cancelar sem movimento de stock. O zero também é aceite no pedido inicial e na confirmação; nunca anula um movimento que já esteja gravado.
6. Carregar em Falar e permitir o microfone. Testar as mesmas frases; verificar no ecrã o que foi ouvido. Voz e reprodução real precisam de teste no computador do utilizador.

A entrada web não usa o segredo da Alexa nem o código de acesso antigo da EVA. São necessárias as permissões já aplicadas pelas funções Supabase. A sessão expira e exige nova entrada; não é guardado refresh token no navegador.

## Depois ligar a Alexa à mesma EVA

A Alexa atual pode continuar a usar os endpoints antigos durante o teste do PC.

Quando a EVA direta tiver sido validada:

1. Guardar cópia do `lambda/index.js` atual na skill **EVA EquiGest**.
2. Substituir o conteúdo inteiro por `EVA_Alexa_Adaptador.cjs`, Save e Deploy.
3. Manter o modelo de voz 0.9.1 existente. Não alterar a skill antiga «O Meu Pátio».
4. A Alexa passa a enviar os comandos operacionais e as respostas curtas ao mesmo núcleo que o PC. As conversas gerais/memórias da Alexa continuam no percurso anterior para preservar essa funcionalidade. A Alexa continua responsável pelo reconhecimento da fala e seleção do intent; pedidos que ela não encaminha não chegam à EVA.

## Conversas suportadas

- Consultas atuais de cavalos por nome oficial, stable name e boxe/pátio.
- Tarefas e marcações por concluir, incluindo por confirmar, com continuação em blocos de cinco e atualização se a lista mudar.
- `Conclui a tarefa dois` → confirmação → nome do funcionário (António, Vinicius, Igor ou Tiago) → gravação na aplicação.
- `Confirma a marcação um` → confirmação → aceita a marcação e mantém-na pendente.
- `Regista dois sacos de pellets na boxe sete do Pátio 57` → confirmação → baixa real. Pellets por nome/stable name também consultam a lista atual; correspondências aproximadas não autorizam baixas.
- `Zero`/`0` cancela o pedido de pellets. Não produz uma baixa com quantidade zero nem repõe stock de um movimento anterior. Após falha de gravação incerta, verificar a aplicação antes de repetir.
- `Recomeçar` abandona o contexto pendente; não desfaz operações já gravadas.

## Limites desta entrega

As ferramentas de saúde/tratamentos, nutrição e consulta completa de stocks ainda não estão expostas ao núcleo central. A EVA explica a limitação em vez de inventar dados. A memória histórica existente da Alexa não é eliminada; a conversa web mantém contexto nesta sessão, sem unificação da memória histórica entre canais nesta entrega. O frontend não guarda password, token ou histórico de conversas no armazenamento persistente.

Não foram enviados anúncios nem feitas alterações reais a tarefas ou stocks nos testes. Não há alterações SQL nesta versão.

## Testes e recuperação

- 36 cenários do núcleo central, com autenticação/HTTP simulados.
- 33 testes de regressão da integração anterior, com serviços simulados.
- 6 encaminhamentos do adaptador Alexa e continuidade do contexto.
- Teste DOM da entrada, limpeza da password, envio de mensagens, continuidade assinada, ausência de tokens persistidos e saída. Não valida voz nem apresentação visual.
- Sintaxe do Worker, adaptador e script da interface validada.
- Não foi possível instalar o Chromium neste ambiente; voz e teste visual real continuam pendentes.

Para executar: `npm install`, depois `npm test` em `central-v1`. Os testes são apenas simulações. A pasta `backup` guarda os ficheiros anteriores 0.9.1 para reposição, sem alterar as variáveis. A página antiga continua no endereço anterior.

## Correção 1.0.1 — pellets e transcrição

A palavra ouvida «toallet» seguida de boxe provoca uma pergunta de esclarecimento; não inicia uma baixa sem o utilizador confirmar que pretendia pellets. «Pellets na boxe Lírio» pode identificar o cavalo pelo nome atual. «Regista dois sacos de cama na boxe sete do Pátio 57» é uma alternativa em português para preparar pellets, sujeita à mesma confirmação. O botão Registar pellets inicia um pedido sem assumir quantidade nem boxe.

A instrução antiga que dizia à IA não haver ligação operacional foi retirada apenas da conversa central autenticada. A conversa antiga permanece limitada às ferramentas que já possuía.

Para ativar esta correção: substituir o Worker completo por EVA_Worker_Central_1.0.1.txt e Deploy. Depois atualizar a página com Ctrl+F5 e voltar a entrar. Não é necessário alterar a Alexa nem o Supabase para este teste no PC. A transcrição da voz continua a depender do navegador; a correção pede esclarecimento no erro observado, não garante todas as pronúncias.
