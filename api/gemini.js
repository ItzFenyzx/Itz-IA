// ==================================================================
//  Backend para Phoenix Chat - Versão Final
//  Arquivo: /api/gemini.js
//
//  Implementa a arquitetura final com:
//  - Gestão de múltiplos chats (implícito no frontend)
//  - Análise de Imagem (multimodal)
//  - Memórias Base (Identidade da IA)
//  - Correção de bug do Modo Pro
//  - Toda a lógica anterior (Persona, RAG, etc.)
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
- Seu nome pode ser alterado pelo usuário se ele desejar.
- Responda sempre de forma útil, completa e seguindo a persona de especialista solicitada.
`;

// Função auxiliar para chamar a API do Gemini
async function callGemini(parts, apiKey, model) {
  const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  
  // O payload agora aceita um array de 'parts' para suportar texto e imagem.
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
        throw new Error('Limite de requisições da API atingido. Tente novamente em um minuto.');
    }
    throw new Error(`Erro na API do Gemini.`);
  }

  const data = await geminiResponse.json();
  if (data.candidates && data.candidates[0]?.content?.parts[0]?.text) {
    return data.candidates[0].content.parts[0].text;
  }
  if (data.promptFeedback?.blockReason) {
      console.warn("Resposta bloqueada por segurança:", data.promptFeedback.blockReason);
      return `(Minha resposta foi bloqueada por segurança: ${data.promptFeedback.blockReason})`;
  }
  throw new Error("Resposta da API inválida ou vazia.");
}

// Função principal da Vercel que age como um "roteador"
export default async function handler(request, response) {
  if (request.method !== 'POST') {
    return response.status(405).json({ error: 'Method Not Allowed' });
  }

  const { action } = request.body;
  const correctPassword = process.env.PRO_MODE_PASSWORD;

  // Roteador de Ações
  if (action === 'verifyPassword') {
    const { token } = request.body;
    if (!correctPassword) {
      return response.status(500).json({ success: false, error: 'Senha do Modo Pro não configurada no servidor.' });
    }
    return response.status(200).json({ success: token === correctPassword });
  } 
  else if (action === 'chat') {
    try {
      const chatResponse = await handleChatRequest(request.body);
      return response.status(200).json(chatResponse);
    } catch (error) {
      return response.status(error.statusCode || 500).json({ error: error.message });
    }
  } 
  else {
    return response.status(400).json({ error: 'Ação desconhecida.' });
  }
}

// Função dedicada para lidar com a lógica do chat
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
  const promptParts = [];
  if (userQuery) {
      promptParts.push({ text: userQuery });
  }
  if (image) {
      // A imagem vem como uma string base64 do frontend
      promptParts.push({
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
      const allTopics = [...new Set(memories.flatMap(m => m.topics))];
      if (allTopics.length > 0) {
          const topicRankPrompt = `Analise a pergunta e identifique os tópicos mais relevantes da lista. Responda APENAS com os tópicos, EM ORDEM, separados por vírgula.\nTópicos: ${allTopics.join(', ')}\n\nPergunta: "${userQuery}"`;
          const rankedTopicsResponse = await callGemini([{text: topicRankPrompt}], apiKey, fastModel);
          const rankedTopics = rankedTopicsResponse.split(',').map(t => t.trim().toLowerCase()).filter(t => allTopics.includes(t));
          
          if (rankedTopics.length > 0) {
              usedContextTopics = rankedTopics;
              let contextMemories = []; let currentChars = 0;
              for (const topic of rankedTopics) {
                  const memoriesInTopic = memories.filter(mem => mem.topics.includes(topic));
                  for (const memory of memoriesInTopic) {
                      if (currentChars + memory.text.length <= CONTEXT_BUDGET_CHARS) { contextMemories.push(memory.text); currentChars += memory.text.length; } else { break; }
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
  const personaDefinitionPrompt = `Analise a seguinte pergunta do usuário. Descreva a persona de especialista ideal para responder. Seja conciso e direto. Exemplos: "Doutor em Física Quântica", "Crítico de Cinema especializado em filmes noir", "Engenheiro de Software Sênior especialista em Python". Pergunta: "${userQuery}"`;
  const persona = await callGemini([{text: personaDefinitionPrompt}], apiKey, fastModel);

  // --- MONTAGEM DO PROMPT FINAL ---
  const finalSystemPrompt = `
    ${BASE_MEMORY_CONTEXT}
    Assuma a persona de um(a) **${persona.trim()}**. 
    ${contextPrompt}
    Responda à pergunta do usuário de forma completa, profunda e com o estilo apropriado para essa persona, usando Markdown para formatação (títulos, listas, etc.). 
    Se o contexto da memória não for relevante para a pergunta, ignore-o e responda de forma natural com base no seu conhecimento geral.
    ---
    PERGUNTA DO USUÁRIO:
  `;

  // Adiciona o prompt do sistema no início do array de 'parts'
  const finalPromptParts = [{ text: finalSystemPrompt }, ...promptParts];
  
  // --- GERAÇÃO DA RESPOSTA PRINCIPAL ---
  const finalAiResponse = await callGemini(finalPromptParts, apiKey, modelForFinalAnswer);

  // --- LÓGICA DE MEMÓRIA AUTOMÁTICA ---
  let newMemory = null;
  if (isAutoMemory) {
      try {
          const autoMemoryPrompt = `Analise a pergunta do usuário e a resposta da IA. Extraia o fato ou a informação mais importante e autocontida. Refine-a em uma entrada de memória concisa. Sugira até 3 tópicos relevantes de uma palavra. Responda APENAS no formato JSON: {"text": "sua memória refinada aqui", "topics": ["topico1", "topico2"]}\n\nPERGUNTA: "${userQuery}"\n\nRESPOSTA: "${finalAiResponse}"`;
          const autoMemoryResponse = await callGemini([{text: autoMemoryPrompt}], apiKey, fastModel);
          if(autoMemoryResponse.trim().startsWith('{')) {
              const parsedMemory = JSON.parse(autoMemoryResponse);
              if (parsedMemory.text && parsedMemory.topics) {
                  newMemory = { id: `mem-${Date.now()}`, text: parsedMemory.text, topics: parsedMemory.topics };
              }
          }
      } catch (e) { console.error("Erro no processo de memória automática:", e); }
  }
  
  return {
      aiResponse: finalAiResponse,
      usedContext: usedContextTopics,
      newMemory: newMemory
  };
}
