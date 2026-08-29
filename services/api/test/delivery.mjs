import {
  DeliveryError,
  deliveryConfiguration,
  sendOtp,
  sendPasswordReset,
} from '../src/lib/delivery.js'

let passed = 0
let failed = 0

function check(label, condition) {
  if (condition) {
    passed++
    console.log(`PASS ${label}`)
  } else {
    failed++
    console.log(`FAIL ${label}`)
  }
}

function throws(label, callback, pattern) {
  try {
    callback()
    check(label, false)
  } catch (error) {
    check(label, pattern.test(error.message))
  }
}

const development = deliveryConfiguration({})
check('development permits local delivery echoes', !development.sms && !development.mail)
check('delivery timeout defaults to ten seconds', development.timeoutMs === 10_000)

throws(
  'production refuses missing SMS configuration',
  () => deliveryConfiguration({ NODE_ENV: 'production' }),
  /SMS_PROVIDER=twilio/,
)
throws(
  'unsupported providers are refused',
  () => deliveryConfiguration({ SMS_PROVIDER: 'mystery' }),
  /unsupported/,
)

const configured = deliveryConfiguration({
  NODE_ENV: 'production',
  SMS_PROVIDER: 'twilio',
  TWILIO_ACCOUNT_SID: 'AC-test',
  TWILIO_AUTH_TOKEN: 'twilio-secret',
  TWILIO_FROM_NUMBER: '+15550001111',
  MAIL_PROVIDER: 'resend',
  RESEND_API_KEY: 'resend-secret',
  MAIL_FROM: 'Arcvia <hello@example.com>',
  DELIVERY_TIMEOUT_MS: '2500',
})
check(
  'production resolves both selected providers',
  configured.sms?.provider === 'twilio' && configured.mail?.provider === 'resend',
)
check('custom delivery timeout is bounded and retained', configured.timeoutMs === 2500)

const calls = []
const fetchOk = async (url, init) => {
  calls.push({ url, init })
  return { ok: true, status: 200 }
}

await sendOtp('+919876543210', '123456', configured, fetchOk)
check(
  'Twilio message uses the account-scoped HTTPS endpoint',
  calls[0].url === 'https://api.twilio.com/2010-04-01/Accounts/AC-test/Messages.json',
)
check(
  'Twilio credentials use Basic auth',
  calls[0].init.headers.Authorization.startsWith('Basic '),
)
check('Twilio request carries the destination', calls[0].init.body.get('To') === '+919876543210')
check('Twilio request carries the expiring code', calls[0].init.body.get('Body').includes('123456'))

await sendPasswordReset(
  'owner@example.com',
  'https://arcvia.example/reset?t=safe',
  configured,
  fetchOk,
)
const mailBody = JSON.parse(calls[1].init.body)
check('Resend uses its HTTPS email endpoint', calls[1].url === 'https://api.resend.com/emails')
check('Resend uses Bearer auth', calls[1].init.headers.Authorization === 'Bearer resend-secret')
check(
  'reset email goes only to the requested address',
  mailBody.to.length === 1 && mailBody.to[0] === 'owner@example.com',
)
check(
  'reset email contains the one-hour link',
  mailBody.text.includes('https://arcvia.example/reset?t=safe') &&
    mailBody.text.includes('one hour'),
)

try {
  await sendOtp(
    '+919876543210',
    '123456',
    configured,
    async () => ({ ok: false, status: 429 }),
  )
  check('provider HTTP failures remain failures', false)
} catch (error) {
  check(
    'provider HTTP failures remain failures',
    error instanceof DeliveryError && error.status === 429,
  )
}

try {
  await sendPasswordReset(
    'owner@example.com',
    'https://example.com',
    configured,
    async () => {
      throw new Error('secret transport detail')
    },
  )
  check('transport failures are sanitised', false)
} catch (error) {
  check(
    'transport failures are sanitised',
    error instanceof DeliveryError && !error.message.includes('secret transport detail'),
  )
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
