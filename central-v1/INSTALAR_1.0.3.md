# EVA central 1.0.3 — sacos de cama por cavalo

Substituir os ficheiros completos; conservar cópia dos atuais antes da instalação.

1. Cloudflare → eva-ia-equigest → Edit code → worker.js: conteúdo completo de EVA_Worker_Central_1.0.3.txt → Deploy.
2. Amazon Developer → EVA EquiGest → Code → lambda/index.js: conteúdo completo de EVA_Alexa_Central_1.0.3.txt → Save → Deploy.
3. Amazon Developer → EVA EquiGest → Build → JSON Editor, Portuguese (Brazil): conteúdo completo de EVA_Modelo_Central_1.0.3.json → Save → Build skill; aguardar conclusão sem erros.
4. Dizer «Alexa, para» e depois «Alexa, abre assistente Eva» para iniciar uma sessão nova.

## Conversa

Utilizador: Regista sacos de cama na Quirona.
EVA: Quantos sacos?
Utilizador: Dois.
EVA: Confirma 2 sacos de cama para Quirona?
Utilizador: Sim.
EVA: Registei 2 sacos de cama para Quirona.

Nome oficial e Stable name são consultados na lista atual do pátio. Não se coloca uma lista fixa de cavalos neste modelo. Se o cavalo não for identificado de forma única, a EVA pede a boxe e o pátio. O reconhecimento da voz da Alexa continua dependente da transcrição e do intent selecionado por ela.

Zero/0 cancela sem dar baixa, incluindo depois da pergunta de quantidade. Uma baixa já gravada não é anulada dizendo zero. A confirmação e a resposta de sucesso deixam de dizer o peso; o cálculo de stock no servidor mantém-se.

O mesmo Worker atualiza o comportamento da EVA no PC. Não há alterações SQL nem ao Voice Monkey. As funções existentes continuam disponíveis.

## Validação

39 testes do núcleo, 7 encaminhamentos do adaptador e 33 testes de regressão aprovados com serviços simulados; nenhuma baixa real foi realizada. JSON validado, sem amostras duplicadas. Falta construir o modelo na Amazon e validar o percurso no Echo após instalar.
