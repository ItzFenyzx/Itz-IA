// ==================================================================
//  Backend para Chatbot com Memória (Vercel Serverless Function)
//  Arquivo: /api/gemini.js
//
//  Este código atua como um intermediário seguro. Ele recebe a
//  pergunta do seu site, busca a chave de API secreta nas
//  configurações da Vercel e então chama a API do Google.
// ==================================================================

// A Vercel exporta a função 'handler' como o ponto de entrada da API.
export default async function handler(request, response) {
  // Apenas permite requisições do tipo POST, que é o que nosso frontend envia.
  if (request.method !== 'POST') {
    return response.status(405).json({ error: 'Method Not Allowed' });
  }

  // Pega o 'prompt' que nosso frontend enviou no corpo da requisição.
  const { prompt } = request.body;

  if (!prompt) {
    return response.status(400).json({ error: 'Nenhum prompt foi fornecido.' });
  }

  // --- O PONTO CHAVE DA SEGURANÇA ---
  // Busca a chave de API das "Environment Variables" da Vercel.
  // Ela NUNCA fica exposta no código do frontend.
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    // Se a chave não foi configurada na Vercel, retorna um erro.
    return response.status(500).json({ error: 'Chave de API não configurada no servidor.' });
  }

  const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;

  const payload = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
  };

  try {
    // Faz a chamada para a API do Google a partir do servidor seguro da Vercel.
    const geminiResponse = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!geminiResponse.ok) {
      // Se a resposta do Google não for 'OK', repassa o erro.
      const errorData = await geminiResponse.text();
      throw new Error(`Erro na API do Gemini: ${errorData}`);
    }

    const data = await geminiResponse.json();

    // Envia a resposta do Gemini de volta para o seu site (frontend).
    response.status(200).json(data);

  } catch (error) {
    console.error(error); // Loga o erro no console da Vercel para depuração.
    response.status(500).json({ error: `Erro interno do servidor: ${error.message}` });
  }
}