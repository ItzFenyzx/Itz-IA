// ==================================================================
//  Backend para Phoenix Chat - Versão Final
//  Arquivo: /api/gemini.js
//
//  Implementa a arquitetura final com:
//  - Roteador de Ações (Verificação de Senha vs. Chat)
//  - Gestão de Anexo de Imagem (multimodal)
//  - Memórias Base (Identidade da IA)
//  - Correção de bug do Modo Pro
//  - Lógica de Persona, RAG, e Memória Automática
// ==================================================================

const CONTEXT_BUDGET_CHARS = 3500; // Orçamento de caracteres para o contexto de memória
const CREATION_DATE = new Date().toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' });

// --- MEMÓRIAS BASE DA IA ---
// Este contexto é sempre adicionado para dar identidade à IA.
const BASE_MEMORY_CONTEXT = `
Você é o "Phoenix Chat", uma IA de conversação avançada.
- Seu criador é Arthur Nascimento Nogueira.
- Você foi criado em ${CREATION_DATE}.
- Você é baseado na tecnologia Gemini do Google.
- O seu nome pode ser alterado pelo utilizador se ele desejar.
- Responda sempre de forma útil, completa e seguindo a persona de especialista solicitada.
`;

/**
 * Função auxiliar para fazer chamadas à API do Gemini.
 * @param {Array<Object>} parts - O array de 'parts' para o prompt (pode incluir texto e/ou imagem).
 * @param {string} apiKey - A chave da API.
 * @param {string} model - O nome do modelo a ser usado (ex: 'gemini-1.5-flash-latest').
 * @returns {Promise<string>} A resposta de texto da IA.
 */
async function callGemini(parts, apiKey, model) {
  const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  
  const payload = {
    contents: [{ role: 'user', parts: parts }],
    safetySettings: [
        { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
    ]
  };

  const geminiResponse = await fetch(apiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!geminiResponse.ok) {
    const errorText = await geminiResponse.text();
    console.error(`Erro na API do Gemini com o modelo ${model}: ${errorText}`);
    if(geminiResponse.status === 429) {
        throw { statusCode: 429, message: 'Limite de requisições da API atingido. Tente novamente em um minuto.' };
    }
    throw { statusCode: geminiResponse.status, message: `Erro na API do Gemini: ${errorText}` };
  }

  const data = await geminiResponse.json();
  
  // Tratamento de resposta para garantir que sempre retorne uma string
  if (data.candidates && data.candidates[0]?.content?.parts[0]?.text) {
    return data.candidates[0].content.parts[0].text;
  }
  if (data.promptFeedback?.blockReason) {
      console.warn("Resposta bloqueada por segurança:", data.promptFeedback.blockReason);
      return `(Minha resposta foi bloqueada por segurança: ${data.promptFeedback.blockReason})`;
  }
  
  console.warn("API retornou uma resposta vazia ou com formato inesperado:", data);
  return "(A IA retornou uma resposta vazia)";
}

/**
 * Função principal da Vercel que age como um "roteador" de ações.
 */
export default async function handler(request, response) {
  if (request.method !== 'POST') {
    return response.status(405).json({ error: 'Method Not Allowed' });
  }

  const { action } = request.body;

  try {
    // --- ROTEADOR DE AÇÕES ---
    if (action === 'verifyPassword') {
      const { token } = request.body;
      const correctPassword = process.env.PRO_MODE_PASSWORD;
      if (!correctPassword) {
        throw { statusCode: 500, message: 'Senha do Modo Pro não configurada no servidor.' };
      }
      return response.status(200).json({ success: token === correctPassword });

    } else if (action === 'chat') {
      const chatResponse = await handleChatRequest(request.body);
      return response.status(200).json(chatResponse);

    } else {
      throw { statusCode: 400, message: 'Ação desconhecida.' };
    }
  } catch (error) {
    console.error("Erro no handler principal:", error);
    return response.status(error.statusCode || 500).json({ error: error.message || 'Erro interno do servidor.' });
  }
}

/**
 * Função dedicada para lidar com a lógica de um pedido de chat.
 * @param {object} body - O corpo da requisição do frontend.
 * @returns {Promise<object>} A resposta completa para o frontend.
 */
async function handleChatRequest(body) {
  const { prompt: userQuery, isPro, proToken, isAutoMemory, memories, image } = body;

  if (!userQuery && !image) {
    throw { statusCode: 400, message: 'Nenhum prompt ou imagem foi fornecido.' };
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw { statusCode: 500, message: 'Chave de API não configurada no servidor.' };
  }

  const correctPassword = process.env.PRO_MODE_PASSWORD;
  let modelForFinalAnswer;
  const fastModel = 'gemini-1.5-flash-latest';
  const proModel = 'gemini-1.5-pro-latest';
  
  if (isPro) {
    if (!correctPassword) throw { statusCode: 500, message: 'Senha do Modo Pro não configurada no servidor.' };
    if (proToken !== correctPassword) throw { statusCode: 401, message: 'Senha do Modo Pro incorreta.' };
    modelForFinalAnswer = proModel;
  } else {
    modelForFinalAnswer = fastModel;
  }

  // --- MONTAGEM DAS 'PARTS' DO PROMPT (SUPORTE MULTIMODAL) ---
  // Esta parte transforma a pergunta do usuário e a imagem (se houver) num formato que a API entende.
  const userPromptParts = [];
  if (userQuery) {
      // Adicionamos um prefixo para separar claramente a pergunta do utilizador do nosso prompt de sistema
      userPromptParts.push({ text: `\n\nPERGUNTA DO UTILIZADOR:\n"${userQuery}"` });
  }
  if (image) {
      userPromptParts.push({
          inline_data: {
              mime_type: image.mimeType,
              data: image.data
          }
      });
  }

  // --- LÓGICA DE CONTEXTO (RAG) ---
  let contextPrompt = "";
  let usedContextTopics = [];
  if (memories && memories.length > 0) {
      const allTopics = [...new Set(memories.flatMap(m => m.topics))].filter(Boolean); // Garante que não há tópicos vazios
      if (allTopics.length > 0) {
          const topicRankPrompt = `Analise a pergunta do usuário e identifique quais dos seguintes tópicos são mais relevantes. Responda APENAS com os nomes dos tópicos, EM ORDEM DO MAIS PARA O MENOS RELEVANTE, separados por vírgula.\nTópicos disponíveis: ${allTopics.join(', ')}\n\nPergunta: "${userQuery}"`;
          // Usamos a função callGemini, passando o prompt como uma 'part' de texto.
          const rankedTopicsResponse = await callGemini([{text: topicRankPrompt}], apiKey, fastModel);
          const rankedTopics = rankedTopicsResponse.split(',').map(t => t.trim().toLowerCase()).filter(t => allTopics.includes(t));
          
          if (rankedTopics.length > 0) {
              usedContextTopics = rankedTopics;
              let contextMemories = []; 
              let currentChars = 0;
              for (const topic of rankedTopics) {
                  const memoriesInTopic = memories.filter(mem => mem.topics.includes(topic));
                  for (const memory of memoriesInTopic) {
                      if (currentChars + memory.text.length <= CONTEXT_BUDGET_CHARS) { 
                          contextMemories.push(memory.text); 
                          currentChars += memory.text.length; 
                      } else { break; }
                  }
                  if (currentChars >= CONTEXT_BUDGET_CHARS) break;
              }
              if (contextMemories.length > 0) {
                  const contextText = contextMemories.join("\n- ");
                  contextPrompt = `Use o seguinte contexto da base de memória se for relevante, mas não se limite a ele:\n--- CONTEXTO ---\n- ${contextText}\n--- FIM DO CONTEXTO ---\n\n`;
              }
          }
      }
  }

  // --- LÓGICA DE PERSONA DINÂMICA ---
  const personaDefinitionPrompt = `Analise a seguinte pergunta do usuário. Descreva a persona de especialista ideal para responder. Seja conciso e direto. Exemplos: "Doutor em Física Quântica", "Crítico de Cinema especializado em filmes noir", "Engenheiro de Software Sênior especialista em Python". Pergunta: "${userQuery || 'Analisar a imagem fornecida'}"`;
  const persona = await callGemini([{text: personaDefinitionPrompt}], apiKey, fastModel);
  // --- MONTAGEM DO PROMPT FINAL ---
  // Junta todas as peças: a identidade base, a persona dinâmica, o contexto da memória e a pergunta do utilizador.
  const finalSystemPrompt = `
    ${BASE_MEMORY_CONTEXT}
    Assuma a persona de um(a) **${persona.trim()}**. 
    ${contextPrompt}
    Responda à pergunta do usuário de forma completa, profunda e com o estilo apropriado para essa persona, usando Markdown para formatação (títulos, listas, etc.). 
    Se o contexto da memória não for relevante para a pergunta, ignore-o e responda de forma natural com base no seu conhecimento geral.
  `;

  // Adiciona o prompt do sistema no início do array de 'parts' que será enviado para a API
  const finalPromptParts = [{ text: finalSystemPrompt }, ...userPromptParts];
  
  // --- GERAÇÃO DA RESPOSTA PRINCIPAL ---
  // Chama a API do Gemini com o prompt final e o modelo correto (Pro ou Flash)
  const finalAiResponse = await callGemini(finalPromptParts, apiKey, modelForFinalAnswer);

  // --- LÓGICA DE MEMÓRIA AUTOMÁTICA (OPCIONAL) ---
  // Se o utilizador ativou esta opção no frontend, o sistema tenta criar uma memória automaticamente.
  let newMemory = null;
  if (isAutoMemory) {
      try {
          const autoMemoryPrompt = `Analise a pergunta do usuário e a resposta da IA. Extraia o fato ou a informação mais importante e autocontida. Refine-a em uma entrada de memória concisa. Sugira até 3 tópicos relevantes de uma palavra. Responda APENAS no formato JSON: {"text": "sua memória refinada aqui", "topics": ["topico1", "topico2"]}\n\nPERGUNTA: "${userQuery || 'analise a imagem'}"\n\nRESPOSTA: "${finalAiResponse}"`;
          
          // Usa o modelo rápido para esta tarefa, pois é mais eficiente.
          const autoMemoryResponse = await callGemini([{text: autoMemoryPrompt}], apiKey, fastModel);
          
          // Tenta converter a resposta de texto em um objeto JSON.
          if(autoMemoryResponse.trim().startsWith('{')) {
              const parsedMemory = JSON.parse(autoMemoryResponse);
              if (parsedMemory.text && parsedMemory.topics) {
                  newMemory = { 
                      id: `mem-${Date.now()}`, 
                      text: parsedMemory.text, 
                      topics: parsedMemory.topics 
                  };
              }
          }
      } catch (e) {
          // Se a memória automática falhar, o erro é registado no console do servidor, mas o chat continua a funcionar normalmente.
          console.error("Erro no processo de memória automática:", e);
      }
  }
  
  // --- ENVIO DA RESPOSTA FINAL PARA O FRONTEND ---
  // Retorna um objeto JSON contendo tudo o que o frontend precisa para atualizar a interface.
  return {
      aiResponse: finalAiResponse,
      usedContext: usedContextTopics,
      newMemory: newMemory
  };
}
