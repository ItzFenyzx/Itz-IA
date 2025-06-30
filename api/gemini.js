const CONTEXT_BUDGET_CHARS = 25000;
const MAX_MEMORY_CHARS = 3000;

export default async function handler(req, res) {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Método não permitido' });
    }

    try {
        const { action, prompt, isPro, proToken, isAutoMemory, memories, image, useDynamicPersona } = req.body;

        // Verificar senha do Modo Pro se necessário
        if (action === 'verifyPassword') {
            const correctPassword = process.env.PRO_MODE_PASSWORD;
            if (!correctPassword) {
                return res.status(500).json({ error: 'Senha do Modo Pro não configurada no servidor' });
            }
            return res.status(200).json({ success: proToken === correctPassword });
        }

        if (action !== 'chat') {
            return res.status(400).json({ error: 'Ação não reconhecida' });
        }

        // Verificar API Key
        const apiKey = process.env.GEMINI_API_KEY;
        if (!apiKey) {
            return res.status(500).json({ error: 'API Key do Gemini não configurada' });
        }

        // Verificar senha do Modo Pro se estiver ativo
        if (isPro) {
            const correctPassword = process.env.PRO_MODE_PASSWORD;
            if (!correctPassword || proToken !== correctPassword) {
                return res.status(401).json({ error: 'Senha do Modo Pro incorreta' });
            }
        }

        // Selecionar modelo - SIMPLIFICADO
        const model = isPro ? 'gemini-1.5-pro-latest' : 'gemini-1.5-flash-latest';
        const baseUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

        // Construir contexto de memórias - OTIMIZADO
        let memoryContext = '';
        let usedContext = [];
        
        if (memories && memories.length > 0) {
            const relevantMemories = selectRelevantMemories(memories, prompt);
            if (relevantMemories.length > 0) {
                memoryContext = formatMemoriesForContext(relevantMemories);
                usedContext = relevantMemories.map(mem => mem.topics ? mem.topics.slice(0, 2).join(', ') : 'Geral');
            }
        }

        // Construir Mega Prompt SIMPLIFICADO
        const megaPrompt = buildSimplifiedMegaPrompt({
            prompt,
            memoryContext,
            useDynamicPersona,
            isPro
        });

        // Preparar payload para o Gemini - OTIMIZADO
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
                maxOutputTokens: isPro ? 8192 : 4096,
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

        // Fazer chamada única à API do Gemini
        const response = await fetch(baseUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(geminiPayload)
        });

        if (!response.ok) {
            const errorData = await response.text();
            console.error('Erro da API Gemini:', response.status, errorData);
            
            if (response.status === 429) {
                return res.status(429).json({ 
                    error: 'Muitas requisições. Aguarde alguns segundos e tente novamente.' 
                });
            }
            
            if (response.status === 400) {
                return res.status(400).json({ 
                    error: 'Requisição inválida. Verifique o conteúdo da mensagem.' 
                });
            }
            
            return res.status(500).json({ 
                error: `Erro da API: ${response.status}` 
            });
        }

        const result = await response.json();
        
        if (!result.candidates || !result.candidates[0] || !result.candidates[0].content) {
            console.error('Resposta inválida da API:', result);
            return res.status(500).json({ error: 'Resposta inválida da API Gemini' });
        }

        const fullResponse = result.candidates[0].content.parts[0].text;

        // Processar resposta para separar chat e canvas
        const { aiResponse, canvasContent } = processResponse(fullResponse);

        // Gerar memória automática se ativada - APENAS UMA CHAMADA ADICIONAL SE NECESSÁRIO
        let newMemory = null;
        if (isAutoMemory && aiResponse.trim() && aiResponse.length > 50) {
            try {
                newMemory = await generateAutoMemory(prompt, aiResponse, apiKey);
            } catch (error) {
                console.error('Erro ao gerar memória automática:', error);
                // Não falhar a requisição por causa da memória
            }
        }

        return res.status(200).json({
            aiResponse,
            canvasContent,
            newMemory,
            usedContext
        });

    } catch (error) {
        console.error('Erro no handler:', error);
        return res.status(500).json({ 
            error: 'Erro interno do servidor: ' + error.message 
        });
    }
}

function buildSimplifiedMegaPrompt({ prompt, memoryContext, useDynamicPersona, isPro }) {
    let megaPrompt = `Você é o Phoenix Chat, um assistente de IA avançado criado por Arthur Nascimento Nogueira.

INSTRUÇÕES:
1. Responda de forma direta e focada na pergunta do usuário.
2. Não mencione sua identidade ou criador a menos que seja perguntado explicitamente.`;

    if (useDynamicPersona) {
        megaPrompt += `
3. Analise a pergunta e adote a expertise mais adequada para responder (ex: programador, médico, professor).
4. Responda no estilo dessa expertise, mas sem se apresentar formalmente.`;
    } else {
        megaPrompt += `
3. Responda como um especialista polímata com conhecimento profundo em todas as áreas.`;
    }

    if (memoryContext) {
        megaPrompt += `

CONTEXTO RELEVANTE:
${memoryContext}

Use este contexto apenas se for diretamente relevante para a pergunta.`;
    }

    megaPrompt += `

CANVAS: Se sua resposta contiver código, scripts, documentos técnicos ou conteúdo longo que seria melhor em formato de documento, coloque essa parte entre [CANVAS_BEGINS] e [CANVAS_ENDS].

PERGUNTA: ${prompt}`;

    return megaPrompt;
}

function selectRelevantMemories(memories, prompt) {
    if (!memories || memories.length === 0) return [];
    
    const promptLower = prompt.toLowerCase();
    const relevantMemories = [];
    let totalChars = 0;
    
    // Ordenar por relevância simples
    const scoredMemories = memories.map(memory => {
        let score = 0;
        const memoryText = memory.text.toLowerCase();
        const memoryTopics = (memory.topics || []).join(' ').toLowerCase();
        
        // Pontuação básica por palavras-chave
        const promptWords = promptLower.split(/\s+/).filter(word => word.length > 3);
        promptWords.forEach(word => {
            if (memoryTopics.includes(word)) score += 2;
            if (memoryText.includes(word)) score += 1;
        });
        
        return { memory, score };
    }).filter(item => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5); // Máximo 5 memórias
    
    // Selecionar memórias até o limite
    for (const item of scoredMemories) {
        const memorySize = item.memory.text.length;
        if (totalChars + memorySize <= MAX_MEMORY_CHARS) {
            relevantMemories.push(item.memory);
            totalChars += memorySize;
        } else {
            break;
        }
    }
    
    return relevantMemories;
}

function formatMemoriesForContext(memories) {
    return memories.map(memory => {
        const topics = memory.topics ? memory.topics.slice(0, 2).join(', ') : 'Geral';
        return `[${topics}]: ${memory.text.substring(0, 300)}`;
    }).join('\n\n');
}

function processResponse(fullResponse) {
    const canvasBeginTag = '[CANVAS_BEGINS]';
    const canvasEndTag = '[CANVAS_ENDS]';
    
    const beginIndex = fullResponse.indexOf(canvasBeginTag);
    const endIndex = fullResponse.indexOf(canvasEndTag);
    
    if (beginIndex !== -1 && endIndex !== -1 && endIndex > beginIndex) {
        const aiResponse = fullResponse.substring(0, beginIndex).trim();
        const canvasContent = fullResponse.substring(
            beginIndex + canvasBeginTag.length, 
            endIndex
        ).trim();
        
        return { aiResponse, canvasContent };
    }
    
    return { aiResponse: fullResponse, canvasContent: null };
}

async function generateAutoMemory(userPrompt, aiResponse, apiKey) {
    try {
        // Prompt muito mais simples e direto
        const memoryPrompt = `Resuma esta conversa em JSON:
PERGUNTA: ${userPrompt.substring(0, 200)}
RESPOSTA: ${aiResponse.substring(0, 300)}

Formato: {"text": "resumo em 1 frase", "topics": ["palavra1", "palavra2"]}`;

        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${apiKey}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
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

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        const result = await response.json();
        const memoryText = result.candidates[0].content.parts[0].text.trim();
        
        // Extrair JSON
        const jsonMatch = memoryText.match(/\{[^}]+\}/);
        if (jsonMatch) {
            const memoryData = JSON.parse(jsonMatch[0]);
            return {
                id: `mem-auto-${Date.now()}`,
                text: memoryData.text || 'Conversa resumida',
                topics: Array.isArray(memoryData.topics) ? memoryData.topics.slice(0, 3) : ['geral']
            };
        }
        
        throw new Error('JSON não encontrado');
        
    } catch (error) {
        console.error('Erro ao gerar memória automática:', error);
        return null;
    }
}
