import { SignJWT } from 'jose'
const secret = new TextEncoder().encode(process.env.AUTH_SECRET)
const t = await new SignJWT({ role: 'manager', email: 'm@x.com', name: 'M', sv: 0 })
  .setProtectedHeader({ alg: 'HS256' })
  .setSubject('00000000-0000-0000-0000-000000000001')
  .setIssuedAt()
  .setExpirationTime('7d')
  .sign(secret)
console.log(t)
