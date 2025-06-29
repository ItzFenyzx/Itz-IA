const CONTEXT_BUDGET_CHARS = 3500;

const BASE_MEMORY_CONTEXT = `
Você é o "Phoenix Chat", uma IA de conversação avançada.
- Seu criador é Arthur Nascimento Nogueira.
- Você foi criado em 2025.
- Você é baseado na tecnologia Gemini do Google.
- O seu nome pode ser alterado pelo utilizador se ele desejar.

Responda sempre de forma útil, completa e direta. NÃO mencione informações sobre sua criação ou identidade a menos que seja especificamente perguntado sobre isso.
`;

const PROFESSIONAL_AREAS = {
    'programação': 'Desenvolvedor de Software Sênior especialista em múltiplas linguagens',
    'código': 'Desenvolvedor de Software Sênior especialista em múltiplas linguagens',
    'script': 'Desenvolvedor de Software Sênior especialista em múltiplas linguagens',
    'medicina': 'Médico especialista',
    'saúde': 'Profissional de Saúde',
    'direito': 'Advogado especialista',
    'educação': 'Educador especializado',
    'ensino': 'Educador especializado',
    'negócios': 'Consultor de Negócios',
    'marketing': 'Especialista em Marketing',
    'design': 'Designer Profissional',
    'arte': 'Artista e Designer',
    'música': 'Músico e Produtor Musical',
    'culinária': 'Chef Profissional',
    'fitness': 'Personal Trainer e Nutricionista',
    'psicologia': 'Psicólogo',
    'engenharia': 'Engenheiro especialista',
    'ciência': 'Cientista pesquisador',
    'matemática': 'Matemático especialista',
    'física': 'Físico especialista',
    'química': 'Químico especialista',
    'história': 'Historiador especialista',
    'geografia': 'Geógrafo especialista',
    'literatura': 'Crítico Literário e Escritor',
    'escrita': 'Escritor Profissional',
    'jornalismo': 'Jornalista especializado',
    'fotografia': 'Fotógrafo Profissional',
    'cinema': 'Crítico de Cinema e Cineasta',
    'games': 'Especialista em Jogos e Game Designer',
    'tecnologia': 'Especialista em Tecnologia',
    'minecraft': 'Especialista em Minecraft e Desenvolvimento de Mods'
};

function detectProfessionalArea(query) {
    const lowerQuery = query.toLowerCase();
    for (const [keyword, profession] of Object.entries(PROFESSIONAL_AREAS)) {
        if (lowerQuery.includes(keyword)) {
            return profession;
        }
    }
    return null;
}

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

export default async function handler(request, response) {
  if (request.method !== 'POST') {
    return response.status(405).json({ error: 'Method Not Allowed' });
  }

  const { action } = request.body;

  try {
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

async function handleChatRequest(body) {
  const { 
    prompt: userQuery, 
    isPro, 
    proToken, 
    autoMemoryGlobal, 
    autoMemoryChat, 
    globalMemories, 
    chatMemories, 
    image, 
    useDynamicPersona 
  } = body;

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

  const userPromptParts = [];
  if (userQuery) {
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

  // RAG - Contexto de memória (Global + Chat)
  let contextPrompt = "";
  let usedContextTopics = [];
  const allMemories = [...(globalMemories || []), ...(chatMemories || [])];
  
  if (allMemories && allMemories.length > 0) {
      const allTopics = [...new Set(allMemories.flatMap(m => m.topics))].filter(Boolean);
      if (allTopics.length > 0) {
          const topicRankPrompt = `Analise a pergunta do usuário e identifique quais dos seguintes tópicos são mais relevantes. Responda APENAS com os nomes dos tópicos, EM ORDEM DO MAIS PARA O MENOS RELEVANTE, separados por vírgula.\nTópicos disponíveis: ${allTopics.join(', ')}\n\nPergunta: "${userQuery}"`;
          
          try {
              const rankedTopicsResponse = await callGemini([{text: topicRankPrompt}], apiKey, fastModel);
              const rankedTopics = rankedTopicsResponse.split(',').map(t => t.trim().toLowerCase()).filter(t => allTopics.includes(t));
              
              if (rankedTopics.length > 0) {
                  usedContextTopics = rankedTopics;
                  let contextMemories = []; 
                  let currentChars = 0;
                  for (const topic of rankedTopics) {
                      const memoriesInTopic = allMemories.filter(mem => mem.topics.includes(topic));
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
          } catch (e) {
              console.error("Erro ao processar contexto de memória:", e);
          }
      }
  }

  // Persona dinâmica (apenas se ativada)
  let persona = "";
  if (useDynamicPersona && userQuery) {
      const detectedArea = detectProfessionalArea(userQuery);
      if (detectedArea) {
          persona = detectedArea;
      }
  }

  // Prompt final
  let finalSystemPrompt = BASE_MEMORY_CONTEXT;
  if (useDynamicPersona && persona.trim()) {
      finalSystemPrompt += `\nPara esta resposta, atue como um(a) **${persona.trim()}**. Responda de forma profissional e especializada, mas sem se apresentar ou mencionar sua persona.`;
  }
  finalSystemPrompt += `\n${contextPrompt}`;
  finalSystemPrompt += `\nResponda à pergunta do usuário de forma completa, focada e direta, usando Markdown para formatação quando apropriado. Seja conciso e vá direto ao ponto solicitado.`;
  if (contextPrompt) {
      finalSystemPrompt += `\nSe o contexto da memória não for relevante para a pergunta, ignore-o e responda de forma natural com base no seu conhecimento geral.`;
  }

  const finalPromptParts = [{ text: finalSystemPrompt }, ...userPromptParts];
  
  // Resposta principal
  const finalAiResponse = await callGemini(finalPromptParts, apiKey, modelForFinalAnswer);

  // Verificar se precisa gerar conteúdo para o Canvas
  let canvasContent = "";
  const canvasKeywords = ['script', 'código', 'arquivo', 'documento', 'exemplo', 'template', 'estrutura', 'esquema', 'diagrama', 'lista detalhada', 'tabela', 'função', 'class', 'def ', 'import ', 'package', 'html', 'css', 'javascript', 'python', 'java', 'c++', 'sql'];
  const hasCanvasContent = canvasKeywords.some(keyword => 
      userQuery?.toLowerCase().includes(keyword) || 
      finalAiResponse.toLowerCase().includes('```') ||
      finalAiResponse.includes('```') ||
      (finalAiResponse.match(/```/g) || []).length >= 2
  );

  if (hasCanvasContent) {
      const canvasPrompt = `Extraia APENAS informações secundárias úteis para o Canvas (como scripts completos, códigos, exemplos práticos, estruturas detalhadas, listas organizadas, etc.). Se não houver informações secundárias relevantes, responda apenas "VAZIO".\n\nPergunta: "${userQuery}"\nResposta: "${finalAiResponse}"`;
      try {
          canvasContent = await callGemini([{text: canvasPrompt}], apiKey, fastModel);
          if (canvasContent.trim().toUpperCase() === "VAZIO") {
              canvasContent = "";
          }
      } catch (e) {
          console.error("Erro ao gerar conteúdo do Canvas:", e);
          canvasContent = "";
      }
  }

  // Memória automática
  let newGlobalMemory = null;
  let newChatMemory = null;
  
  if (autoMemoryGlobal || autoMemoryChat) {
      try {
          const autoMemoryPrompt = `Analise a pergunta do usuário e a resposta da IA. Extraia o fato ou a informação mais importante e autocontida. Refine-a em uma entrada de memória concisa. Sugira até 3 tópicos relevantes de uma palavra. Responda APENAS no formato JSON: {"text": "sua memória refinada aqui", "topics": ["topico1", "topico2"]}\n\nPERGUNTA: "${userQuery || 'analise a imagem'}"\n\nRESPOSTA: "${finalAiResponse}"`;
          
          const autoMemoryResponse = await callGemini([{text: autoMemoryPrompt}], apiKey, fastModel);
          
          if(autoMemoryResponse.trim().startsWith('{')) {
              const parsedMemory = JSON.parse(autoMemoryResponse);
              if (parsedMemory.text && parsedMemory.topics) {
                  if (autoMemoryGlobal) {
                      newGlobalMemory = { 
                          id: `mem-global-${Date.now()}`, 
                          text: parsedMemory.text, 
                          topics: parsedMemory.topics 
                      };
                  }
                  if (autoMemoryChat) {
                      newChatMemory = { 
                          id: `mem-chat-${Date.now()}`, 
                          text: parsedMemory.text, 
                          topics: parsedMemory.topics 
                      };
                  }
              }
          }
      } catch (e) {
          console.error("Erro no processo de memória automática:", e);
      }
  }
  
  return {
      aiResponse: finalAiResponse,
      usedContext: usedContextTopics,
      newGlobalMemory: newGlobalMemory,
      newChatMemory: newChatMemory,
      canvasContent: canvasContent
  };
}
