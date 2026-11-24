'use strict';

// Gerador público de PIX avulso via TriboPay.
// Não coleta nem envia nome, CPF, telefone ou e-mail do pagador.

const API_BASE = 'https://api.tribopay.com.br/api/public/v1';
const REQUEST_TIMEOUT_MS = 25000;
const MIN_AMOUNT_CENTS = Number(process.env.PIX_MANUAL_MIN_AMOUNT_CENTS || 500); // R$ 5,00
const MAX_AMOUNT_CENTS = Number(process.env.PIX_MANUAL_MAX_AMOUNT_CENTS || 1000000); // R$ 10.000,00

// Limitação básica por instância: reduz cliques repetidos e abuso simples.
// Para proteção forte em produção, recomenda-se acrescentar rate limiting na borda/WAF.
const requestsByIp = new Map();
const WINDOW_MS = 10 * 60 * 1000;
const MAX_REQUESTS_PER_WINDOW = 8;

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store, max-age=0',
      'Pragma': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    },
    body: body === '' ? '' : JSON.stringify(body)
  };
}

function readBody(event) {
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body || '', 'base64').toString('utf8')
    : (event.body || '{}');
  return JSON.parse(raw);
}

function cleanText(value, maxLength = 80) {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/[\u0000-\u001F\u007F]/g, '').slice(0, maxLength);
}

// Aceita 125,90 / 1.250,90 / 125.90 / 125.
// Converte para centavos sem arredondamento de ponto flutuante.
function parseAmountToCents(input) {
  let value = String(input ?? '').trim().replace(/^R\$\s*/i, '').replace(/\s/g, '');
  if (!value) return null;

  if (value.includes(',')) {
    if (!/^\d{1,3}(?:\.\d{3})*(?:,\d{1,2})?$/.test(value) && !/^\d+(?:,\d{1,2})?$/.test(value)) return null;
    value = value.replace(/\./g, '').replace(',', '.');
  } else if (value.includes('.')) {
    if (!/^\d+\.\d{1,2}$/.test(value)) return null;
  } else if (!/^\d+$/.test(value)) {
    return null;
  }

  const [wholeText, decimalText = ''] = value.split('.');
  if (!wholeText || !/^\d+$/.test(wholeText) || !/^\d{0,2}$/.test(decimalText)) return null;
  const cents = Number(wholeText) * 100 + Number((decimalText + '00').slice(0, 2));
  return Number.isSafeInteger(cents) && cents > 0 ? cents : null;
}

function clientIp(event) {
  const headers = event.headers || {};
  const direct = headers['x-nf-client-connection-ip'] || headers['client-ip'] || '';
  if (direct) return String(direct).trim().slice(0, 80);
  const forwarded = headers['x-forwarded-for'] || '';
  return String(forwarded).split(',')[0].trim().slice(0, 80) || 'unknown';
}

function allowRequest(event) {
  const ip = clientIp(event);
  const now = Date.now();
  const recent = (requestsByIp.get(ip) || []).filter(timestamp => now - timestamp < WINDOW_MS);
  if (recent.length >= MAX_REQUESTS_PER_WINDOW) {
    requestsByIp.set(ip, recent);
    return false;
  }
  recent.push(now);
  requestsByIp.set(ip, recent);
  if (requestsByIp.size > 2000) {
    for (const [key, timestamps] of requestsByIp.entries()) {
      if (!timestamps.some(timestamp => now - timestamp < WINDOW_MS)) requestsByIp.delete(key);
    }
  }
  return true;
}

function makeApiUrl(path, apiToken) {
  const url = new URL(`${API_BASE}${path}`);
  url.searchParams.set('api_token', apiToken);
  return url.toString();
}

async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const raw = await response.text();
    let data = {};
    try { data = raw ? JSON.parse(raw) : {}; }
    catch (_) { throw new Error(`A TriboPay retornou uma resposta inválida (HTTP ${response.status}).`); }
    return { response, data };
  } catch (error) {
    if (error?.name === 'AbortError') {
      const timeoutError = new Error('Tempo limite excedido ao conectar à TriboPay. Confira o painel da TriboPay antes de tentar novamente.');
      timeoutError.name = 'AbortError';
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function getProviderObjects(data) {
  const root = data && typeof data === 'object' ? data : {};
  const nested = root.data && typeof root.data === 'object' ? root.data : {};
  const transaction = nested.transaction && typeof nested.transaction === 'object'
    ? nested.transaction
    : (root.transaction && typeof root.transaction === 'object' ? root.transaction : {});
  return [transaction, nested, root];
}

function firstValue(objects, paths) {
  for (const object of objects) {
    for (const path of paths) {
      let value = object;
      for (const key of path.split('.')) value = value?.[key];
      if (value !== undefined && value !== null && value !== '') return value;
    }
  }
  return undefined;
}

function providerMessage(data, fallback) {
  const value = firstValue(getProviderObjects(data), [
    'message', 'error.message', 'errors.0.message', 'detail', 'error_description', 'error'
  ]);
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 300) : fallback;
}

function requiredTriboPayConfig() {
  const apiToken = process.env.TRIBOPAY_API_TOKEN;
  // Preferir produto/oferta exclusivos para pagamentos avulsos; manter fallback para a configuração já existente.
  const offerHash = process.env.TRIBOPAY_MANUAL_OFFER_HASH || process.env.TRIBOPAY_OFFER_HASH;
  const productHash = process.env.TRIBOPAY_MANUAL_PRODUCT_HASH || process.env.TRIBOPAY_PRODUCT_HASH;
  const missing = [];
  if (!apiToken) missing.push('TRIBOPAY_API_TOKEN');
  if (!offerHash) missing.push('TRIBOPAY_MANUAL_OFFER_HASH (ou TRIBOPAY_OFFER_HASH)');
  if (!productHash) missing.push('TRIBOPAY_MANUAL_PRODUCT_HASH (ou TRIBOPAY_PRODUCT_HASH)');
  return { apiToken, offerHash, productHash, missing };
}

async function createPix(event) {
  if (event.httpMethod !== 'POST') return jsonResponse(405, { error: 'Método não permitido.' });
  if (!allowRequest(event)) return jsonResponse(429, { error: 'Muitas tentativas em pouco tempo. Aguarde alguns minutos e tente novamente.' });

  const config = requiredTriboPayConfig();
  if (config.missing.length) {
    return jsonResponse(500, { error: `Faltam variáveis no Netlify: ${config.missing.join(', ')}.` });
  }

  let body;
  try { body = readBody(event); }
  catch (_) { return jsonResponse(400, { error: 'Dados do pagamento inválidos.' }); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return jsonResponse(400, { error: 'Envie um valor para gerar a cobrança.' });
  }

  const amountCents = parseAmountToCents(body.amount);
  if (!amountCents) return jsonResponse(400, { error: 'Informe um valor válido. Exemplo: 125,90.' });
  if (amountCents < MIN_AMOUNT_CENTS || amountCents > MAX_AMOUNT_CENTS) {
    return jsonResponse(400, {
      error: `O valor deve ficar entre R$ ${(MIN_AMOUNT_CENTS / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2 })} e R$ ${(MAX_AMOUNT_CENTS / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}.`
    });
  }

  const description = cleanText(body.description, 80) || 'Pagamento avulso';
  const reference = `AVULSO-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;

  // Importante: customer foi deliberadamente omitido. Nenhum dado pessoal é solicitado/enviado pelo site.
  const payload = {
    amount: amountCents,
    offer_hash: config.offerHash,
    payment_method: 'pix',
    cart: [{
      product_hash: config.productHash,
      title: description,
      price: amountCents,
      quantity: 1,
      operation_type: 1,
      tangible: false
    }],
    reference
  };
  if (process.env.TRIBOPAY_POSTBACK_URL) payload.postback_url = process.env.TRIBOPAY_POSTBACK_URL;

  try {
    const { response, data } = await fetchJson(makeApiUrl('/transactions', config.apiToken), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const message = providerMessage(data, `A TriboPay recusou a cobrança (HTTP ${response.status}).`);
      console.error('[PIX avulso] TriboPay rejeitou a criação:', {
        httpStatus: response.status,
        responseKeys: data && typeof data === 'object' ? Object.keys(data) : [],
        reference
      });
      const customerRequired = /customer|cliente|pagador|document|cpf|email|phone|telefone|nome/i.test(message);
      return jsonResponse(502, {
        error: customerRequired
          ? 'A TriboPay recusou a cobrança sem dados do pagador. A API da sua conta parece exigir cadastro do cliente. Não enviamos dados fictícios. Será necessário confirmar com o suporte da TriboPay se existe uma modalidade de cobrança PIX sem identificação.'
          : message,
        provider_message: message,
        reference
      });
    }

    const objects = getProviderObjects(data);
    const transactionHash = String(firstValue(objects, [
      'hash', 'transaction_hash', 'transactionHash', 'transaction.hash', 'id'
    ]) ?? '').trim();
    const qrCode = String(firstValue(objects, [
      'pix.pix_qr_code', 'pix.qr_code', 'pix.pix_code', 'pix.copy_paste',
      'pix.payload', 'pix_qr_code', 'qr_code', 'pix_code'
    ]) ?? '').trim();
    let qrCodeBase64 = String(firstValue(objects, [
      'pix.qr_code_base64', 'pix.pix_qr_code_base64', 'qr_code_base64', 'qr_code_image'
    ]) ?? '').trim();
    if (qrCodeBase64 && !qrCodeBase64.startsWith('data:image/')) qrCodeBase64 = `data:image/png;base64,${qrCodeBase64}`;
    const expiresAt = String(firstValue(objects, [
      'pix.expiration_date', 'pix.expires_at', 'expiration_date', 'expires_at'
    ]) ?? '');

    if (!transactionHash || !qrCode) {
      console.error('[PIX avulso] Resposta sem hash ou QR Code:', {
        httpStatus: response.status,
        responseKeys: data && typeof data === 'object' ? Object.keys(data) : [],
        transactionHashPresent: Boolean(transactionHash),
        qrCodePresent: Boolean(qrCode),
        reference
      });
      return jsonResponse(502, { error: 'A TriboPay respondeu, mas não retornou o identificador e o código PIX. Confira o painel antes de tentar novamente.', reference });
    }

    console.log('[PIX avulso] PIX criado:', { transactionHash, amountCents, reference });
    return jsonResponse(200, {
      status: 'success',
      transaction_id: transactionHash,
      qr_code: qrCode,
      qr_code_base64: qrCodeBase64,
      expires_at: expiresAt,
      amount_cents: amountCents,
      amount_reais: amountCents / 100,
      description,
      reference
    });
  } catch (error) {
    const isTimeout = error?.name === 'AbortError';
    console.error('[PIX avulso] Erro ao criar PIX:', {
      name: error?.name || 'Error',
      message: error?.message || 'Falha desconhecida'
    });
    return jsonResponse(isTimeout ? 504 : 500, {
      error: isTimeout
        ? 'Tempo limite excedido ao conectar à TriboPay. Confira o painel antes de gerar outra cobrança.'
        : 'Não foi possível processar a cobrança. Confira os logs da função no Netlify.'
    });
  }
}

exports.handler = async event => {
  if (event.httpMethod === 'OPTIONS') return jsonResponse(204, '');
  return createPix(event);
};
