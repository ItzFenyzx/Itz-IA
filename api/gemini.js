const CONTEXT_BUDGET_CHARS = 30000;
const MAX_MEMORY_CHARS = 5000;

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

        // Selecionar modelo
        const model = isPro ? 'gemini-1.5-pro-latest' : 'gemini-1.5-flash-latest';
        const baseUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

        // Construir contexto de memórias
        let memoryContext = '';
        let usedContext = [];
        
        if (memories && memories.length > 0) {
            const relevantMemories = selectRelevantMemories(memories, prompt);
            if (relevantMemories.length > 0) {
                memoryContext = formatMemoriesForContext(relevantMemories);
                usedContext = relevantMemories.map(mem => mem.topics ? mem.topics.join(', ') : 'Sem tópico');
            }
        }

        // Construir Mega Prompt
        const megaPrompt = buildMegaPrompt({
            prompt,
            memoryContext,
            useDynamicPersona,
            isPro
        });

        // Preparar payload para o Gemini
        const geminiPayload = {
            contents: [{
                parts: []
            }]
        };

        // Adicionar texto
        geminiPayload.contents[0].parts.push({
            text: megaPrompt
        });

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
            console.error('Erro da API Gemini:', errorData);
            
            if (response.status === 429) {
                return res.status(429).json({ 
                    error: 'Limite de requisições atingido. Tente novamente em alguns segundos.' 
                });
            }
            
            return res.status(500).json({ 
                error: `Erro da API Gemini: ${response.status} - ${errorData}` 
            });
        }

        const result = await response.json();
        
        if (!result.candidates || !result.candidates[0] || !result.candidates[0].content) {
            return res.status(500).json({ error: 'Resposta inválida da API Gemini' });
        }

        const fullResponse = result.candidates[0].content.parts[0].text;

        // Processar resposta para separar chat e canvas
        const { aiResponse, canvasContent } = processResponse(fullResponse);

        // Gerar memória automática se ativada
        let newMemory = null;
        if (isAutoMemory && aiResponse.trim()) {
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

function buildMegaPrompt({ prompt, memoryContext, useDynamicPersona, isPro }) {
    let megaPrompt = `### INSTRUÇÕES DE SISTEMA ###
Você é um assistente de IA avançado. Siga rigorosamente todas as regras abaixo numa única resposta.

1. **IDENTIDADE BASE (Sempre Presente):**
   - Você é o "Phoenix Chat".
   - Seu criador é Arthur Nascimento Nogueira.
   - Sua data de criação é ${new Date().toLocaleDateString('pt-BR')}.
   - Sua tecnologia é baseada no Gemini do Google, com os devidos créditos.
   - IMPORTANTE: Só mencione essas informações se for EXPLICITAMENTE perguntado sobre elas.

2. **MODO DE OPERAÇÃO:**`;

    if (useDynamicPersona) {
        megaPrompt += `
   - Analise a pergunta do usuário para definir a persona de especialista mais adequada para responder.
   - Adote essa persona para formular sua resposta de forma natural e direta.
   - NÃO se apresente como "Olá, sou um profissional..." - apenas responda no estilo da persona.`;
    } else {
        megaPrompt += `
   - Aja como um doutor em todos os aspectos do conhecimento, um polímata com acesso a toda a informação humana.
   - Forneça respostas detalhadas, estruturadas e profundas, demonstrando maestria no assunto.`;
    }

    if (memoryContext) {
        megaPrompt += `

3. **ANÁLISE DE CONTEXTO:**
   - Analise o contexto da Base de Memória abaixo.
   - Utilize estas informações para enriquecer sua resposta APENAS se forem diretamente relevantes.
   - Se não forem relevantes, ignore-as e responda com base no seu conhecimento geral.
   
   --- CONTEXTO ---
${memoryContext}
   --- FIM DO CONTEXTO ---`;
    }

    megaPrompt += `

4. **GERAÇÃO DE CANVAS (Instrução Permanente):**
   - Se sua resposta contiver código, scripts, documentos técnicos, ou conteúdo que seria melhor apresentado em formato de documento, estruture essa parte dentro das tags [CANVAS_BEGINS] e [CANVAS_ENDS].
   - O texto fora dessas tags deve servir como uma breve introdução ou resumo para o chat.
   - Se nenhum conteúdo for adequado para o Canvas, não utilize as tags.
   - Para códigos, inclua comentários explicativos e números de linha quando apropriado.

5. **FOCO E PRECISÃO:**
   - Concentre-se estritamente no que foi perguntado.
   - Evite informações adicionais não solicitadas.
   - Seja direto e objetivo na resposta.

6. **TAREFA FINAL:**
   - Com base em todas as regras acima, responda agora à pergunta do usuário.

### PERGUNTA DO USUÁRIO ###
${prompt}`;

    return megaPrompt;
}

function selectRelevantMemories(memories, prompt) {
    if (!memories || memories.length === 0) return [];
    
    const promptLower = prompt.toLowerCase();
    const relevantMemories = [];
    let totalChars = 0;
    
    // Ordenar por relevância (busca por palavras-chave nos tópicos e texto)
    const scoredMemories = memories.map(memory => {
        let score = 0;
        const memoryText = memory.text.toLowerCase();
        const memoryTopics = (memory.topics || []).join(' ').toLowerCase();
        
        // Pontuação por palavras-chave nos tópicos
        const promptWords = promptLower.split(/\s+/);
        promptWords.forEach(word => {
            if (word.length > 3) {
                if (memoryTopics.includes(word)) score += 3;
                if (memoryText.includes(word)) score += 1;
            }
        });
        
        return { memory, score };
    }).filter(item => item.score > 0)
      .sort((a, b) => b.score - a.score);
    
    // Selecionar memórias até o limite de caracteres
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
        const topics = memory.topics ? memory.topics.join(', ') : 'Geral';
        return `[${topics}]: ${memory.text}`;
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
        const memoryPrompt = `Analise a seguinte conversa e gere um resumo estruturado para memória:

PERGUNTA: ${userPrompt}
RESPOSTA: ${aiResponse}

Gere um objeto JSON com:
- "text": resumo conciso do assunto principal (máximo 200 caracteres)
- "topics": array com 1-3 palavras-chave relevantes (em minúsculas)

Exemplo: {"text": "Usuário perguntou sobre X e foi explicado Y", "topics": ["palavra1", "palavra2"]}

Responda APENAS com o JSON válido:`;

        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${apiKey}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{
                    parts: [{ text: memoryPrompt }]
                }]
            })
        });

        if (!response.ok) {
            throw new Error('Falha ao gerar memória automática');
        }

        const result = await response.json();
        const memoryText = result.candidates[0].content.parts[0].text.trim();
        
        // Tentar extrair JSON da resposta
        const jsonMatch = memoryText.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            const memoryData = JSON.parse(jsonMatch[0]);
            return {
                id: `mem-auto-${Date.now()}`,
                text: memoryData.text,
                topics: memoryData.topics || ['geral']
            };
        }
        
        throw new Error('Formato de memória inválido');
        
    } catch (error) {
        console.error('Erro ao gerar memória automática:', error);
        return null;
    }
}

