const express = require('express');
const cors = require('cors');
const path = require('path');
const QRCode = require('qrcode');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const PROVIDER = (process.env.SBP_PROVIDER || 'demo').toLowerCase();
const orders = new Map();

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname)));

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    provider: PROVIDER,
    mode: PROVIDER === 'demo' ? 'demo' : 'live-provider',
    time: new Date().toISOString()
  });
});

function buildOrderId() {
  return `SBP-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

function normalizeAmount(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function generateQrPayload(orderId, amount) {
  const text = `SBP|${orderId}|${Number(amount).toFixed(2)}|${new Date().toISOString()}`;
  return QRCode.toDataURL(text);
}

async function createSbpProviderOrder(orderData) {
  const amount = normalizeAmount(orderData.total);
  const orderId = orderData.orderId || buildOrderId();

  if (PROVIDER === 'demo') {
    const qrDataUrl = await generateQrPayload(orderId, amount);

    return {
      success: true,
      provider: 'demo',
      orderId,
      status: 'pending',
      amount,
      currency: 'RUB',
      paymentUrl: `/api/payments/sbp-demo/${orderId}`,
      qrCode: qrDataUrl,
      message: 'Demo SBP flow. Real provider credentials are required to process real payments.'
    };
  }

  if (PROVIDER === 'yookassa') {
    const shopId = process.env.YOOKASSA_SHOP_ID;
    const secretKey = process.env.YOOKASSA_SECRET_KEY;

    if (!shopId || !secretKey) {
      throw new Error('YOOKASSA_SHOP_ID and YOOKASSA_SECRET_KEY are required');
    }

    const auth = Buffer.from(`${shopId}:${secretKey}`).toString('base64');
    const body = {
      amount: { value: amount.toFixed(2), currency: 'RUB' },
      capture: true,
      confirmation: {
        type: 'redirect',
        return_url: `${process.env.APP_BASE_URL || 'http://localhost:3000'}/payment-success`
      },
      metadata: { orderId, source: 'mini-app' },
      description: `Shawarma mini app order ${orderId}`
    };

    const res = await fetch('https://api.yookassa.ru/v3/payments', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/json',
        'Idempotence-Key': orderId
      },
      body: JSON.stringify(body)
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Yookassa API error: ${res.status} ${text}`);
    }

    const data = await res.json();
    return {
      success: true,
      provider: 'yookassa',
      orderId,
      status: data.status || 'pending',
      amount,
      currency: 'RUB',
      paymentUrl: data.confirmation?.confirmation_url || null,
      providerPaymentId: data.id,
      qrCode: data.confirmation?.confirmation_url ? null : null
    };
  }

  if (PROVIDER === 'tinkoff') {
    const terminalKey = process.env.TINKOFF_TERMINAL_KEY;
    const password = process.env.TINKOFF_PASSWORD;

    if (!terminalKey || !password) {
      throw new Error('TINKOFF_TERMINAL_KEY and TINKOFF_PASSWORD are required');
    }

    const payload = {
      TerminalKey: terminalKey,
      Amount: Math.round(amount * 100),
      OrderId: orderId,
      Description: `Shawarma mini app order ${orderId}`,
      DATA: {
        orderId,
        source: 'mini-app'
      }
    };

    const token = require('crypto')
      .createHash('sha256')
      .update(`${payload.TerminalKey}${payload.Amount}${payload.OrderId}${password}`)
      .digest('hex');

    payload.Token = token;

    const res = await fetch('https://securepay.tinkoff.ru/v2/Init', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Tinkoff API error: ${res.status} ${text}`);
    }

    const data = await res.json();
    return {
      success: true,
      provider: 'tinkoff',
      orderId,
      status: data.Status || 'pending',
      amount,
      currency: 'RUB',
      paymentUrl: data.PaymentURL || null,
      providerPaymentId: data.OrderId || null
    };
  }

  throw new Error(`Unsupported SBP_PROVIDER '${PROVIDER}'. Use demo, yookassa or tinkoff.`);
}

app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/payment-success', (_req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="ru">
    <head>
      <meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <title>Оплата подтверждена</title>
      <style>
        body { font-family: Arial, sans-serif; display: grid; place-items: center; min-height: 100vh; margin: 0; background: #fff8f0; color: #1d130f; }
        .card { max-width: 420px; background: white; border-radius: 18px; padding: 24px; box-shadow: 0 14px 38px rgba(0,0,0,0.08); text-align: center; }
        h1 { margin-top: 0; }
        p { line-height: 1.5; color: #5b4a42; }
        button { background: linear-gradient(135deg, #ff9d3f, #ff7a2d); color: white; border: none; border-radius: 12px; padding: 12px 18px; font-weight: 800; cursor: pointer; }
      </style>
    </head>
    <body>
      <div class="card">
        <h1>✅ Оплата подтверждена</h1>
        <p>Спасибо! Ваш заказ успешно оплачен через СБП. Вы можете вернуться в мини-приложение.</p>
        <button onclick="window.close();">Закрыть</button>
      </div>
    </body>
    </html>
  `);
});

app.get('/api/payments/sbp-demo/:orderId', async (req, res) => {
  const order = orders.get(req.params.orderId);
  if (!order) {
    return res.status(404).json({ error: 'Order not found' });
  }

  const qrDataUrl = await generateQrPayload(order.id, order.total);

  res.send(`
    <!DOCTYPE html>
    <html lang="ru">
    <head>
      <meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <title>Оплата через СБП</title>
      <style>
        body { font-family: Arial, sans-serif; background: #fff8f0; color: #1d130f; margin: 0; display: grid; place-items: center; min-height: 100vh; }
        .card { width: min(420px, 90vw); background: white; border-radius: 22px; padding: 24px; box-shadow: 0 18px 40px rgba(0,0,0,0.08); }
        h1 { margin-top: 0; }
        .qr { width: 220px; height: 220px; margin: 18px auto; display: block; border-radius: 12px; background: white; }
        .amount { font-size: 1.5rem; font-weight: 900; }
        .meta { color: #544741; margin-bottom: 12px; }
        button { width: 100%; margin-top: 16px; border: none; border-radius: 12px; font-weight: 900; padding: 12px 16px; background: linear-gradient(135deg, #ff9d3f, #ff7a2d); color: white; }
      </style>
    </head>
    <body>
      <div class="card">
        <h1>Оплата через СБП</h1>
        <div class="meta">Заказ: ${order.id}</div>
        <div class="amount">${Number(order.total).toFixed(2)} ₽</div>
        <img class="qr" src="${qrDataUrl}" alt="QR code" />
        <p>Сканируйте QR в приложении банка / СБП. Для демо режима можно нажать кнопку ниже, чтобы имитировать успешную оплату.</p>
        <form method="POST" action="/api/payments/verify">
          <input type="hidden" name="orderId" value="${order.id}" />
          <input type="hidden" name="status" value="paid" />
          <button type="submit">Подтвердить оплату</button>
        </form>
      </div>
    </body>
    </html>
  `);
});

app.post('/api/payments/create', async (req, res) => {
  try {
    const body = req.body || {};
    const orderId = buildOrderId();
    const amount = normalizeAmount(body.total || 0);

    const payment = await createSbpProviderOrder({
      ...body,
      orderId,
      amount
    });

    const saved = {
      id: payment.orderId,
      status: payment.status || 'pending',
      amount,
      currency: 'RUB',
      provider: payment.provider,
      paymentMethod: body.paymentMethod || 'sbp',
      createdAt: new Date().toISOString(),
      items: Array.isArray(body.items) ? body.items : []
    };

    orders.set(payment.orderId, saved);

    return res.json({
      success: true,
      orderId: payment.orderId,
      provider: payment.provider,
      status: payment.status || 'pending',
      paymentUrl: payment.paymentUrl || null,
      qrCode: payment.qrCode || null,
      amount,
      currency: 'RUB',
      message: payment.message || 'SBP payment created successfully.'
    });
  } catch (error) {
    console.error('Create payment error:', error);
    return res.status(400).json({
      success: false,
      error: error.message || 'Unable to create payment'
    });
  }
});

app.post('/api/payments/verify', (req, res) => {
  const orderId = req.body.orderId || req.query.orderId || req.body.id;
  const status = req.body.status || req.query.status || 'paid';

  if (!orderId) {
    return res.status(400).json({ success: false, error: 'Order id is required' });
  }

  const order = orders.get(orderId) || { id: orderId, status: 'pending' };
  order.status = status === 'paid' ? 'paid' : order.status;
  orders.set(orderId, order);

  return res.json({
    success: true,
    orderId,
    status: order.status,
    message: 'Payment verified successfully.'
  });
});

app.listen(PORT, () => {
  console.log(`SBP backend listening on http://localhost:${PORT}`);
  console.log(`Provider: ${PROVIDER}`);
});
