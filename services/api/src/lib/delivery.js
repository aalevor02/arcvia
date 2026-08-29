const RESEND_ENDPOINT = 'https://api.resend.com/emails'

const TWILIO_ENDPOINT = 'https://api.twilio.com/2010-04-01/Accounts'

function value(env, name) {
  return String(env[name] ?? '').trim()
}

function requireValue(env, name, provider) {
  const configured = value(env, name)
  if (!configured) throw new Error(`${name} must be set when ${provider} is enabled`)
  return configured
}

function provider(env, name, supported) {
  const configured = value(env, name).toLowerCase()
  if (!configured) return null
  if (configured !== supported) {
    throw new Error(`${name}=${configured} is unsupported; Arcvia supports ${supported}`)
  }
  return configured
}

/**
 * Resolve and validate outbound delivery once at server boot.
 *
 * Production refuses a half-configured auth flow. In development both drivers
 * may be absent so OTPs and reset links can use their guarded local echo.
 */
export function deliveryConfiguration(env = process.env) {
  const production = value(env, 'NODE_ENV') === 'production'
  const smsProvider = provider(env, 'SMS_PROVIDER', 'twilio')
  const mailProvider = provider(env, 'MAIL_PROVIDER', 'resend')

  if (production && !smsProvider) {
    throw new Error('SMS_PROVIDER=twilio is required in production')
  }
  if (production && !mailProvider) {
    throw new Error('MAIL_PROVIDER=resend is required in production')
  }

  const sms = smsProvider
    ? {
        provider: smsProvider,
        accountSid: requireValue(env, 'TWILIO_ACCOUNT_SID', 'Twilio SMS'),
        authToken:
          value(env, 'TWILIO_AUTH_TOKEN') ||
          requireValue(env, 'SMS_API_KEY', 'Twilio SMS'),
        from: requireValue(env, 'TWILIO_FROM_NUMBER', 'Twilio SMS'),
      }
    : null

  const mail = mailProvider
    ? {
        provider: mailProvider,
        apiKey:
          value(env, 'RESEND_API_KEY') ||
          requireValue(env, 'MAIL_API_KEY', 'Resend mail'),
        from: requireValue(env, 'MAIL_FROM', 'Resend mail'),
      }
    : null

  const parsedTimeout = Number(value(env, 'DELIVERY_TIMEOUT_MS') || 10_000)
  if (!Number.isFinite(parsedTimeout) || parsedTimeout < 1_000 || parsedTimeout > 60_000) {
    throw new Error('DELIVERY_TIMEOUT_MS must be between 1000 and 60000')
  }

  return { production, sms, mail, timeoutMs: parsedTimeout }
}

export class DeliveryError extends Error {
  constructor(channel, providerName, status) {
    super(`${channel} delivery through ${providerName} failed${status ? ` (HTTP ${status})` : ''}`)
    this.name = 'DeliveryError'
    this.channel = channel
    this.provider = providerName
    this.status = status || 502
  }
}

async function request(url, init, { channel, providerName, timeoutMs }, fetchImpl) {
  let response
  try {
    response = await fetchImpl(url, {
      ...init,
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch {
    throw new DeliveryError(channel, providerName, 503)
  }
  if (!response.ok) throw new DeliveryError(channel, providerName, response.status)
}

export async function sendOtp(phone, code, config, fetchImpl = globalThis.fetch) {
  if (!config.sms) throw new Error('SMS delivery is not configured')
  const { accountSid, authToken, from, provider: providerName } = config.sms
  const body = new URLSearchParams({
    To: phone,
    From: from,
    Body: `Your Arcvia verification code is ${code}. It expires in 5 minutes.`,
  })
  const authorization = Buffer.from(`${accountSid}:${authToken}`).toString('base64')

  await request(
    `${TWILIO_ENDPOINT}/${encodeURIComponent(accountSid)}/Messages.json`,
    {
      method: 'POST',
      headers: {
        Authorization: `Basic ${authorization}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
    },
    { channel: 'sms', providerName, timeoutMs: config.timeoutMs },
    fetchImpl,
  )
}

export async function sendPasswordReset(
  email,
  resetUrl,
  config,
  fetchImpl = globalThis.fetch,
) {
  if (!config.mail) throw new Error('Mail delivery is not configured')
  const { apiKey, from, provider: providerName } = config.mail

  await request(
    RESEND_ENDPOINT,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from,
        to: [email],
        subject: 'Reset your Arcvia password',
        text:
          `Use this link to reset your Arcvia password:\n\n${resetUrl}\n\n` +
          'This link expires in one hour. If you did not request it, ignore this email.',
      }),
    },
    { channel: 'mail', providerName, timeoutMs: config.timeoutMs },
    fetchImpl,
  )
}
