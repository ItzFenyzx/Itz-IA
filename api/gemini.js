// Constantes de configuração
const MAX_CONTEXT_TOKENS = 4000;
const MAX_MEMORY_GROUPS = 5;

// Função para estimar tokens (aproximadamente 4 caracteres por token)
function estimateTokens(text) {
    return Math.ceil(text.length / 4);
}

// Função para calcular e salvar tokens de memórias
function calculateMemoryTokens(memories) {
    return memories.map(memory => ({
        ...memory,
        tokenCount: memory.tokenCount || estimateTokens(memory.text),
        lastAccessed: memory.lastAccessed || Date.now()
    }));
}

// Função para selecionar memórias relevantes com gestão inteligente de tokens
function selectRelevantMemories(memories, prompt) {
    if (!memories || memories.length === 0) return [];
    
    const promptLower = prompt.toLowerCase();
    const promptWords = promptLower.split(/\s+/).filter(word => word.length > 3);
    
    // Calcular relevância de cada memória
    const scoredMemories = memories.map(memory => {
        let relevanceScore = 0;
        const memoryText = memory.text.toLowerCase();
        const memoryTopics = (memory.topics || []).join(" ").toLowerCase();
        
        // Pontuação por palavras-chave
        promptWords.forEach(word => {
            if (memoryTopics.includes(word)) relevanceScore += 3;
            if (memoryText.includes(word)) relevanceScore += 1;
        });
        
        // Bonus por acesso recente
        const daysSinceAccess = (Date.now() - (memory.lastAccessed || 0)) / (1000 * 60 * 60 * 24);
        if (daysSinceAccess < 7) relevanceScore += 1;
        
        return {
            memory: {
                ...memory,
                tokenCount: memory.tokenCount || estimateTokens(memory.text)
            },
            relevanceScore
        };
    }).filter(item => item.relevanceScore > 0)
      .sort((a, b) => b.relevanceScore - a.relevanceScore);
    
    // Agrupar por tópicos
    const groupedByTopic = {};
    scoredMemories.forEach(item => {
        (item.memory.topics || ["geral"]).forEach(topic => {
            if (!groupedByTopic[topic]) {
                groupedByTopic[topic] = [];
            }
            groupedByTopic[topic].push(item);
        });
    });
    
    // Selecionar os melhores grupos
    const selectedGroups = Object.entries(groupedByTopic)
        .map(([topic, items]) => ({
            topic,
            items: items.sort((a, b) => b.relevanceScore - a.relevanceScore),
            totalRelevance: items.reduce((sum, item) => sum + item.relevanceScore, 0)
        }))
        .sort((a, b) => b.totalRelevance - a.totalRelevance)
        .slice(0, MAX_MEMORY_GROUPS);
    
    // Selecionar memórias respeitando limite de tokens
    const selectedMemories = [];
    let totalTokens = 0;
    
    for (const group of selectedGroups) {
        for (const item of group.items) {
            const memoryTokens = item.memory.tokenCount;
            if (totalTokens + memoryTokens <= MAX_CONTEXT_TOKENS) {
                selectedMemories.push(item.memory);
                totalTokens += memoryTokens;
            } else {
                // Truncar se ainda há espaço
                const remainingTokens = MAX_CONTEXT_TOKENS - totalTokens;
                if (remainingTokens > 50) {
                    const truncatedText = item.memory.text.substring(0, remainingTokens * 4);
                    selectedMemories.push({
                        ...item.memory,
                        text: truncatedText + "...",
                        tokenCount: remainingTokens
                    });
                    totalTokens = MAX_CONTEXT_TOKENS;
                }
                break;
            }
        }
        if (totalTokens >= MAX_CONTEXT_TOKENS) break;
    }
    
    return selectedMemories;
}

// Função para formatar memórias para contexto
function formatMemoriesForContext(memories) {
    if (!memories || memories.length === 0) return "";
    
    const groupedByTopic = memories.reduce((acc, memory) => {
        (memory.topics || ["geral"]).forEach(topic => {
            if (!acc[topic]) acc[topic] = [];
            acc[topic].push(memory);
        });
        return acc;
    }, {});
    
    return Object.entries(groupedByTopic)
        .map(([topic, mems]) => {
            const topicMemories = mems.map(mem => `- ${mem.text}`).join("\n");
            return `**${topic.toUpperCase()}:**\n${topicMemories}`;
        })
        .join("\n\n");
}

// Função para construir o Mega Prompt detalhado
function buildDetailedMegaPrompt({ prompt, memoryContext, useDynamicPersona, isPro }) {
    const currentDate = new Date().toLocaleDateString("pt-BR");
    
    let megaPrompt = `## INSTRUÇÕES DE SISTEMA ###
Você é um assistente de IA avançado. Siga rigorosamente todas as regras abaixo numa única resposta.

1. **IDENTIDADE BASE (Sempre Presente):**
   - Você é o "Phoenix Chat".
   - Seu criador é Arthur Nascimento Nogueira.
   - Sua data de criação é ${currentDate}.
   - Sua tecnologia é baseada no Gemini do Google, com os devidos créditos.
   - IMPORTANTE: Só mencione essas informações se perguntado EXPLICITAMENTE sobre sua identidade.

2. **MODO DE OPERAÇÃO (Condicional):**`;

    if (useDynamicPersona) {
        megaPrompt += `
   - **Modo Especialista DESATIVADO:** Primeiro, analise a pergunta do utilizador para definir a persona de especialista mais adequada para responder (ex: "Historiador Militar", "Físico Teórico"). Depois, adote essa persona para formular a sua resposta SEM se apresentar formalmente.`;
    } else {
        megaPrompt += `
   - **Modo Especialista ATIVO:** Aja como um doutor em todos os aspetos do conhecimento, um polímata com acesso a toda a informação humana. Forneça respostas detalhadas, estruturadas e profundas, demonstrando maestria no assunto.`;
    }

    if (memoryContext) {
        megaPrompt += `

3. **ANÁLISE DE CONTEXTO (Condicional):**
   - **Memórias fornecidas:** Analise o contexto da Base de Memória abaixo. Utilize estas informações para enriquecer a sua resposta APENAS se forem diretamente relevantes para a pergunta do utilizador. Se não forem relevantes, ignore-as e responda com base no seu conhecimento geral para manter a naturalidade.
   
   --- CONTEXTO ---
${memoryContext}
   --- FIM DO CONTEXTO ---`;
    }

    megaPrompt += `

4. **GERAÇÃO DE CANVAS (Instrução Permanente):**
   - Se a sua resposta final for longa, técnica, contiver blocos de código ou for mais adequada para um formato de documento, estruture essa parte do conteúdo dentro das tags [CANVAS_BEGINS] e [CANVAS_ENDS]. O texto fora destas tags deve servir como uma breve introdução ou resumo para o chat. Se nenhum conteúdo for adequado para o Canvas, não utilize as tags.

5. **FOCO E PRECISÃO:**
   - Concentre-se estritamente no que foi perguntado.
   - Evite informações não solicitadas ou divagações desnecessárias.
   - Seja direto e objetivo, mas completo na resposta.

6. **TAREFA FINAL:**
   - Com base em todas as regras acima, responda agora à pergunta do utilizador, que será fornecida a seguir.

### PERGUNTA DO UTILIZADOR ###
${prompt}`;

    return megaPrompt;
}

// Função principal do handler
export default async function handler(req, res) {
    // Configurar CORS headers
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    
    if (req.method === "OPTIONS") {
        return res.status(200).end();
    }

    if (req.method !== "POST") {
        return res.status(405).json({ error: "Método não permitido" });
    }

    try {
        const { action, prompt, isPro, proToken, isAutoMemory, memories, image, useDynamicPersona } = req.body;

        // Verificar senha do Modo Pro se necessário
        if (action === "verifyPassword") {
            const correctPassword = process.env.PRO_MODE_PASSWORD;
            if (!correctPassword) {
                return res.status(500).json({ error: "Senha do Modo Pro não configurada no servidor" });
            }
            return res.status(200).json({ success: proToken === correctPassword });
        }

        if (action !== "chat") {
            return res.status(400).json({ error: "Ação não reconhecida" });
        }

        // Verificar API Key
        const apiKey = process.env.GEMINI_API_KEY;
        if (!apiKey) {
            return res.status(500).json({ error: "API Key do Gemini não configurada" });
        }

        // Verificar senha do Modo Pro se estiver ativo
        if (isPro) {
            const correctPassword = process.env.PRO_MODE_PASSWORD;
            if (!correctPassword || proToken !== correctPassword) {
                return res.status(401).json({ error: "Senha do Modo Pro incorreta" });
            }
        }

        // Selecionar modelo
        const model = isPro ? "gemini-1.5-pro-latest" : "gemini-1.5-flash-latest";
        const baseUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

        // Processar memórias com gestão inteligente de tokens
        let memoryContext = "";
        let usedContextTopics = [];
        
        if (memories && memories.length > 0) {
            const memoriesWithTokens = calculateMemoryTokens(memories);
            const relevantMemories = selectRelevantMemories(memoriesWithTokens, prompt);
            
            if (relevantMemories.length > 0) {
                memoryContext = formatMemoriesForContext(relevantMemories);
                usedContextTopics = [...new Set(relevantMemories.flatMap(mem => mem.topics || ["geral"]))];
            }
        }

        // Construir Mega Prompt detalhado
        const megaPrompt = buildDetailedMegaPrompt({
            prompt,
            memoryContext,
            useDynamicPersona,
            isPro
        });

        // Preparar payload para o Gemini
        const geminiPayload = {
            contents: [{
                parts: [{
                    text: megaPrompt
                }]
            }],
            generationConfig: {
                temperature: 0.7,
                topK: 40,
                topP: 0.95,
                maxOutputTokens: isPro ? 6144 : 3072,
            },
            safetySettings: [
                {
                    category: "HARM_CATEGORY_HARASSMENT",
                    threshold: "BLOCK_MEDIUM_AND_ABOVE"
                },
                {
                    category: "HARM_CATEGORY_HATE_SPEECH",
                    threshold: "BLOCK_MEDIUM_AND_ABOVE"
                },
                {
                    category: "HARM_CATEGORY_SEXUALLY_EXPLICIT",
                    threshold: "BLOCK_MEDIUM_AND_ABOVE"
                },
                {
                    category: "HARM_CATEGORY_DANGEROUS_CONTENT",
                    threshold: "BLOCK_MEDIUM_AND_ABOVE"
                }
            ]
        };

        // Adicionar imagem se fornecida
        if (image) {
            geminiPayload.contents[0].parts.push({
                inline_data: {
                    mime_type: image.mimeType,
                    data: image.data
                }
            });
        }

        // Fazer chamada à API do Gemini (sem streaming para simplificar)
        const response = await fetch(baseUrl, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify(geminiPayload)
        });

        if (!response.ok) {
            const errorData = await response.text();
            console.error("Erro da API Gemini:", response.status, errorData);
            
            if (response.status === 429) {
                return res.status(429).json({ 
                    error: "Muitas requisições. Aguarde alguns segundos e tente novamente." 
                });
            }
            
            if (response.status === 400) {
                return res.status(400).json({ 
                    error: "Requisição inválida. Verifique o conteúdo da mensagem." 
                });
            }
            
            return res.status(500).json({ 
                error: `Erro da API: ${response.status}` 
            });
        }

        const result = await response.json();
        let fullResponse = "";
        
        if (result.candidates && result.candidates[0] && result.candidates[0].content) {
            fullResponse = result.candidates[0].content.parts[0].text;
        } else {
            throw new Error("Resposta inválida da API Gemini");
        }

        let canvasContent = null;
        const canvasBeginTag = "[CANVAS_BEGINS]";
        const canvasEndTag = "[CANVAS_ENDS]";

        // Processar resposta final para separar chat e canvas
        let aiResponse = fullResponse;
        const beginIndex = fullResponse.indexOf(canvasBeginTag);
        const endIndex = fullResponse.indexOf(canvasEndTag);
        
        if (beginIndex !== -1 && endIndex !== -1 && endIndex > beginIndex) {
            aiResponse = fullResponse.substring(0, beginIndex).trim();
            canvasContent = fullResponse.substring(
                beginIndex + canvasBeginTag.length, 
                endIndex
            ).trim();
        }

        // Gerar memória automática se ativada
        let newMemory = null;
        if (isAutoMemory && aiResponse.trim()) {
            try {
                const memoryPrompt = `Analise esta conversa e crie um resumo estruturado em JSON:

PERGUNTA: ${prompt.substring(0, 300)}
RESPOSTA: ${aiResponse.substring(0, 500)}

Retorne APENAS um JSON no formato:
{"text": "resumo conciso da conversa em 1-2 frases", "topics": ["palavra-chave1", "palavra-chave2", "palavra-chave3"]}`;

                const memoryResponse = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${apiKey}`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        contents: [{
                            parts: [{ text: memoryPrompt }]
                        }],
                        generationConfig: {
                            temperature: 0.3,
                            maxOutputTokens: 200
                        }
                    })
                });

                if (memoryResponse.ok) {
                    const memoryResult = await memoryResponse.json();
                    const memoryText = memoryResult.candidates[0].content.parts[0].text.trim();
                    
                    const jsonMatch = memoryText.match(/\{[^}]+\}/);
                    if (jsonMatch) {
                        try {
                            const memoryData = JSON.parse(jsonMatch[0]);
                            newMemory = {
                                id: `mem-auto-${Date.now()}`,
                                text: memoryData.text || "Conversa resumida automaticamente",
                                topics: Array.isArray(memoryData.topics) ? memoryData.topics.slice(0, 3) : ["conversa"],
                                tokenCount: estimateTokens(memoryData.text || "Conversa resumida automaticamente"),
                                lastAccessed: Date.now()
                            };
                        } catch (parseError) {
                            console.error("Erro ao parsear JSON da memória:", parseError);
                        }
                    }
                }
            } catch (error) {
                console.error("Erro ao gerar memória automática:", error);
            }
        }

        // Retornar resposta completa
        return res.status(200).json({
            aiResponse,
            canvasContent,
            newMemory,
            usedContext: usedContextTopics
        });

    } catch (error) {
        console.error("Erro no handler:", error);
        return res.status(500).json({ error: "Erro interno do servidor: " + error.message });
    }
}
