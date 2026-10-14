import { randomUUID } from 'node:crypto';
import { AppError } from '../helpers/errors.js';

function httpsUrl(value, field) {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && !url.username && !url.password) return url;
  } catch { /* Do not include the URL in the error. */ }
  throw new AppError(502, 'BREEZE_INVALID_URL', `${field} must be a valid HTTPS URL`);
}

// Create a Breeze checkout without pulling in the other app's database models.
// Pass env and fetchImpl when testing; otherwise use the defaults.
export function createBreezePaymentService({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  async function createCheckout({ userId, currency = 'USD', amount, billingEmail } = {}) {
    if (typeof userId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/.test(userId)) {
      throw new AppError(400, 'INVALID_INPUT', 'userId must be a valid identifier of 1-100 characters');
    }
    // Breeze checkout uses USD, and the amount is passed in cents.
    if (currency !== 'USD') throw new AppError(400, 'INVALID_CURRENCY', 'Breeze checkout requires USD');
    if (!Number.isSafeInteger(amount) || amount <= 0) {
      throw new AppError(400, 'INVALID_AMOUNT', 'Amount must be a positive safe integer in cents');
    }
    if (typeof billingEmail !== 'string' || billingEmail.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(billingEmail)) {
      throw new AppError(400, 'INVALID_INPUT', 'A valid billingEmail is required');
    }
    if (!env.BREEZE_API_KEY || !env.BREEZE_BASE_URL || !env.FRONTEND_REDIRECT_URL || !env.BREEZE_CROSS_DOMAIN) {
      throw new AppError(500, 'BREEZE_NOT_CONFIGURED', 'Breeze checkout configuration is incomplete');
    }
    const baseUrl = httpsUrl(env.BREEZE_BASE_URL, 'BREEZE_BASE_URL');
    const frontendUrl = httpsUrl(env.FRONTEND_REDIRECT_URL, 'FRONTEND_REDIRECT_URL');
    // Keep this reference with the payment ID so we can match the checkout later.
    // Do not split it to get the user ID, since user IDs can contain hyphens.
    const clientReferenceId = `deposit-${userId}-${randomUUID()}`;
    const payload = {
      lineItems: [{
        clientProductId: `Deposit-${userId}`,
        displayName: 'Wallet Deposit',
        amount,
        currency,
        description: `Wallet deposit for UserID: ${userId}`,
        quantity: 1,
      }],
      billingEmail,
      clientReferenceId,
      successReturnUrl: `${frontendUrl.toString().replace(/\/$/, '')}/deposit-success`,
      failReturnUrl: `${frontendUrl.toString().replace(/\/$/, '')}/deposit-failed`,
    };

    let response;
    let data;
    try {
      response = await fetchImpl(`${baseUrl.toString().replace(/\/$/, '')}/v1/payment_pages`, {
        method: 'POST',
        // Do not follow redirects with the API key in the request.
        redirect: 'error',
        signal: AbortSignal.timeout(20000),
        headers: {
          Authorization: `Basic ${Buffer.from(`${env.BREEZE_API_KEY}:`).toString('base64')}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(payload),
      });
      if (!response.ok) throw new AppError(502, 'BREEZE_API_ERROR', 'Breeze could not create a checkout page');
      data = await response.json();
    } catch (error) {
      if (error instanceof AppError) throw error;
      // Do not retry here. Breeze may have created the page before the timeout.
      throw new AppError(502, 'BREEZE_REQUEST_FAILED', 'Breeze checkout request failed or returned invalid JSON');
    }

    const page = data?.data;
    const checkoutUrl = httpsUrl(page?.url, 'Breeze checkout URL');
    if (checkoutUrl.hostname !== 'pay.breeze.cash' || checkoutUrl.port) {
      throw new AppError(502, 'BREEZE_INVALID_URL', 'Breeze returned an unexpected checkout host');
    }
    if (typeof page.id !== 'string' || !page.id.trim()) {
      throw new AppError(502, 'BREEZE_INVALID_RESPONSE', 'Breeze did not return a payment page ID');
    }
    checkoutUrl.searchParams.set('locked_payment_methods', 'apple_pay,google_pay,card');
    checkoutUrl.searchParams.set('cross_domain_name', env.BREEZE_CROSS_DOMAIN);
    return {
      code: 200,
      message: 'Breeze checkout page created successfully',
      data: { link: checkoutUrl.toString(), paymentPageId: page.id, clientReferenceId, status: page.status },
    };
  }

  return { createCheckout };
}

export const createBreezeCheckout = (input) => createBreezePaymentService().createCheckout(input);
