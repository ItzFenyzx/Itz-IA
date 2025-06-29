// ==================================================================
//  Backend para Phoenix Chat v8 (Vercel Serverless Function)
//  Arquivo: /api/gemini.js
//
//  Implementa a arquitetura final com um sistema de ações para
//  separar a verificação de senha da lógica de chat.
// ==================================================================

const CONTEXT_BUDGET_CHARS = 4000;

// Função auxiliar para chamar a API do Gemini
async function callGemini(prompt, apiKey, model) {
  const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const payload = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
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
  if (data.candidates && data.candidates[0]?.content.parts[0]?.text) {
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

  // O corpo agora contém um campo 'action' para decidir o que fazer.
  const { action } = request.body;
  const correctPassword = process.env.PRO_MODE_PASSWORD;

  // --- ROTEADOR DE AÇÕES ---
  if (action === 'verifyPassword') {
    // Ação específica para verificar a senha.
    const { token } = request.body;
    if (!correctPassword) {
      return response.status(500).json({ success: false, error: 'Senha do Modo Pro não configurada no servidor.' });
    }
    if (token === correctPassword) {
      return response.status(200).json({ success: true });
    } else {
      return response.status(200).json({ success: false });
    }
  } 
  else if (action === 'chat') {
    // Ação padrão para processar uma pergunta do chat.
    try {
      const chatResponse = await handleChatRequest(request.body);
      return response.status(200).json(chatResponse);
    } catch (error) {
       // A função handleChatRequest já lida com os seus próprios erros, mas adicionamos um catch-all.
      return response.status(error.statusCode || 500).json({ error: error.message });
    }
  } 
  else {
    return response.status(400).json({ error: 'Ação desconhecida.' });
  }
}

// Função dedicada para lidar com a lógica do chat
async function handleChatRequest(body) {
  const { prompt: userQuery, isPro, proToken, isAutoMemory, memories } = body;

  if (!userQuery) {
    throw { statusCode: 400, message: 'Nenhum prompt foi fornecido.' };
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
    if (!correctPassword) {
      throw { statusCode: 500, message: 'Senha do Modo Pro não configurada no servidor.' };
    }
    if (proToken !== correctPassword) {
      throw { statusCode: 401, message: 'Senha do Modo Pro incorreta.' };
    }
    modelForFinalAnswer = proModel;
  } else {
    modelForFinalAnswer = fastModel;
  }

  // --- LÓGICA DE CONTEXTO (RAG) ---
  let contextPrompt = "";
  let usedContextTopics = [];
  if (memories && memories.length > 0) {
      const allTopics = [...new Set(memories.flatMap(m => m.topics))];
      if (allTopics.length > 0) {
          const topicRankPrompt = `Analise a pergunta e identifique os tópicos mais relevantes da lista. Responda APENAS com os tópicos, EM ORDEM, separados por vírgula.\nTópicos: ${allTopics.join(', ')}\n\nPergunta: "${userQuery}"`;
          const rankedTopicsResponse = await callGemini(topicRankPrompt, apiKey, fastModel);
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
  const persona = await callGemini(personaDefinitionPrompt, apiKey, fastModel);

  // --- MONTAGEM DO PROMPT FINAL ---
  const finalPrompt = `Assuma a persona de um(a) **${persona.trim()}**. ${contextPrompt}Responda à pergunta do usuário de forma completa, profunda e com o estilo apropriado para essa persona, usando Markdown para formatação (títulos, listas, etc.). Se o contexto fornecido não for relevante, ignore-o e responda de forma natural com base no seu conhecimento geral.\n\nPergunta do usuário: "${userQuery}"`;
  
  // --- GERAÇÃO DA RESPOSTA PRINCIPAL ---
  const finalAiResponse = await callGemini(finalPrompt, apiKey, modelForFinalAnswer);

  // --- LÓGICA DE MEMÓRIA AUTOMÁTICA ---
  let newMemory = null;
  if (isAutoMemory) {
      try {
          const autoMemoryPrompt = `Analise a pergunta do usuário e a resposta da IA. Extraia o fato ou a informação mais importante e autocontida. Refine-a em uma entrada de memória concisa. Sugira até 3 tópicos relevantes de uma palavra. Responda APENAS no formato JSON: {"text": "sua memória refinada aqui", "topics": ["topico1", "topico2"]}\n\nPERGUNTA: "${userQuery}"\n\nRESPOSTA: "${finalAiResponse}"`;
          const autoMemoryResponse = await callGemini(autoMemoryPrompt, apiKey, fastModel);
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
